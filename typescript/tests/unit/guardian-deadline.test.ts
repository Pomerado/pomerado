import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import type { PendingExecution } from "../../src/guardian/review.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

const pending: PendingExecution = {
  invocationId: "job_deadline",
  attemptId: "attempt_deadline",
  entrypoint: "operation.mjs",
  screenedIntent: "Read the title",
  screenedInput: "{}",
  screenedObservations: "No prior execution",
  accountScope: "account_a",
  allowedOrigins: ["https://example.test"],
  allowedEffects: ["read"],
};

const source = JSON.stringify({
  kind: "untrusted_source",
  path: pending.entrypoint,
  byteOffset: 0,
  nextOffset: 18,
  hasMore: false,
  source: "export default {};",
});

afterEach(() => {
  vi.useRealTimers();
  setDefaultModelProvider(new OpenAIProvider());
});

it("stalled SDK review retains the finite configured deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("PRIVATE provider reason"));
            },
            { once: true },
          );
          entered.resolve();
        }),
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const result = Effect.runPromise(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)
      .run({
        reviewId: "review_deadline",
        pending,
        readSource: () => Effect.succeed(source),
        reportDiagnostic: () => Effect.void,
      })
      .pipe(Effect.either),
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(120_001);
  const outcome = await result;
  expect(outcome).toMatchObject({
    _tag: "Left",
    left: { code: "Unavailable", reviewPhase: "review_deadline" },
  });
  expect(aborted).toBe(true);
  expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
});
