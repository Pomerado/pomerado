import { Clock, Effect } from "effect";
import type { ControlCheckEvidence, ControlCheckHost } from "./contracts.js";
import { controlCasePlan, type ControlCheckPlan } from "./control-cases.js";
import {
  controlCheckCoverage,
  controlCheckFeedback,
  evaluateControlChecks,
  type ControlCheckFinding,
  type ControlCheckReason,
  type ControlCheckRun,
} from "./control-verdicts.js";
import { readImportClosure } from "./operation-source.js";
import { sourceDigest } from "./step-checks.js";

/**
 * The harness's control check stage at `finish_build` of a read: it reads the current source's
 * schemas from the host, plans the cases, has the host run them on the source whose digest it
 * names, and judges the run. It refuses when the schema lacks examples, when a finding blocks, or
 * when the source changed while the cases ran; otherwise it hands publication the evidence and a
 * line of coverage. A host or plan it cannot use leaves the checks inconclusive, never a block.
 */

export type ControlStageResult =
  | {
      readonly status: "refused";
      readonly reason: ControlCheckReason;
      /** What the minter reads beside the reason: fields, or findings and cuts. */
      readonly details: object;
      readonly instruction: string;
    }
  | {
      readonly status: "passed";
      readonly evidence?: ControlCheckEvidence;
      /** Appended to the publication's coverage, so its review sees what the checks found. */
      readonly coverage: string;
    };

/**
 * The digest of what `entrypoint` and the workspace modules it imports hold now, paths included:
 * the source a check run describes. Undefined when the entrypoint cannot be read.
 */
export const bundleDigestOf = (
  read: (path: string) => Promise<string | undefined>,
  entrypoint: string,
) =>
  Effect.promise(async () => {
    try {
      const files = await readImportClosure(read, entrypoint);
      return files.size === 0 ? undefined : sourceDigest(files);
    } catch {
      return undefined;
    }
  });

const inconclusiveRun = (plan: ControlCheckPlan): ControlCheckRun => ({
  cases: plan.cases.map(({ key }) => ({
    key,
    outcome: { status: "inconclusive", reason: "host" },
  })),
});

const findingDetail = (finding: ControlCheckFinding) => ({
  reason: finding.reason,
  key: finding.key,
  fields: finding.fields,
  verdict: finding.verdict,
  ...(finding.errorClass === undefined ? {} : { errorClass: finding.errorClass }),
  ...(finding.failingFrame === undefined ? {} : { failingFrame: finding.failingFrame }),
  ...(finding.passedOnBaseline === undefined ? {} : { passedOnBaseline: finding.passedOnBaseline }),
  ...(finding.nulledFields === undefined ? {} : { nulledFields: finding.nulledFields }),
});

const again = "then call finish_build again with the same executionId; the host checks the source as it is then.";
const instructions: Readonly<Record<Exclude<ControlCheckReason, "input_examples_missing" | "controls_stale">, string>> = {
  control_broken:
    "Fix the code for each failing control so it works as its schema says: open whatever hides the control first, and when the page does not offer a requested value, fail with InvalidInput naming the field. Do not drop a declared input to pass, unless the site does not offer it, and then say so in coverage;",
  control_inert:
    "The tool never applied that control: make it set the control on the page and read the results after the page applies it;",
  control_regression:
    "This change broke a control the published revision handled. Restore that behaviour, keeping the fix this build needs;",
  output_regression:
    "This change stopped returning a field the published revision returned in the same case. Read it again from the page;",
};

/** The stage; see the module comment. `read` reads a workspace file, undefined when absent. */
export const controlCheckStage = (
  host: ControlCheckHost,
  entrypoint: string,
  read: (path: string) => Promise<string | undefined>,
): Effect.Effect<ControlStageResult> =>
  Effect.gen(function* () {
    const schemas = yield* Effect.either(host.schemas(entrypoint));
    if (schemas._tag === "Left")
      return {
        status: "passed",
        coverage: "Host control checks did not run: the host could not read the tool's schemas.",
      } as const;
    const priorities =
      host.priorities === undefined
        ? {}
        : yield* host.priorities(entrypoint).pipe(Effect.orElseSucceed(() => ({})));
    const now = host.now?.() ?? new Date(yield* Clock.currentTimeMillis);
    const pageChoiceFields = host.pageChoiceFields?.();
    const planned = controlCasePlan({
      inputSchema: schemas.right.input,
      outputSchema: schemas.right.output,
      now,
      priorities,
      ...(host.budget === undefined ? {} : { budget: host.budget }),
      ...(pageChoiceFields === undefined ? {} : { pageChoiceFields }),
    });
    if (planned.status === "examples_missing")
      return {
        status: "refused",
        reason: "input_examples_missing",
        details: { controlChecks: { fields: planned.fields } },
        instruction: `Not published: the host checks each control of a read with inputs built from its input schema, and ${planned.fields.join(", ")} ${planned.fields.length === 1 ? "has" : "have"} no examples to build them from. Add public example values to each named field's schema, such as Schema.String.annotations({ examples: ["tent"] }): values anyone could enter on the site, never the caller's own. Then call finish_build again with the same executionId.`,
      } as const;
    const plan: ControlCheckPlan = {
      entrypoint,
      cases: planned.cases,
      notChecked: planned.notChecked,
    };
    const before = yield* bundleDigestOf(read, entrypoint);
    if (before === undefined)
      return {
        status: "passed",
        coverage: "Host control checks did not run: the host could not read the source.",
      } as const;
    const run = yield* host
      .runControlCases(plan, before)
      .pipe(Effect.orElseSucceed(() => inconclusiveRun(plan)));
    const after = yield* bundleDigestOf(read, entrypoint);
    if (after !== before)
      return {
        status: "refused",
        reason: "controls_stale",
        details: {},
        instruction: controlsStaleInstruction,
      } as const;
    const evaluation = evaluateControlChecks(plan, run, { outputSchema: schemas.right.output });
    if (evaluation.refusal !== undefined)
      return {
        status: "refused",
        reason: evaluation.refusal,
        details: {
          controlChecks: {
            findings: evaluation.findings.map(findingDetail),
            ...(evaluation.notChecked.length === 0 ? {} : { notChecked: evaluation.notChecked }),
          },
        },
        instruction: `Not published: the host ran control checks on the current source, with inputs built from its input schema.\n${controlCheckFeedback(evaluation)}\n${instructions[evaluation.refusal]} ${again}`,
      } as const;
    return {
      status: "passed",
      evidence: {
        bundleDigest: before,
        results: evaluation.results,
        notChecked: evaluation.notChecked,
      },
      coverage: controlCheckCoverage(evaluation),
    } as const;
  });

/** What the minter reads when the source changed after the checks ran. */
export const controlsStaleInstruction =
  "Not published: the source changed after the host's control checks ran, so their results describe other code. Call finish_build again with the same executionId; the host checks the source as it is then.";
