import { randomUUID } from "node:crypto";
import { Clock, Effect, Either } from "effect";
import { LocalOperationFailure, runLocalOperation } from "../execution/local-operation.js";
import { MintFailure, type LiveTestHost } from "../mint/contracts.js";
import {
  runLiveTestCase,
  type LiveTestCaseRun,
  type LiveTestOutcome,
} from "../mint/live-tests.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintState } from "./mint-state.js";
import { mintError } from "./errors.js";

/** How long one case may run. */
const caseTimeoutMs = 60_000;
const authoredSource = /^(?:src|explore|test|scratch)\//u;

/** What one local run of a case's input showed. Outputs stay in memory. */
const outcomeOf = (
  executed: Either.Either<{ readonly output: unknown }, unknown>,
): LiveTestOutcome => {
  if (Either.isRight(executed)) return { status: "completed", output: executed.right.output };
  const failure = executed.left;
  // The runner lost the child or could not start it: the host, not the tool, failed.
  if (!(failure instanceof LocalOperationFailure) || !failure.reported)
    return { status: "inconclusive", reason: "host" };
  if (failure.code === "Unavailable" || failure.code === "NoResponse")
    return { status: "inconclusive", reason: "asked" };
  if (failure.tag === "InvalidInput" || failure.code === "InvalidInput")
    return {
      status: "invalid_input",
      message: failure.message,
      ...(failure.refusal?.field === undefined ? {} : { field: failure.refusal.field }),
      ...(failure.refusal?.available === undefined
        ? {}
        : { available: failure.refusal.available }),
    };
  return {
    status: "failed",
    errorClass: failure.tag ?? failure.code ?? "Error",
    message: failure.message,
    ...(failure.frame === undefined ? {} : { frame: failure.frame }),
  };
};

/**
 * The local host's live tests: one Guardian review of the batch, whose input lists every case's
 * input marked `agent_chosen_batch`, then each case in turn on the build's own browser, its page
 * reset like any live test's first. It has one browser, so it runs one case at a time. It runs no
 * anti-bot handling, which is a hosted concern, and keeps no output past the batch.
 */
export const localLiveTests = (state: MintState): LiveTestHost => {
  const { workspace, context, start } = state;
  const { browser } = state.session;
  const sourcesNow = workspace.snapshot.pipe(
    Effect.map((snapshot) => snapshot.filter(([path]) => authoredSource.test(path))),
  );
  return {
    maxWorkers: 1,
    schemas: (entrypoint) =>
      Effect.gen(function* () {
        const result = yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: yield* sourcesNow,
          input: {},
          browser,
          mode: "contract",
          target: "pureFiles",
        });
        return { input: result.schemas.input, output: result.schemas.output };
      }).pipe(Effect.mapError(mintError)),
    run: (batch) =>
      Effect.gen(function* () {
        const sources = yield* sourcesNow;
        const reviewed = yield* Effect.either(
          context.review(
            {
              entrypoint: `operation/${batch.entrypoint}`,
              sources: new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
              input: { cases: batch.cases.map(({ input }) => input) },
              currentExecution: {
                purpose: "test",
                target: "liveBrowser",
                input: "agent_chosen_batch",
              },
              startsOnFreshPage: true,
            },
            "not_sent",
          ),
        );
        if (Either.isLeft(reviewed)) {
          const failure = reviewed.left;
          if (failure instanceof MintFailure && failure.code === "ReviewDenied")
            return {
              status: "review_denied" as const,
              ...(failure.review?.reviewId === undefined
                ? {}
                : { reviewId: failure.review.reviewId }),
              rationale: failure.review?.rationale ?? "Guardian denied the batch.",
            };
          return yield* Effect.fail(failure);
        }
        const domain = siteDomain(context.siteOrigin);
        const runInput = (input: Readonly<Record<string, unknown>>) =>
          Effect.gen(function* () {
            const reset = yield* Effect.either(
              start.before({ purpose: "test", target: "liveBrowser" }),
            );
            if (Either.isLeft(reset)) return { status: "inconclusive", reason: "host" } as const;
            const executed = yield* Effect.either(
              runLocalOperation({
                workspace,
                entrypoint: batch.entrypoint,
                sources,
                input,
                browser,
                siteOrigin: context.siteOrigin,
                ...(domain === undefined ? {} : { siteDomain: domain }),
                timeoutMs: caseTimeoutMs,
                mode: "run",
                target: "browser",
                dispatchAtFirstCall: true,
                // A test asks nobody: a case whose script asks a question is not judged.
                ask: () => Effect.fail(new InputRequestFailure({ code: "Unavailable" })),
                signIn: state.sessionSignIn.hook(() => undefined),
              }),
            );
            return outcomeOf(executed);
          });
        const cases: LiveTestCaseRun[] = [];
        for (const testCase of batch.cases) {
          const now = yield* Clock.currentTimeMillis;
          if (now + caseTimeoutMs > batch.deadlineAt) {
            cases.push({
              id: testCase.id,
              outcome: { status: "inconclusive", reason: "deadline" },
              durationMs: 0,
            });
            continue;
          }
          cases.push({ ...(yield* runLiveTestCase(testCase, runInput)), lane: 0 });
        }
        // One history entry for the batch, which never counts toward a signed-in read's tests.
        yield* context.recorded(
          { purpose: "test", target: "liveBrowser", input: "agent_chosen_batch" },
          Effect.succeed({
            executionId: randomUUID(),
            status: "completed" as const,
            effect: "possible" as const,
            observations: { liveTestCases: cases.length },
          }),
        );
        return {
          status: "ran" as const,
          reviewId: reviewed.right.reviewId,
          cases,
          lanes: 1,
        };
      }).pipe(Effect.mapError(mintError)),
  };
};
