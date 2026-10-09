import type { ControlCase, ControlCaseCut, ControlCheckPlan } from "./control-cases.js";

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

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** JSON with object keys sorted, so equal values have equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  ) ?? "undefined";

/** A schema with a local `$ref` resolved and a nullable union reduced to its other branch. */
const schemaAt = (schema: unknown, root: Json): Json => {
  if (!isRecord(schema)) return {};
  const reference = schema["$ref"];
  if (typeof reference === "string" && reference.startsWith("#/")) {
    const target = reference
      .slice(2)
      .split("/")
      .reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), root);
    const { $ref: _, ...siblings } = schema;
    return schemaAt({ ...schemaAt(target, root), ...siblings }, root);
  }
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    const branches = union.filter((branch) => !(isRecord(branch) && branch["type"] === "null"));
    if (branches.length === 1) return schemaAt(branches[0], root);
  }
  return schema;
};

/** How deep output paths are followed: `items[].price.amount` and no further. */
const pathDepth = 4;

/** Paths of required output fields that are null, by the output schema (O1). */
const requiredNulls = (value: unknown, schema: unknown, root: Json, path = "", depth = 0): string[] => {
  if (depth > pathDepth) return [];
  const node = schemaAt(schema, root);
  if (Array.isArray(value))
    return value.flatMap((item) => requiredNulls(item, node["items"], root, `${path}[]`, depth + 1));
  if (!isRecord(value)) return [];
  const properties = isRecord(node["properties"]) ? node["properties"] : {};
  const required = Array.isArray(node["required"]) ? node["required"] : [];
  return Object.entries(properties).flatMap(([name, child]) => {
    const at = path === "" ? name : `${path}.${name}`;
    const entry = value[name];
    if (entry === null) return required.includes(name) ? [at] : [];
    return requiredNulls(entry, child, root, at, depth + 1);
  });
};

/** Paths that hold a non-null value somewhere in the output; `items[]` once a list has items. */
const nonNullPaths = (value: unknown, path = "", depth = 0, into = new Set<string>()) => {
  if (depth > pathDepth || value === null || value === undefined) return into;
  if (path !== "") into.add(path);
  if (Array.isArray(value)) for (const item of value) nonNullPaths(item, `${path}[]`, depth + 1, into);
  else if (isRecord(value))
    for (const [name, entry] of Object.entries(value))
      nonNullPaths(entry, path === "" ? name : `${path}.${name}`, depth + 1, into);
  return into;
};

/** The output's main list: the output itself, or its first property that is a list. */
const listOf = (output: unknown): readonly unknown[] | undefined =>
  Array.isArray(output)
    ? output
    : isRecord(output)
      ? (Object.values(output).find((entry) => Array.isArray(entry)) as readonly unknown[] | undefined)
      : undefined;

type Judged = Omit<ControlCaseResult, "key" | "fields" | "durationMs">;
const failed = (errorClass: string, failingFrame?: string): Judged => ({
  verdict: "fail",
  errorClass,
  ...(failingFrame === undefined ? {} : { failingFrame }),
});
const inconclusive = (reason: ControlInconclusiveReason): Judged => ({
  verdict: "inconclusive",
  inconclusive: reason,
});

/** O1 on a completed output: a required null fails, an empty main list is `empty`. */
const judgedOutput = (output: unknown, schema: unknown): Judged => {
  const root = isRecord(schema) ? schema : {};
  const nulls = schema === undefined ? [] : requiredNulls(output, root, root);
  const nonNullFields = [...nonNullPaths(output)];
  if (nulls.length > 0) return { ...failed("RequiredOutputNull"), nonNullFields };
  return { verdict: listOf(output)?.length === 0 ? "empty" : "pass", nonNullFields };
};

/** The identity of each item in a page, to tell whether page 2 repeats page 1. */
const pageItems = (output: unknown) => (listOf(output) ?? []).map((item) => canonical(item));

/** One case's verdict from its runs, by what it expects (O1 and O2). */
const judged = (controlCase: ControlCase, run: ControlCaseRun | undefined, schema: unknown): Judged => {
  if (run === undefined) return inconclusive("host");
  const { outcome, followUp } = run;
  switch (outcome.status) {
    case "inconclusive":
      return inconclusive(outcome.reason);
    case "failed":
      return failed(outcome.errorClass, outcome.failingFrame);
    case "invalid_input": {
      if (controlCase.expect === "refusal_or_empty") return { verdict: "pass" };
      const offered = outcome.field !== undefined && (outcome.available?.length ?? 0) > 0;
      if (!offered)
        return controlCase.expect === "result" ? failed("InvalidInput") : inconclusive("no_choices");
      // O2: the rerun with the first choice the page offered must pass.
      const rerun = followUp === undefined ? inconclusive("host") : judgedFollowUp(followUp, schema);
      return rerun.verdict === "pass" || rerun.verdict === "empty"
        ? { verdict: "refused_with_choices" }
        : rerun;
    }
    case "completed": {
      const first = judgedOutput(outcome.output, schema);
      if (first.verdict === "fail" || controlCase.followUp === undefined) return first;
      // Paging: page 2 must decode and hold other items than page 1.
      if (followUp === undefined) return inconclusive("host");
      const second = judgedFollowUp(followUp, schema);
      if (second.verdict !== "pass") return second.verdict === "empty" ? first : second;
      const firstItems = new Set(pageItems(outcome.output));
      const repeated =
        followUp.status === "completed" &&
        pageItems(followUp.output).every((item) => firstItems.has(item));
      return repeated ? { ...failed("PageRepeated"), nonNullFields: first.nonNullFields ?? [] } : first;
    }
  }
};
const judgedFollowUp = (outcome: ControlRunOutcome, schema: unknown): Judged =>
  outcome.status === "completed"
    ? judgedOutput(outcome.output, schema)
    : outcome.status === "failed"
      ? failed(outcome.errorClass, outcome.failingFrame)
      : outcome.status === "inconclusive"
        ? inconclusive(outcome.reason)
        : failed("InvalidInput");

const passing = (verdict: ControlVerdict | undefined) =>
  verdict === "pass" || verdict === "empty" || verdict === "refused_with_choices";
const parentOf = (path: string) => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : path.slice(0, dot);
};
const order: Readonly<Record<ControlCheckFinding["reason"], number>> = {
  control_regression: 0,
  output_regression: 1,
  control_broken: 2,
  control_inert: 3,
};

/** The verdicts and findings for one check run of `plan`; see the module comment. */
export const evaluateControlChecks = (
  plan: ControlCheckPlan,
  run: ControlCheckRun,
  options: ControlCheckEvaluationOptions = {},
): ControlCheckEvaluation => {
  const runs = new Map(run.cases.map((entry) => [entry.key, entry]));
  const baseline =
    run.baseline === undefined ? undefined : new Map(run.baseline.map((entry) => [entry.key, entry]));
  const results = plan.cases.map((controlCase): ControlCaseResult => {
    const caseRun = runs.get(controlCase.key);
    return {
      key: controlCase.key,
      fields: controlCase.fields,
      ...judged(controlCase, caseRun, options.outputSchema),
      ...(caseRun?.durationMs === undefined ? {} : { durationMs: caseRun.durationMs }),
    };
  });
  const findings: ControlCheckFinding[] = [];
  results.forEach((result) => {
    const before = baseline?.get(result.key);
    const detail = {
      key: result.key,
      fields: result.fields,
      verdict: result.verdict,
      ...(result.errorClass === undefined ? {} : { errorClass: result.errorClass }),
      ...(result.failingFrame === undefined ? {} : { failingFrame: result.failingFrame }),
      ...(baseline === undefined ? {} : { passedOnBaseline: passing(before?.verdict) }),
    };
    // O3b: a case that passed on the baseline and fails now is a regression; one that failed
    // on both, or has no baseline, is broken.
    if (result.verdict === "fail")
      findings.push({
        reason: passing(before?.verdict) ? "control_regression" : "control_broken",
        ...detail,
      });
    // O3c: a field the baseline filled in this case is null now.
    if (before?.nonNullFields !== undefined && result.verdict === "pass") {
      const now = new Set(result.nonNullFields ?? []);
      const nulledFields = before.nonNullFields.filter((path) => {
        const parent = parentOf(path);
        return !now.has(path) && (parent === undefined || now.has(parent));
      });
      if (nulledFields.length > 0)
        findings.push({ reason: "output_regression", ...detail, nulledFields });
    }
  });
  // O3a: every value of one field returned the base case's output, and the base had 2+ items.
  const baseCase = plan.cases.find((entry) => entry.kind === "base");
  const baseRun = baseCase === undefined ? undefined : runs.get(baseCase.key);
  if (baseRun?.outcome.status === "completed" && (listOf(baseRun.outcome.output)?.length ?? 0) >= 2) {
    const baseOutput = canonical(baseRun.outcome.output);
    const byField = new Map<string, ControlCase[]>();
    for (const entry of plan.cases)
      if ((entry.kind === "field" || entry.kind === "boundary") && entry.fields.length === 1) {
        const [field] = entry.fields;
        if (field !== undefined) byField.set(field, [...(byField.get(field) ?? []), entry]);
      }
    for (const [field, cases] of byField) {
      const outputs = cases.map((entry) => runs.get(entry.key)?.outcome);
      const inert =
        cases.length >= 2 &&
        outputs.every(
          (outcome) => outcome?.status === "completed" && canonical(outcome.output) === baseOutput,
        );
      const first = cases[0];
      if (inert && first !== undefined)
        findings.push({ reason: "control_inert", key: first.key, fields: [field], verdict: "pass" });
    }
  }
  findings.sort((left, right) => order[left.reason] - order[right.reason]);
  const refusal = findings[0]?.reason;
  return {
    results,
    findings,
    ...(refusal === undefined ? {} : { refusal }),
    notChecked: plan.notChecked,
  };
};

const findingLine = (finding: ControlCheckFinding) => {
  const where = `${finding.errorClass ?? finding.verdict}${finding.failingFrame === undefined ? "" : ` at ${finding.failingFrame}`}`;
  const baseline =
    finding.passedOnBaseline === undefined
      ? ""
      : finding.passedOnBaseline
        ? "; it passed on the published revision"
        : "; it failed on the published revision too";
  switch (finding.reason) {
    case "control_inert":
      return `control inert: every value of ${finding.fields.join(", ")} returned the same output as the base case, so the tool never applied it (first case ${finding.key})`;
    case "output_regression":
      return `output regression in case ${finding.key}: ${(finding.nulledFields ?? []).join(", ")} returned a value on the published revision and is null or missing now`;
    default:
      return `control check failed: case ${finding.key} gave ${finding.verdict} (${where})${baseline}`;
  }
};

/** What the minter reads about each blocking finding: key, verdict, error class and frame. */
export const controlCheckFeedback = (evaluation: ControlCheckEvaluation): string =>
  evaluation.findings.map(findingLine).join("\n");

/** A short account of a check run for publication coverage: every case's verdict, and cuts. */
export const controlCheckCoverage = (evaluation: ControlCheckEvaluation): string =>
  [
    `Host control checks: ${evaluation.results
      .map(
        (result) =>
          `${result.key} ${result.verdict}${result.inconclusive === undefined ? "" : ` (${result.inconclusive})`}`,
      )
      .join("; ")}.`,
    ...(evaluation.notChecked.length === 0
      ? []
      : [`Not checked (budget): ${evaluation.notChecked.map(({ key }) => key).join("; ")}.`]),
  ].join(" ");
