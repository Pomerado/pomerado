import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Effect, Fiber, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer, ReviewRetry } from "../../src/guardian/review.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

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
          ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
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
