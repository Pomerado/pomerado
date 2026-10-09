import { randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import { LocalOperationFailure, runLocalOperation } from "../execution/local-operation.js";
import type { ControlCheckHost } from "../mint/contracts.js";
import type { ControlCheckPlan } from "../mint/control-cases.js";
import { runControlCasesInOrder } from "../mint/control-runner.js";
import type { ControlCheckRun, ControlRunOutcome } from "../mint/control-verdicts.js";
import { siteDomain } from "../runtime/same-site.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import type { MintState } from "./mint-state.js";
import { mintError } from "./errors.js";

/** The local host's control check options; see `PomeradoOptions.controlChecks`. */
export interface LocalControlCheckOptions {
  /** The most cases a check run keeps; 24 by default. */
  readonly budget?: number;
  /** The clock generated dates start from; the system clock by default. */
  readonly now?: () => Date;
}

/** How long one case may run. */
const caseTimeoutMs = 60_000;
const authoredSource = /^(?:src|explore|test|scratch)\//u;

/** What one local run of a case's input showed. Outputs stay in memory. */
const outcomeOf = (executed: Either.Either<{ readonly output: unknown }, Error>): ControlRunOutcome => {
  if (Either.isRight(executed)) return { status: "completed", output: executed.right.output };
  const failure = executed.left;
  // The runner lost the child or could not start it: the host, not the tool, failed.
  if (!(failure instanceof LocalOperationFailure) || !failure.reported)
    return { status: "inconclusive", reason: "host" };
  if (failure.tag === "InvalidInput" || failure.code === "InvalidInput")
    return { status: "invalid_input" };
  return {
    status: "failed",
    errorClass: failure.tag ?? failure.code ?? "Error",
    ...(failure.frame === undefined ? {} : { failingFrame: failure.frame }),
  };
};

/**
 * The local host's control checks: one Guardian review of the plan as a read, whose input lists
 * every case's input marked `schema_generated`, then each case in turn as a live test on a page
 * reset like any live test's, in the build's own browser and session. It runs no anti-bot
 * handling, which is a hosted concern, and keeps no result past the check run.
 */
export const localControlChecks = (
  state: MintState,
  options: LocalControlCheckOptions,
): ControlCheckHost => {
  const { workspace, context, start } = state;
  const { browser } = state.session;
  const sourcesNow = workspace.snapshot.pipe(
    Effect.map((snapshot) => snapshot.filter(([path]) => authoredSource.test(path))),
  );
  const schemas: ControlCheckHost["schemas"] = (entrypoint) =>
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
    }).pipe(Effect.mapError(mintError));
  const runControlCases = (plan: ControlCheckPlan): Effect.Effect<ControlCheckRun, Error> =>
    Effect.gen(function* () {
      const sources = yield* sourcesNow;
      const reviewed = yield* Effect.either(
        context.review(
          {
            entrypoint: `operation/${plan.entrypoint}`,
            sources: new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
            input: { cases: plan.cases.map(({ input }) => input) },
            currentExecution: { purpose: "test", target: "liveBrowser", input: "schema_generated" },
            startsOnFreshPage: true,
          },
          "not_sent",
        ),
      );
      if (Either.isLeft(reviewed))
        return {
          cases: plan.cases.map(({ key }) => ({
            key,
            outcome: { status: "inconclusive", reason: "review_denied" } as const,
          })),
        };
      const domain = siteDomain(context.siteOrigin);
      const runCase = (input: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const reset = yield* Effect.either(start.before({ purpose: "test", target: "liveBrowser" }));
          if (Either.isLeft(reset)) return { status: "inconclusive", reason: "host" } as const;
          const executed = yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint: plan.entrypoint,
              sources,
              input,
              browser,
              siteOrigin: context.siteOrigin,
              ...(domain === undefined ? {} : { siteDomain: domain }),
              timeoutMs: caseTimeoutMs,
              mode: "run",
              target: "browser",
              dispatchAtFirstCall: true,
              // A check asks nobody: a case whose script asks a question is not judged.
              ask: () => Effect.fail(new InputRequestFailure({ code: "Unavailable" })),
              signIn: state.sessionSignIn.hook(() => undefined),
            }),
          );
          if (Either.isLeft(executed) && executed.left instanceof LocalOperationFailure) {
            const { code } = executed.left;
            if (code === "Unavailable" || code === "NoResponse")
              return { status: "inconclusive", reason: "host" } as const;
          }
          return outcomeOf(executed);
        });
      const run = yield* runControlCasesInOrder(plan, runCase);
      // One history entry for the whole run, marked so it never counts as the minter's own test.
      yield* context.recorded(
        { purpose: "test", target: "liveBrowser", input: "schema_generated" },
        Effect.succeed({
          executionId: randomUUID(),
          status: "completed" as const,
          effect: "possible" as const,
          observations: { controlCases: run.cases.length },
        }),
      );
      return run;
    });
  return {
    schemas,
    runControlCases: (plan) => runControlCases(plan).pipe(Effect.mapError(mintError)),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
};
