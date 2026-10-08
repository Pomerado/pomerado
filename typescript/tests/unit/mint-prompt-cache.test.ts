import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import { mintIdleCompactionTokens } from "../../src/mint/idle-compaction.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = (inputTokens: number, cachedTokens = 0) =>
  new Usage({
    requests: 1,
    inputTokens,
    outputTokens: 40,
    totalTokens: inputTokens + 40,
    inputTokensDetails: [{ cached_tokens: cachedTokens, cache_write_tokens: 128 }],
    outputTokensDetails: [{ reasoning_tokens: 30 }],
  });
const call = (
  name: string,
  input: object,
  inputTokens = 2_000,
  callId = name,
  context: "all_turns" | "current_turn" = "all_turns",
): ModelResponse => ({
  usage: usage(inputTokens, 1_024),
  providerData: { reasoning: { context } },
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
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
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};
const executed = {
  executionId: "execution_one",
  status: "completed" as const,
  effect: "verified" as const,
  resultRef: "protected_result",
  observations: { value: "public" },
};
const compactedItem = {
  type: "compaction" as const,
  id: "cmp_synthetic",
  encrypted_content: "synthetic-compacted-context",
};
const compacted = (): ModelResponse => ({
  usage: usage(205_000, 204_800),
  output: [compactedItem],
});

/** The Responses API's explicit compaction request ends its input with this item. */
const isCompaction = (request: ModelRequest) => {
  const input = request.input;
  const last = Array.isArray(input) ? input.at(-1) : undefined;
  return last?.type === "unknown" && last.providerData?.type === "compaction_trigger";
};
const items = (request: ModelRequest | undefined): AgentInputItem[] =>
  Array.isArray(request?.input) ? request.input : [];
const turns = (requests: readonly ModelRequest[]) => requests.filter((r) => !isCompaction(r));

const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = () => new Promise<void>((done) => setImmediate(done));

const recordingDiagnostics = () => {
  const events: { name: string; details: unknown }[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      events.push({ name, details });
    });
  const diagnostics: MintDiagnostics = { emit: record, retainModelTranscript: record };
  return { events, diagnostics };
};

it("asks for reasoning from all turns and records the effective context and token counts per call", async () => {
  const { events, diagnostics } = recordingDiagnostics();
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", example, 1_200, "execute", "current_turn")
        : call("finish_build", finish, 1_500),
    { diagnostics },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests).toHaveLength(2);
  for (const request of f.requests)
    expect(request.modelSettings.reasoning).toMatchObject({
      effort: "medium",
      context: "all_turns",
    });
  const usageEvents = events.flatMap(({ name, details }) =>
    name === "mint.model" &&
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "phase") === "model_usage"
      ? [details]
      : [],
  );
  expect(usageEvents).toEqual([
    expect.objectContaining({
      call: 1,
      purpose: "turn",
      inputTokens: 1_200,
      cachedTokens: 1_024,
      cacheWriteTokens: 128,
      reasoningTokens: 30,
      outputTokens: 40,
      reasoningContext: "current_turn",
    }),
    expect.objectContaining({
      call: 2,
      purpose: "turn",
      inputTokens: 1_500,
      reasoningContext: "all_turns",
    }),
  ]);
});

it("compacts a long history while the minter waits on an execution, without blocking a turn", async () => {
  const order: string[] = [];
  const executionStarted = deferred();
  const compactionReturned = deferred();
  // Each side waits for the other, bounded so a minter that never compacts while it waits
  // finishes the run and fails the assertions instead of hanging.
  const awaitOther = (other: Promise<void>) => Promise.race([other, settle().then(settle)]);
  const f = await fixture(
    async (request, index) => {
      if (isCompaction(request)) {
        order.push("compaction_requested");
        await awaitOther(executionStarted.promise);
        order.push("compaction_returned");
        compactionReturned.resolve();
        return compacted();
      }
      order.push(`turn_${index}`);
      return index === 0
        ? call("execute", example, mintIdleCompactionTokens + 10_000)
        : call("finish_build", finish, 30_000);
    },
    {
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              order.push("execution_started");
              executionStarted.resolve();
              await awaitOther(compactionReturned.promise);
              await settle();
              order.push("execution_finished");
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(order).toEqual([
    "turn_0",
    "compaction_requested",
    "execution_started",
    "compaction_returned",
    "execution_finished",
    "turn_2",
  ]);
  const [first, next] = turns(f.requests);
  const compaction = f.requests.find(isCompaction);
  // The compaction request is the first turn's request plus the trigger, so it reads that
  // turn's cached prefix.
  expect(items(compaction).slice(0, -1)).toEqual(items(first));
  expect(compaction?.modelSettings).toEqual(first?.modelSettings);
  // The next turn sends the compacted window, then everything after the compacted prefix.
  const sent = items(next);
  expect(sent[0]).toMatchObject(compactedItem);
  expect(JSON.stringify(sent)).not.toContain("Read public data");
  expect(sent.slice(1).map((item) => item.type)).toEqual(["function_call", "function_call_result"]);
});

it("sends the next turn uncompacted while a compaction is still running, then applies it", async () => {
  const release = deferred();
  const returned = deferred();
  let executions = 0;
  const f = await fixture(
    async (request) => {
      if (isCompaction(request)) {
        await release.promise;
        returned.resolve();
        return compacted();
      }
      const turn = turns(f.requests).length - 1;
      if (turn === 1) release.resolve();
      return turn === 0
        ? call("execute", example, mintIdleCompactionTokens + 10_000, "execute_1")
        : turn === 1
          ? call("execute", example, mintIdleCompactionTokens + 20_000, "execute_2")
          : call("finish_build", finish, 40_000);
    },
    {
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              executions++;
              if (executions === 2) {
                await Promise.race([returned.promise, settle().then(settle)]);
                await settle();
              }
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests.filter(isCompaction)).toHaveLength(1);
  const [first, second, third] = turns(f.requests);
  // The second turn did not wait for the running compaction.
  expect(items(second).slice(0, items(first).length)).toEqual(items(first));
  // The third turn replaces the first turn's input with the compacted window and keeps every
  // later exchange in order.
  const sent = items(third);
  expect(sent[0]).toMatchObject(compactedItem);
  const between = items(second).slice(items(first).length);
  expect(sent.slice(1, 1 + between.length)).toEqual(between);
  expect(
    sent.flatMap((item) => (item.type === "function_call_result" ? [item.callId] : [])),
  ).toEqual(["execute_1", "execute_2"]);
});

it("leaves a short history to the provider and never compacts it", async () => {
  const f = await fixture((_request, index) =>
    index === 0 ? call("execute", example, 50_000) : call("finish_build", finish, 52_000),
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  expect(f.requests.some(isCompaction)).toBe(false);
});
