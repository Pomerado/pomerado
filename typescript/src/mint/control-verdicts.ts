import type { ControlCaseCut, ControlCheckPlan } from "./control-cases.js";

/**
 * Control checks, the verdicts: what each case's run means, levels O1 to O3.
 * - O1 contract: the output decoded (the runner's own check) and no required field is null.
 * - O2 refusal shape: an input refusal naming the field and the page's choices is
 *   `refused_with_choices`, and the host's rerun with the first choice must pass.
 * - O3 differential, in memory only: an inert control (every value of a field returns the base
 *   case's output while the base returned two or more items), a regression (passed on the
 *   baseline, fails on the candidate) and a null regression (a field non-null on the baseline is
 *   null in the same case).
 * Pure: outputs are compared here and never kept; a result holds the key, the verdict, the error
 * class, the failing frame and the output fields that were non-null.
 */

export type ControlVerdict = "pass" | "empty" | "refused_with_choices" | "fail" | "inconclusive";

/** Why a case could not say whether the control works; never a block. */
export type ControlInconclusiveReason =
  /** The site showed a challenge the check could not clear. */
  | "challenge"
  /** A browser, proxy or model provider failed. */
  | "provider"
  /** The host failed, or could not run the case. */
  | "host"
  /** Guardian did not allow the plan. */
  | "review_denied"
  /** The check run's time ran out before the case. */
  | "deadline"
  /** A refusal without the page's choices, where the case needs them. */
  | "no_choices"
  /** Paging: page 1 returned no cursor. */
  | "no_next_page";

/** One run of a case's input, as a host runner observed it. Outputs stay in memory. */
export type ControlRunOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  /** The tool refused the input; `field` and `available` when it named the page's choices. */
  | {
      readonly status: "invalid_input";
      readonly field?: string;
      readonly available?: readonly unknown[];
    }
  | {
      readonly status: "failed";
      /** The error's class or tag, such as `TimeoutError` or `InvalidOutput`. */
      readonly errorClass: string;
      /** The tool's source frame that failed, such as `src/tool.mjs:88`, when known. */
      readonly failingFrame?: string;
    }
  | { readonly status: "inconclusive"; readonly reason: ControlInconclusiveReason };

/** One case as the host ran it: its first run, and a follow-up run when the case had one. */
export interface ControlCaseRun {
  readonly key: string;
  readonly outcome: ControlRunOutcome;
  /** The next page (paging), or the rerun with the first offered choice (O2). */
  readonly followUp?: ControlRunOutcome;
  readonly durationMs?: number;
}

/** A case's stored result: no input, output or page content. */
export interface ControlCaseResult {
  readonly key: string;
  readonly fields: readonly string[];
  readonly verdict: ControlVerdict;
  readonly errorClass?: string;
  readonly failingFrame?: string;
  readonly inconclusive?: ControlInconclusiveReason;
  /** Output field paths that were non-null, such as `items[].price`, for null regressions. */
  readonly nonNullFields?: readonly string[];
  readonly durationMs?: number;
}

/** What a host's `runControlCases` returns. */
export interface ControlCheckRun {
  readonly cases: readonly ControlCaseRun[];
  /**
   * The published revision's results for the same plan, when the host checked one (a repair).
   * Absent at a mint, which has no baseline.
   */
  readonly baseline?: readonly ControlCaseResult[];
}

/** The refusal reasons control checks add to publication. */
export const controlCheckReasons = [
  /** An input field has no `examples` to build its cases from. */
  "input_examples_missing",
  /** A case failed: a throw, a refused schema value, or a required output field null. */
  "control_broken",
  /** Every value of a field returned the base case's output. */
  "control_inert",
  /** A case that passed on the published revision fails on the candidate. */
  "control_regression",
  /** An output field non-null on the published revision is null on the candidate. */
  "output_regression",
  /** The source changed after the checks ran, so their results do not describe it. */
  "controls_stale",
] as const;
export type ControlCheckReason = (typeof controlCheckReasons)[number];

/** One finding of a check run, blocking or not. */
export interface ControlCheckFinding {
  readonly reason: Exclude<ControlCheckReason, "input_examples_missing" | "controls_stale">;
  readonly key: string;
  readonly fields: readonly string[];
  readonly verdict: ControlVerdict;
  readonly errorClass?: string;
  readonly failingFrame?: string;
  /** Whether the same case passed on the published revision; absent with no baseline. */
  readonly passedOnBaseline?: boolean;
  /** For `output_regression`, the output fields that became null. */
  readonly nulledFields?: readonly string[];
}

export interface ControlCheckEvaluation {
  /** Every case's result, in plan order. */
  readonly results: readonly ControlCaseResult[];
  /** Blocking findings, most specific first; empty when the checks allow publication. */
  readonly findings: readonly ControlCheckFinding[];
  /** The refusal reason of the first finding; undefined when nothing blocks. */
  readonly refusal?: ControlCheckFinding["reason"];
  /** Cases the budget left out. */
  readonly notChecked: readonly ControlCaseCut[];
}

export interface ControlCheckEvaluationOptions {
  /** The candidate's output JSON Schema, for O1's required non-null fields. */
  readonly outputSchema?: unknown;
}

/** The verdicts and findings for one check run of `plan`; see the module comment. */
export const evaluateControlChecks = (
  _plan: ControlCheckPlan,
  _run: ControlCheckRun,
  _options: ControlCheckEvaluationOptions = {},
): ControlCheckEvaluation => {
  throw new Error("evaluateControlChecks is not implemented yet");
};
