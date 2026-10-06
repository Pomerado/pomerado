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
const publication = {
  entrypoint: "src/tool.ts",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
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

it.each([false, true])(
  "runs a repeatable read's example again without claiming it (repeatableRead=%s)",
  async (repeatableRead) => {
    const host = countingHost();
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", example, "first_read"),
          call("execute", example, "second_read"),
          call("finish_build", {
            ...publication,
            executionId: repeatableRead ? "execution_two" : "execution_one",
          }),
        ][index] ?? prose(),
      { repeatableRead, ...host.overrides },
    );
    expect(await f.run()).toMatchObject({ build: "published" });
    expect(host.counts).toEqual(
      repeatableRead ? { executions: 2, claims: 0 } : { executions: 1, claims: 1 },
    );
    if (!repeatableRead)
      expect(resultOf(f.requests[2], "second_read")).toContain("AlreadyExecuted");
  },
);

it("refuses a write upgrade once a repeatable read has run its example", async () => {
  const host = countingHost();
  let upgrades = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "read"),
        call(
          "request_input",
          {
            writeUpgrade: true,
            questions: [
              {
                id: "effect",
                type: "choice",
                prompt: "Saving the note changes the site. Allow it?",
                options: [
                  { id: "read", label: "Read" },
                  { id: "write", label: "Change" },
                ],
              },
            ],
          },
          "upgrade",
        ),
      ][index] ?? prose(),
    {
      repeatableRead: true,
      ...host.overrides,
      upgradeToWrite: () =>
        Effect.sync(() => {
          upgrades++;
        }),
    },
    { effect: "read", siteOrigin: "https://site.invalid" },
  );
  await f.run();
  expect(resultOf(f.requests[2], "upgrade")).toContain("write_upgrade_unavailable");
  expect(upgrades).toBe(0);
  expect(host.counts.claims).toBe(0);
});
