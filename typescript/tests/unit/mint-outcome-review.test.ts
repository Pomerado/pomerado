import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import type { ExecutionEvidence, MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeOpenAIOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import type {
  MinterHistoryArchive,
  OutcomeAssessment,
  OutcomeReviewHost,
  OutcomeReviewSnapshot,
} from "../../src/mint/outcome-review-contracts.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import type { MintHarnessSnapshot } from "../../src/mint/contracts.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

// The outcome reviewer through the mint harness: the real minter and the real reviewer, each on
// a scripted model, with a scripted host standing in for Guardian review and execution.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
type Item = ModelResponse["output"][number];
const functionCall = (name: string, input: object, callId = name): Item => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const message = (text: string): Item => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const respond = (...output: Item[]): ModelResponse => ({ usage: usage(), output });
/** A minter tool call; the harness's own tools carry a declared intent. */
const minter = (name: string, input: object, callId = name) =>
  respond(functionCall(name, { ...input, intent: `Synthetic ${name} purpose` }, callId));

const step = (entrypoint: string, purpose = "act") => ({
  purpose,
  target: "liveBrowser",
  entrypoint,
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
});
const publication = (executionId: string) => ({
  entrypoint: "src/book.ts",
  executionId,
  metadata: { name: "book_table", description: "Book a table" },
  coverage: "One booking made through the session's act step.",
});

/** The reviewer's turn message, from its latest request. */
const turnOf = (request: ModelRequest) => {
  const items = Array.isArray(request.input) ? request.input : [];
  for (const item of [...items].reverse()) {
    if (!("role" in item) || item.role !== "user" || typeof item.content !== "string") continue;
    const parsed: unknown = JSON.parse(item.content);
    const turn: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "outcome_review_turn")
        : undefined;
    if (typeof turn === "object" && turn !== null)
      return turn as {
        readonly final: boolean;
        readonly unresolvedWrites: readonly { readonly executionId: string }[];
      };
  }
  throw new Error("The reviewer received no turn message");
};
/** The output of the reviewer's tool call `callId`, parsed. */
const toolOutput = (request: ModelRequest, callId: string): Record<string, unknown> => {
  const items = Array.isArray(request.input) ? request.input : [];
  const result = items.find(
    (item) => item.type === "function_call_result" && item.callId === callId,
  );
  if (result === undefined || result.type !== "function_call_result")
    throw new Error(`No result for ${callId}`);
  const output = result.output;
  const text = typeof output === "string" ? output : "text" in output ? String(output.text) : "";
  return JSON.parse(text) as Record<string, unknown>;
};

/** A scripted reviewer model: `respond` answers each request, by its index. */
const scriptedReviewer = (
  respondTo: (request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>,
) => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respondTo(request, requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { provider, requests };
};

/** The outcome review a host supplies, recording what it saves and journals. */
const reviewHost = (provider: ModelProvider, retryDelays?: OutcomeReviewHost["retryDelays"]) => {
  const recorded: OutcomeAssessment[] = [];
  const saved: OutcomeReviewSnapshot[] = [];
  const host: OutcomeReviewHost = {
    model: makeOpenAIOutcomeReviewer({ modelProvider: provider, turnTimeout: "10 seconds" }),
    save: (snapshot) =>
      Effect.sync(() => {
        saved.push(snapshot);
      }),
    recordAssessment: (assessment) =>
      Effect.sync(() => {
        recorded.push(assessment);
      }),
    ...(retryDelays === undefined ? {} : { retryDelays }),
  };
  return { host, recorded, saved };
};

/** A scripted host step that Guardian allowed as `action`, then ran with `evidence`. */
const allowedStep =
  (
    run: (entrypoint: string) => Effect.Effect<ExecutionEvidence, MintFailure>,
    action: (entrypoint: string) => "read" | "write" = () => "write",
  ): MintDependencies["reviewAndExecute"] =>
  (submitted, beforeDispatch = () => Effect.void) =>
    Effect.gen(function* () {
      const entrypoint = submitted.purpose === "command" ? "command" : submitted.entrypoint;
      const label = action(entrypoint);
      yield* beforeDispatch({ reviewId: `review_${entrypoint}`, action: label });
      const evidence = yield* run(entrypoint);
      return {
        ...evidence,
        review: {
          reviewId: `review_${entrypoint}`,
          outcome: "allow" as const,
          rationale: "Synthetic review",
          action: label,
        },
      };
    });

// Fails before the reviewer, when the lost write's result leaves no outcome review and a second
// run of the same step goes to the website again.
it("keeps a write whose result was lost unknown and never runs it again", async () => {
  const reviewer = scriptedReviewer((request, index) =>
    index === 0
      ? respond(
          functionCall("submit_assessment", {
            executionId: turnOf(request).unresolvedWrites[0]?.executionId,
            outcome: "unknown",
            explanation: "The submission's response was lost and nothing reads the booking back.",
            evidence: ["history:2"],
          }),
        )
      : respond(message("Assessed.")),
  );
  const review = reviewHost(reviewer.provider);
  let dispatched = 0;
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "first"),
        minter("execute", step("src/book.ts"), "again"),
      ][index] ?? respond(message("The booking's outcome is unknown.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.suspend(() => {
          dispatched++;
          // The booking went out, and its response never came back.
          return Effect.fail(new MintFailure({ code: "Unavailable" }));
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(dispatched).toBe(1);
  const again = JSON.stringify(f.requests[2]?.input);
  expect(again).toContain("may already have changed the site");
  expect(outcome.writes).toEqual([
    {
      write: expect.objectContaining({ status: "result_lost", entrypoint: "src/book.ts" }),
      status: "may_have_applied",
      assessment: expect.objectContaining({ outcome: "unknown", version: 1 }),
    },
  ]);
  expect(review.recorded).toMatchObject([{ outcome: "unknown" }]);
});

// Fails when the reviewer cannot see minter history from before a compaction: the request the
// minter sends after it no longer carries the confirmation.
it("finds a write's confirmation in minter history from before a compaction", async () => {
  const compacted = Promise.withResolvers<void>();
  const reviewer = scriptedReviewer(async (request, index) => {
    if (index === 0) {
      // The reviewer's first turn starts once the minter's context was compacted.
      await compacted.promise;
      return respond(
        functionCall("search_history", { query: "SYN-1042", limit: 5 }, "search"),
        functionCall("search_history", { query: "[compaction:", limit: 5 }, "compaction"),
      );
    }
    if (index === 1) {
      const found = toolOutput(request, "search") as {
        matches: readonly { offset: number }[];
      };
      return respond(
        functionCall("submit_assessment", {
          executionId: turnOf(request).unresolvedWrites[0]?.executionId,
          outcome: "done",
          explanation: "The booking step's result shows the confirmation number.",
          evidence: found.matches.map((match) => `history:${match.offset}`),
        }),
      );
    }
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const f = await fixture(
    (_request, index) => {
      if (index === 0) return minter("execute", step("src/book.ts"), "book");
      // The provider compacts the context in this turn; later requests start at its item.
      if (index === 1)
        return respond(
          { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-summary" },
          functionCall(
            "execute",
            { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
            "notes",
          ),
        );
      if (index === 2) {
        compacted.resolve();
        return minter("finish_build", publication("booking_1"));
      }
      return respond(message("Published."));
    },
    {
      reviewAndExecute: allowedStep(
        (entrypoint) =>
          Effect.succeed(
            entrypoint === "src/book.ts"
              ? {
                  executionId: "booking_1",
                  status: "completed",
                  effect: "possible",
                  resultRef: "booking_result",
                  observations: { page: "Table booked. Confirmation number SYN-1042." },
                }
              : {
                  executionId: "notes_1",
                  status: "completed",
                  effect: "not_sent",
                  observations: { notes: "none" },
                },
          ),
        (entrypoint) => (entrypoint === "src/book.ts" ? "write" : "read"),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  // The minter's request after the compaction no longer carries the confirmation.
  expect(JSON.stringify(f.requests[2]?.input)).not.toContain("SYN-1042");
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      status: "applied",
      assessment: expect.objectContaining({ outcome: "done" }),
    }),
  ]);
  // The confirmation it cites comes before the compaction in the minter's history.
  const offsets = (callId: string) =>
    (
      toolOutput(reviewer.requests[1] as ModelRequest, callId) as {
        matches: readonly { offset: number }[];
      }
    ).matches.map((match) => match.offset);
  const [compaction] = offsets("compaction");
  const cited = review.recorded[0]?.evidence.map((reference) => Number(reference.split(":")[1]));
  expect(compaction).toBeDefined();
  expect(cited?.length).toBeGreaterThan(0);
  for (const offset of cited ?? []) expect(offset).toBeLessThan(compaction ?? 0);
});

// Fails when a reviewer outage holds the build or invents an outcome for the write.
it("leaves a write unresolved through a reviewer outage, and the build publishes", async () => {
  const reviewer = scriptedReviewer(() => {
    throw new Error("Synthetic provider outage");
  });
  const review = reviewHost(reviewer.provider, ["20 millis"]);
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "book"),
        minter("finish_build", publication("booking_1")),
      ][index] ?? respond(message("Published.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.succeed({
          executionId: "booking_1",
          status: "completed",
          effect: "possible",
          confirmation: "message",
          resultRef: "booking_result",
          observations: { page: "Table booked." },
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(outcome.writes).toEqual([
    { write: expect.objectContaining({ executionId: "booking_1" }), status: "may_have_applied" },
  ]);
  expect(review.recorded).toEqual([]);
  expect(reviewer.requests.length).toBeGreaterThan(0);
  // The final turn at finish_build ran and failed too; the write stays unresolved in the
  // reviewer's saved state for a host to report.
  expect(review.saved.at(-1)).toMatchObject({ finishRequested: true, assessments: [] });
});

// Fails when the reviewer runs a turn per event, or two turns at once, instead of one turn at a
// time with the events that arrived during a turn coalesced into the next.
it("coalesces the events that arrive during a turn into the next turn", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const firstTurn = Promise.withResolvers<void>();
  const secondTurn = Promise.withResolvers<void>();
  let running = 0;
  let overlapped = false;
  const turns: (readonly unknown[])[] = [];
  const reviewer = scriptedReviewer(async (request) => {
    const turn = turnOf(request) as unknown as { readonly events: readonly unknown[] };
    running++;
    if (running > 1) overlapped = true;
    turns.push(turn.events);
    if (turns.length === 1) {
      firstStarted.resolve();
      await firstTurn.promise;
    } else secondTurn.resolve();
    running--;
    return respond(message("Waiting for a readback."));
  });
  const review = reviewHost(reviewer.provider);
  const f = await fixture(
    async (_request, index) => {
      if (index === 0) return minter("execute", step("src/add-to-cart.ts"), "cart");
      if (index === 1) {
        await firstStarted.promise;
        return minter("execute", step("src/save-draft.ts"), "draft");
      }
      if (index === 2) return minter("execute", step("src/read-cart.ts"), "read");
      if (index === 3) {
        firstTurn.resolve();
        await secondTurn.promise;
      }
      return respond(message("Stopped."));
    },
    {
      reviewAndExecute: allowedStep(
        (entrypoint) =>
          Effect.succeed({
            executionId: entrypoint.replace(/\W/gu, "_"),
            status: "completed",
            effect: "possible",
            resultRef: `${entrypoint}_result`,
            observations: { page: "Done." },
          }),
        (entrypoint) => (entrypoint === "src/read-cart.ts" ? "read" : "write"),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  await f.run();

  expect(overlapped).toBe(false);
  expect(turns.map((events) => events.length)).toEqual([1, 2]);
  expect(turns[1]).toEqual([
    expect.objectContaining({ kind: "write" }),
    expect.objectContaining({ kind: "execution", action: "read" }),
  ]);
});

// Fails when the minter's history from before a compaction lives only in the attempt's memory: a
// takeover restores the run state, which starts at the compaction, and the confirmation is gone.
it("finds a confirmation from before a compaction after a takeover", async () => {
  /** The host's durable archive, which outlives the attempt. */
  const archived: AgentInputItem[] = [];
  const historyArchive: MinterHistoryArchive = {
    append: (offset, items) =>
      Effect.sync(() => {
        archived.splice(offset, items.length, ...structuredClone(items));
      }),
    length: Effect.sync(() => archived.length),
    read: (offset, limit) =>
      Effect.sync(() => structuredClone(archived.slice(offset, offset + limit))),
  };
  /** The host's checkpoints: each saved before a model call, as a recovery store does. */
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const recoveryFactory: MintRecoveryFactory = (store) =>
    Effect.succeed({
      model: (state, counters, invoke) =>
        store
          .save({ version: 1, sdkVersion: "0.18.0", sdkState: state(), ...counters, tools: [] })
          .pipe(Effect.zipRight(invoke)),
      tool: (_call, invoke) => invoke,
    });
  const minterRequests: ModelRequest[] = [];
  const minterProvider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        minterRequests.push(request);
        const index = minterRequests.length - 1;
        if (index === 0) return minter("execute", step("src/book.ts"), "book");
        // The provider compacts the context; the next segment starts at its item.
        if (index === 1)
          return respond(
            { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-summary" },
            functionCall(
              "execute",
              { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
              "notes",
            ),
          );
        // The worker is lost after the new segment's checkpoint.
        if (index === 2) throw new Error("Synthetic worker loss");
        if (index === 3) return minter("finish_build", publication("booking_1"));
        return respond(message("Published."));
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  const minterModel = () =>
    makeOpenAIMinter(minterProvider, "medium", { segmentTurns: 2 }, { recoveryFactory });
  const reviewer = scriptedReviewer((request) => {
    const turn = turnOf(request);
    if (!turn.final) return respond(message("No assessment yet."));
    const items = Array.isArray(request.input) ? request.input : [];
    if (!items.some((item) => item.type === "function_call_result"))
      return respond(functionCall("search_history", { query: "SYN-1042", limit: 5 }, "search"));
    if (!items.some((item) => item.type === "function_call_result" && item.callId === "assess")) {
      const found = toolOutput(request, "search") as { matches: readonly { offset: number }[] };
      return respond(
        functionCall(
          "submit_assessment",
          {
            executionId: turn.unresolvedWrites[0]?.executionId,
            outcome: found.matches.length > 0 ? "done" : "unknown",
            explanation:
              found.matches.length > 0
                ? "The booking step's result shows the confirmation number."
                : "No confirmation is in the history.",
            evidence: found.matches.map((match) => `history:${match.offset}`),
          },
          "assess",
        ),
      );
    }
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const steps = allowedStep(
    (entrypoint) =>
      Effect.succeed(
        entrypoint === "src/book.ts"
          ? {
              executionId: "booking_1",
              status: "completed",
              effect: "possible",
              resultRef: "booking_result",
              observations: { page: "Table booked. Confirmation number SYN-1042." },
            }
          : {
              executionId: "notes_1",
              status: "completed",
              effect: "not_sent",
              observations: { notes: "none" },
            },
      ),
    (entrypoint) => (entrypoint === "src/book.ts" ? "write" : "read"),
  );
  const agentRecovery = {
    save: (agent: MintAgentSnapshot, harness: MintHarnessSnapshot) =>
      Effect.sync(() => {
        checkpoints.push({ agent, harness });
      }),
  };
  const first = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery,
      outcomeReview: { ...review.host, historyArchive },
    },
    { effect: "write" },
  );
  await first.run().catch(() => undefined);
  expect(minterRequests).toHaveLength(3);

  // A new worker takes over from the last checkpoint, with the reviewer's saved state.
  const checkpoint = checkpoints.at(-1);
  const reviewState = review.saved.at(-1);
  if (checkpoint === undefined || reviewState === undefined) throw new Error("No checkpoint");
  const second = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery: { ...agentRecovery, initial: checkpoint },
      outcomeReview: {
        ...review.host,
        historyArchive,
        initial: reviewState,
      },
    },
    { effect: "write" },
  );
  const outcome = await second.run();

  expect(outcome.build).toBe("published");
  // The restored run state starts at the compaction: the confirmation is not in it.
  expect(JSON.stringify(minterRequests[3]?.input)).not.toContain("SYN-1042");
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      status: "applied",
      assessment: expect.objectContaining({ outcome: "done" }),
    }),
  ]);
});
