import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ intent: `Synthetic ${name} purpose`, ...input }),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
});
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const resultOf = (request: ModelRequest | undefined, callId: string) => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  return JSON.stringify(
    input.find((item) => item.type === "function_call_result" && item.callId === callId),
  );
};
/** Execution receipts numbered in order, and how often the host was asked to claim. */
const countingHost = () => {
  const counts = { executions: 0, claims: 0 };
  const overrides: Partial<MintDependencies> = {
    claimExample: Effect.sync(() => {
      counts.claims++;
    }),
    reviewAndExecute: (_input, beforeDispatch = Effect.void) =>
      beforeDispatch.pipe(
        Effect.zipRight(
          Effect.sync(() => {
            counts.executions++;
            return {
              executionId: counts.executions === 1 ? "execution_one" : "execution_two",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: `protected_${counts.executions}`,
              observations: { value: "public" },
            };
          }),
        ),
      ),
  };
  return { counts, overrides };
};

// The shared harness tests cover a repeatable read running its example twice. This one adds
// what the host sees: one claim request, which a host that lets the read run again answers by
// claiming nothing, and the example still keeps a later update from making the build a write.
it("asks the host to claim a repeatable read's example, and still refuses a later read to write update", async () => {
  const host = countingHost();
  let reviews = 0;
  let applied = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "read"),
        call(
          "request_input",
          {
            questions: [
              {
                id: "effect",
                type: "choice",
                prompt: "Saving the note changes the site. Allow it?",
                options: [
                  { id: "save", label: "Save the note" },
                  { id: "look", label: "Only look" },
                ],
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: "Save the note instead of only reading it.",
            changes: [{ setting: "effect", effect: "write" }],
            confirmedBy: ["effect"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    {
      repeatableRead: true,
      ...host.overrides,
      askInput: () => Effect.succeed({ effect: { type: "choice", value: "save" } }),
      reviewTaskUpdate: () =>
        Effect.sync(() => {
          reviews++;
          return { outcome: "allow" as const, rationale: "Confirmed." };
        }),
      applyTaskUpdate: (application) =>
        Effect.sync(() => {
          applied++;
          return { outcome: "applied" as const, state: application.next };
        }),
    },
    { effect: "read", siteOrigin: "https://site.invalid" },
  );
  await f.run();
  expect(resultOf(f.requests[3], "update")).toContain("read_example_ran");
  expect(reviews).toBe(0);
  expect(applied).toBe(0);
  expect(host.counts.claims).toBe(1);
});

it("claims a read's example when the host does not let it run again", async () => {
  const host = countingHost();
  const f = await fixture(
    (_request, index) => [call("execute", example, "read")][index] ?? prose(),
    { repeatableRead: false, ...host.overrides },
    { effect: "read", siteOrigin: "https://site.invalid" },
  );
  await f.run();
  expect(resultOf(f.requests[1], "read")).toContain("completed");
  expect(host.counts.executions).toBe(1);
  expect(host.counts.claims).toBe(1);
});
