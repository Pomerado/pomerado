import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { makeGuardian, ReviewFailure, type PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => {
  vi.useRealTimers();
  setDefaultModelProvider(new OpenAIProvider());
});

const native = { executionEnvironment: nativeExecutionEnvironment };
const toolPath = "operation/src/tool.mjs";
const capturePath = "captures/results/dom.html";
// A multi-byte character before the quoted text, so a character index is not its byte offset.
const toolSource = [
  "// Synthetic café catalog reader",
  "export const read = async (page) => {",
  "  const price = await page.locator('.price').textContent().catch(() => null);",
  "  return { price };",
  "};",
].join("\n");
const definition = JSON.stringify(
  {
    name: "read_item",
    description: "Read one catalog item",
    outputSchema: { type: "object", properties: { price: { type: ["string", "null"] } } },
  },
  null,
  2,
);
const card = (index: number) =>
  `<li class="card"><span class="maker">Synthetic Maker ${index}</span><a>Item ${index}</a></li>`;
// About 300 KB of page capture, with one card the review asks about in the middle.
const capture = [
  "<html><body><ul>",
  ...Array.from({ length: 1500 }, () => `<li class="filler">${"x".repeat(180)}</li>`),
  card(7),
  ...Array.from({ length: 1500 }, () => `<li class="filler">${"y".repeat(180)}</li>`),
  "</ul></body></html>",
].join("\n");
const files = new Map([
  [toolPath, toolSource],
  ["publication/definition.json", definition],
  [capturePath, capture],
]);
const pending: PendingExecution = {
  invocationId: "invocation_speed",
  attemptId: "attempt_speed",
  entrypoint: toolPath,
  screenedIntent: "Read the item's price",
  screenedInput: "{}",
  screenedObservations: "Prior example completed; publication does not repeat it.",
  accountScope: "account_speed",
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: !path.startsWith("captures/"),
      current: true,
      owner: path === toolPath ? ("minter" as const) : ("host" as const),
    })),
  },
};
const sources = makeSourceInspector(
  (path) =>
    Effect.suspend(() => {
      const text = files.get(path);
      return text === undefined
        ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
        : Effect.succeed(new TextEncoder().encode(text));
    }),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, extra: Record<string, unknown> = {}, callId = `read_${path}`) => ({
  type: "function_call" as const,
  callId,
  name: "read_source",
  status: "completed" as const,
  arguments: JSON.stringify({ path, offset: 0, match: null, ...extra }),
});
const compaction: ModelResponse["output"][number] = {
  type: "compaction",
  id: "cmp_review",
  encrypted_content: "opaque-compacted-context",
};
/** Recorded model turns, each after the model's own duration on the test's clock. */
const recorded = (turns: readonly { readonly ms?: number; output: ModelResponse["output"] }[]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const turn = turns[requests.length - 1];
        if (turn === undefined) throw new Error("No recorded turn");
        if (turn.ms !== undefined) await new Promise((resolve) => setTimeout(resolve, turn.ms));
        return { usage: new Usage(), output: turn.output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
const reviewer = () =>
  makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
const deny = (quote: string) => ({
  outcome: "deny",
  reason: "source_correction",
  rationale: "A needed value is nullable.",
  findings: [
    {
      path: toolPath,
      quote,
      category: "schema_mismatch",
      explanation: "The price turns a failed read into null; read it or throw.",
      route: null,
    },
  ],
  label: null,
  action: null,
});
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The evidence supports the claims.",
  findings: null,
  label: null,
  action: null,
};
const byteRange = (text: string, quote: string) => {
  const at = text.indexOf(quote);
  const byteStart = Buffer.byteLength(text.slice(0, at));
  return { byteStart, byteEnd: byteStart + Buffer.byteLength(quote) };
};

describe("a publication finding Guardian anchors by quote", () => {
  // The second quote spans a line break the model retyped as a space.
  it.each([
    { quote: ".catch(() => null)", text: ".catch(() => null)" },
    { quote: "null);   return { price };", text: "null);\n  return { price };" },
  ])("resolves to the quoted text's UTF-8 range, with no reread: $quote", async ({ quote, text }) => {
    const requests = recorded([{ output: [read(toolPath)] }, { output: [message(deny(quote))] }]);
    const { decision } = await Effect.runPromise(
      makeGuardian(reviewer()).review(pending, sources),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      reason: "source_correction",
      findings: [{ path: toolPath, category: "schema_mismatch", ...byteRange(toolSource, text) }],
    });
    expect(requests).toHaveLength(2);
  });

  it("keeps the denial at the whole file when the quote is not in it", async () => {
    recorded([{ output: [message(deny("text the file does not hold"))] }]);
    const { decision } = await Effect.runPromise(
      makeGuardian(reviewer()).review(pending, sources),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      findings: [{ path: toolPath, byteStart: 0, byteEnd: Buffer.byteLength(toolSource) }],
    });
  });
});

describe("the publication review deadline", () => {
  // 5 s, then a 30 s turn in which the provider compacts the conversation, then the verdict turn.
  // A 230 s verdict makes 235 s of reviewing; a 240 s one makes 245 s, past the 240 s deadline.
  it.each([
    { verdictMs: 230_000, decided: { _tag: "Right", right: { decision: { outcome: "allow" } } } },
    {
      verdictMs: 240_000,
      decided: { _tag: "Left", left: { code: "Unavailable", reviewPhase: "review_deadline" } },
    },
  ])("does not count the time a compaction takes: $verdictMs ms verdict", async (case_) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    recorded([
      { ms: 5_000, output: [read(toolPath)] },
      { ms: 30_000, output: [compaction, read("publication/definition.json")] },
      { ms: case_.verdictMs, output: [message(allow)] },
    ]);
    let settled = false;
    const result = Effect.runPromise(
      Effect.either(makeGuardian(reviewer(), undefined, {}).review(pending, sources)),
    ).finally(() => {
      settled = true;
    });
    for (let elapsed = 0; elapsed < 300_000 && !settled; elapsed += 1_000)
      await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject(case_.decided);
  });
});

describe("a large capture in a publication review", () => {
  it("is queried for the text a question needs, so only the matching slices reach Guardian", async () => {
    const requests = recorded([
      { output: [read(capturePath, { match: "Synthetic Maker" })] },
      { output: [message(allow)] },
    ]);
    await Effect.runPromise(makeGuardian(reviewer()).review(pending, sources));
    const input = requests[1]?.input;
    const results = (typeof input === "string" ? [] : (input ?? [])).flatMap((item) =>
      typeof item === "object" && item.type === "function_call_result"
        ? [JSON.stringify(item.output)]
        : [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("Synthetic Maker 7");
    expect(Buffer.byteLength(results[0] ?? "")).toBeLessThan(8 * 1024);
  });
});
