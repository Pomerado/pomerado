/**
 * Control checks, the case generator: from a read tool's input JSON Schema (and its output
 * schema, when known) to an ordered plan of inputs that exercise each control the tool declares.
 * Pure: the clock, the budget and the priorities are passed in, and every value a case holds comes
 * from the schema itself or is a host token that names nothing. A case key names only schema
 * values or host placeholders, never a caller's value, so results can be compared across
 * revisions and kept without the inputs that produced them.
 */

/** A JSON Schema object as a tool's contract declares it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Why a case is in the plan. */
export type ControlCaseKind =
  /** Required fields at their first example, optional fields unset. */
  | "base"
  /** One field changed from the base case. */
  | "field"
  /** A declared numeric minimum or maximum, or a limit's bounds. */
  | "boundary"
  /** A paired range set inverted (minimum above maximum). */
  | "inverted_range"
  /** Dates set relative to the injected clock, in order. */
  | "dates"
  /** Page 1, then page 2 through the cursor page 1 returned. */
  | "paging"
  /** Every optional field set at once. */
  | "all_together"
  /** A search's free-text field set to a host token that matches nothing. */
  | "empty_probe"
  /** An option field set to a value the page cannot offer. */
  | "unoffered_probe";

/**
 * What the case expects:
 * - `result`: a decoded result, possibly empty; a throw fails.
 * - `empty_or_choices`: the site's own empty result, or a refusal naming the choices; a throw
 *   fails.
 * - `choices`: a refusal naming the choices, then the first choice passes. A refusal without
 *   choices is inconclusive.
 * - `refusal_or_empty`: an input refusal or an empty result; a throw fails.
 */
export type ControlCaseExpectation = "result" | "empty_or_choices" | "choices" | "refusal_or_empty";

/** A second run the host makes from the first one's output. */
export interface ControlCaseFollowUp {
  readonly kind: "next_page";
  /** The input field that takes the cursor. */
  readonly inputField: string;
  /** The output field that returns it. */
  readonly outputField: string;
}

/**
 * Highest first: 0 is the base case; 1 a field the candidate's change touched; 2 a field in a
 * caller failure's signature; 3 a field whose last result failed or was inconclusive; 4 a field
 * never verified on this revision; 5 everything else.
 */
export type ControlCasePriority = 0 | 1 | 2 | 3 | 4 | 5;

export interface ControlCase {
  /**
   * Canonical JSON of the case's changes from the base case, keys sorted, such as
   * `{"sort":"price_asc"}`; `{}` for the base case. Values are schema values or host placeholders
   * (`$empty_probe`, `$next_page`, `$today+21d`), never a caller's or a page's value.
   */
  readonly key: string;
  readonly kind: ControlCaseKind;
  /** The input fields the case varies from the base case; empty for the base case. */
  readonly fields: readonly string[];
  /** The input the host runs. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly expect: ControlCaseExpectation;
  readonly followUp?: ControlCaseFollowUp;
  readonly priority: ControlCasePriority;
}

/** A case the budget left out, as coverage lists it ("not checked (budget)"). */
export interface ControlCaseCut {
  readonly key: string;
  readonly fields: readonly string[];
}

/** The fields each priority names; a host passes what it knows and omits the rest. */
export interface ControlCasePriorities {
  /** Input fields whose code the candidate changed from the published revision (priority 1). */
  readonly changedFields?: readonly string[];
  /** Input fields in the failing caller run's signature (priority 2). */
  readonly failureFields?: readonly string[];
  /** Input fields whose last stored result was a fail or inconclusive (priority 3). */
  readonly lastFailedFields?: readonly string[];
  /** Input fields never verified on this revision (priority 4). */
  readonly unverifiedFields?: readonly string[];
}

export interface ControlCasePlanOptions {
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  /** The injected clock: dates start 21 days after it. */
  readonly now: Date;
  /** The most cases the plan keeps; fields at priority 1 or 2 are never cut. 24 by default. */
  readonly budget?: number;
  readonly priorities?: ControlCasePriorities;
  /** Fields a run found the page offers choices for, which get the unoffered-value probe. */
  readonly pageChoiceFields?: readonly string[];
  /**
   * The empty probe's token. By default one derived from the schema and the clock's day, so a
   * baseline and a candidate checked the same day run the same token.
   */
  readonly emptyProbeToken?: string;
}

export type ControlCasePlanResult =
  /** Fields with no `examples` the generator could not otherwise fill: `input_examples_missing`. */
  | { readonly status: "examples_missing"; readonly fields: readonly string[] }
  | {
      readonly status: "planned";
      readonly cases: readonly ControlCase[];
      readonly notChecked: readonly ControlCaseCut[];
    };

/** What a host's `runControlCases` runs: the plan for one entrypoint. */
export interface ControlCheckPlan {
  readonly entrypoint: string;
  readonly cases: readonly ControlCase[];
  readonly notChecked: readonly ControlCaseCut[];
}

/** The default number of cases a check run keeps. */
export const defaultControlCaseBudget = 24;
/** The sentinel the unoffered-value probe sends. */
export const unofferedValue = "__unoffered__";

/** The case plan for a schema; see the module comment and `ControlCasePlanOptions`. */
export const controlCasePlan = (_options: ControlCasePlanOptions): ControlCasePlanResult => {
  throw new Error("controlCasePlan is not implemented yet");
};
