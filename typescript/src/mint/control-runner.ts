import { Clock, Effect } from "effect";
import type { ControlCase, ControlCheckPlan } from "./control-cases.js";
import type { ControlCaseRun, ControlCheckRun, ControlRunOutcome } from "./control-verdicts.js";

/**
 * Runs control check cases through a host's own way of running one input, adding each case's
 * follow-up run: page 2 through the cursor page 1 returned, or, after a refusal that named the
 * page's choices, a rerun with the first choice (O2). A host that runs cases in parallel calls
 * `runControlCase` once per lane; the local host runs them in order.
 */

type Input = Readonly<Record<string, unknown>>;

/** What a case's follow-up runs, if it has one, from its first outcome. */
const followUpInput = (
  controlCase: ControlCase,
  outcome: ControlRunOutcome,
):
  | { readonly run: Input }
  | { readonly settled: ControlRunOutcome }
  | undefined => {
  const { followUp } = controlCase;
  if (followUp !== undefined) {
    if (outcome.status !== "completed") return undefined;
    const cursor =
      typeof outcome.output === "object" && outcome.output !== null
        ? (outcome.output as Readonly<Record<string, unknown>>)[followUp.outputField]
        : undefined;
    return cursor === undefined || cursor === null || cursor === ""
      ? { settled: { status: "inconclusive", reason: "no_next_page" } }
      : { run: { ...controlCase.input, [followUp.inputField]: cursor } };
  }
  if (
    outcome.status === "invalid_input" &&
    outcome.field !== undefined &&
    outcome.available !== undefined &&
    outcome.available.length > 0
  )
    return { run: { ...controlCase.input, [outcome.field]: outcome.available[0] } };
  return undefined;
};

/** Runs one case and its follow-up, if any, through `run`. */
export const runControlCase = <E, R>(
  controlCase: ControlCase,
  run: (input: Input) => Effect.Effect<ControlRunOutcome, E, R>,
): Effect.Effect<ControlCaseRun, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const outcome = yield* run(controlCase.input);
    const next = followUpInput(controlCase, outcome);
    const followUp =
      next === undefined ? undefined : "settled" in next ? next.settled : yield* run(next.run);
    const ended = yield* Clock.currentTimeMillis;
    return {
      key: controlCase.key,
      outcome,
      ...(followUp === undefined ? {} : { followUp }),
      durationMs: ended - started,
    };
  });

/** Runs every case of `plan` one at a time, in plan order. */
export const runControlCasesInOrder = <E, R>(
  plan: ControlCheckPlan,
  run: (input: Input, controlCase: ControlCase) => Effect.Effect<ControlRunOutcome, E, R>,
): Effect.Effect<ControlCheckRun, E, R> =>
  Effect.forEach(plan.cases, (controlCase) =>
    runControlCase(controlCase, (input) => run(input, controlCase)),
  ).pipe(Effect.map((cases) => ({ cases })));
