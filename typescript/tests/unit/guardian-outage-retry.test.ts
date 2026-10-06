import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Effect, Fiber, TestClock, TestContext } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type {
  GuardianDiagnostics,
  PendingExecution,
  Reviewer,
  ReviewRetry,
} from "../../src/guardian/review.js";

afterEach(() => vi.restoreAllMocks());

const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation.ts",
  screenedIntent: "Read the public page title",
  screenedInput: "{}",
  screenedObservations: "untrusted page observations",
  accountScope: "account_a",
  allowedOrigins: ["https://example.test"],
  allowedEffects: ["read"],
};
const readSource = () =>
  Effect.succeed(
    JSON.stringify({ kind: "untrusted_source", path: pending.entrypoint, source: "export {}" }),
  );
const quickRetry: ReviewRetry = { delays: ["1 millis"], budget: "1 minute" };

/** A reviewer that fails `outages` times with `failure`, then allows after reading the source. */
const flaky = (failure: () => unknown, outages: number, retry?: ReviewRetry) => {
  let runs = 0;
  const reviewer: Reviewer = {
    run: (turn) =>
      Effect.suspend(() => {
        runs++;
        if (runs <= outages) {
          const outcome = failure();
          return outcome instanceof ReviewFailure ? Effect.fail(outcome) : Effect.succeed(outcome);
        }
        return turn
          .readSource(turn.pending.entrypoint, 0)
          .pipe(Effect.as({ outcome: "allow", rationale: "Reads the page title only." }));
      }),
    ...(retry === undefined ? {} : { retry }),
  };
  return { reviewer, runs: () => runs };
};

it.each([
  [
    "a provider outage",
    () => new ReviewFailure({ code: "Unavailable", reviewPhase: "review_computation" }),
  ],
  ["a turn limit", () => new ReviewFailure({ code: "TurnLimitExceeded" })],
  ["a required source read that failed", () => new ReviewFailure({ code: "SourceUnavailable" })],
  ["a decision that does not decode", () => ({ outcome: "maybe", rationale: "unsure" })],
] as const)(
  "reviews again after %s and returns the decision that completes",
  async (_, failure) => {
    const f = flaky(failure, 2, quickRetry);
    const reviewed = await Effect.runPromise(makeGuardian(f.reviewer).review(pending, readSource));
    expect(reviewed.decision).toMatchObject({ outcome: "allow" });
    expect(f.runs()).toBe(3);
  },
);

it("reviews a proposed question again after an outage", async () => {
  let runs = 0;
  const reviewer: Reviewer = {
    retry: quickRetry,
    run: () =>
      Effect.suspend(() =>
        runs++ === 0
          ? Effect.fail(new ReviewFailure({ code: "Unavailable" }))
          : Effect.succeed({ outcome: "allow_business", rationale: "Only the caller knows." }),
      ),
  };
  const reviewed = await Effect.runPromise(
    makeGuardian(reviewer).reviewQuestion(
      pending,
      {
        questions: [{ id: "size", type: "text", prompt: "Which size?" }],
        credentialsAvailable: false,
      },
      readSource,
    ),
  );
  expect(reviewed.decision).toMatchObject({ outcome: "allow_business" });
  expect(runs).toBe(2);
});

it.each([
  [
    "a diagnostic retention failure",
    () =>
      new ReviewFailure({
        code: "Unavailable",
        reviewPhase: "diagnostic_retention",
        diagnosticRetentionReason: "storage",
      }),
  ],
] as const)("returns %s at once, without another review", async (_, failure) => {
  const f = flaky(failure, 5, quickRetry);
  const result = await Effect.runPromise(
    Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: failure().code } });
  expect(f.runs()).toBe(1);
});

it("times each review attempt and ties the retry to the attempt that failed", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const events: {
    name: string;
    details: unknown;
    reviewId?: string;
    reviewKind?: string;
  }[] = [];
  const record: GuardianDiagnostics["emit"] = (name, details, correlation) =>
    Effect.sync(() => {
      events.push({
        name,
        // Review-scoped events wrap their details; the retry event carries them directly.
        details:
          name === "guardian.review_retried" ? details : (details as { details: unknown }).details,
        ...(correlation?.reviewId === undefined ? {} : { reviewId: correlation.reviewId }),
        ...(correlation?.reviewKind === undefined ? {} : { reviewKind: correlation.reviewKind }),
      });
    });
  const diagnostics: GuardianDiagnostics = {
    emit: record,
    retainModelTranscript: record,
    retainScreenedSource: () => Effect.void,
  };
  let reads = 0;
  const failingOnce = () =>
    Effect.suspend(() => {
      const failed = reads++ === 0;
      now += failed ? 7 : 3;
      return failed ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })) : readSource();
    });
  const f = flaky(() => undefined, 0, {
    delays: ["20 millis"],
    budget: "1 minute",
  });
  const reviewed = await Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* Effect.fork(
        makeGuardian(f.reviewer, diagnostics).review(pending, failingOnce),
      );
      yield* Effect.yieldNow();
      now += 20;
      yield* TestClock.adjust("20 millis");
      return yield* Fiber.join(review);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  type Timing = {
    attempt: number;
    startOffsetMs: number;
    endOffsetMs?: number;
    elapsedMs?: number;
  };
  const named = (name: string) => events.filter((event) => event.name === name);
  const timing = (event: { details: unknown } | undefined) =>
    (event?.details as { timing: Timing } | undefined)?.timing;
  const started = named("guardian.started");
  expect(started.map((event) => timing(event)?.attempt).sort()).toEqual([1, 2]);
  const first = started.find((event) => timing(event)?.attempt === 1);
  const second = started.find((event) => timing(event)?.attempt === 2);
  expect(first?.reviewId).not.toBe(second?.reviewId);
  expect(second?.reviewId).toBe(reviewed.reviewId);

  const sourceFailed = named("guardian.source_failed")[0]?.details as Record<string, number>;
  expect(sourceFailed).toMatchObject({
    elapsedMs: 7,
    startOffsetMs: 100,
    endOffsetMs: 107,
  });
  expect(sourceFailed["endOffsetMs"]! - sourceFailed["startOffsetMs"]!).toBe(
    sourceFailed["elapsedMs"],
  );

  const failed = named("guardian.failed")[0];
  expect(failed?.reviewId).toBe(first?.reviewId);
  const failedTiming = timing(failed);
  expect(failedTiming).toMatchObject({
    attempt: 1,
    startOffsetMs: timing(first)?.startOffsetMs,
  });
  expect(failedTiming?.endOffsetMs).toBeGreaterThanOrEqual(failedTiming!.startOffsetMs);
  expect(failedTiming?.elapsedMs).toBe(failedTiming!.endOffsetMs! - failedTiming!.startOffsetMs);

  const retried = named("guardian.review_retried")[0];
  expect(retried).toMatchObject({
    reviewId: first?.reviewId,
    reviewKind: "execution",
    details: { attempt: 1, retry: 1, waitMs: 20 },
  });
  const interval = retried?.details as {
    startOffsetMs: number;
    endOffsetMs: number;
  };
  expect(interval.endOffsetMs - interval.startOffsetMs).toBe(20);

  const completed = named("guardian.completed")[0];
  expect(completed?.reviewId).toBe(second?.reviewId);
  const completedTiming = timing(completed);
  expect(completedTiming).toMatchObject({
    attempt: 2,
    startOffsetMs: timing(second)?.startOffsetMs,
  });
  expect(completedTiming).toMatchObject({
    startOffsetMs: 127,
    endOffsetMs: 130,
    elapsedMs: 3,
  });
});

it("returns the outage once it outlasts the retry budget", async () => {
  const f = flaky(() => new ReviewFailure({ code: "Unavailable" }), 100, {
    delays: ["20 millis"],
    budget: "50 millis",
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* Effect.fork(
        Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
      );
      for (let step = 0; step < 10; step++) yield* TestClock.adjust("20 millis");
      return yield* Fiber.join(review);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  // Reviews at 0, 20 and 40 ms; waiting until 60 ms would pass the 50 ms budget.
  expect(f.runs()).toBe(3);
});

it("returns an outage at once for a reviewer with no retry", async () => {
  const f = flaky(() => new ReviewFailure({ code: "Unavailable" }), 1);
  const result = await Effect.runPromise(
    Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  expect(f.runs()).toBe(1);
});

it("reports the provider's spent quota from Guardian's own model call, without reviewing again", async () => {
  let calls = 0;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: () => {
        calls++;
        return Promise.reject(
          Object.assign(new Error("Synthetic spent quota"), {
            name: "RateLimitError",
            status: 429,
            code: "insufficient_quota",
          }),
        );
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  try {
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian({
          ...makeOpenAIReviewer("{{ tenant_policy_config }}"),
          retry: quickRetry,
        }).review(pending, readSource),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        code: "Unavailable",
        modelQuotaExhausted: true,
        failureDetail: { subCause: "model_quota_exhausted" },
      },
    });
    expect(calls).toBe(1);
  } finally {
    setDefaultModelProvider(new OpenAIProvider());
  }
});
