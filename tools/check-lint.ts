import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm lint`: one type-aware oxlint pass over the repository, with the rules in `.oxlintrc.json`.
 *
 * The repository adopted the linter with findings it had not fixed yet. `tools/lint-baseline.json`
 * records, for each rule that still has findings, how many it may have. A rule may never have more
 * findings than its baseline, and a rule the baseline doesn't list may have none, so every error
 * and advisory warning a change adds fails, while the existing ones are fixed over time. The
 * check prints each finding of a rule that has no baseline. A rule below its baseline only prints
 * a notice: `--update-baseline` lowers each count to what the tree has now, and never raises one or
 * adds a rule.
 *
 * `--report` prints every finding, one per line, instead of checking them.
 *
 * The Effect rules (`effecttsgo/*`) come from @effect/tsgo, which patches the installed oxlint
 * binaries to add them. The patch is idempotent and quick, so each run applies it first.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
export const baselinePath = "tools/lint-baseline.json";
export const targets = ["typescript", "tools", "vitest.config.ts", "playwright.config.ts"];

export interface Finding {
  readonly severity: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);

/** `typescript(no-explicit-any)` as `.oxlintrc.json` names it, `typescript/no-explicit-any`. */
export const ruleName = (code: string) => code.replace(/^([\w-]+)\((.+)\)$/u, "$1/$2");

/** The findings in oxlint's JSON report. A report without a diagnostics list is a format change. */
export const findingsOf = (report: unknown): Finding[] => {
  const diagnostics = field(report, "diagnostics");
  if (!Array.isArray(diagnostics))
    throw new Error("oxlint's JSON report has no diagnostics array; update tools/check-lint.ts");
  return diagnostics.map((diagnostic: unknown) => {
    const labels = field(diagnostic, "labels");
    const span = field(Array.isArray(labels) ? labels[0] : undefined, "span");
    return {
      severity: text(field(diagnostic, "severity")),
      file: text(field(diagnostic, "filename")),
      line: count(field(span, "line")),
      column: count(field(span, "column")),
      rule: ruleName(text(field(diagnostic, "code"))),
      message: text(field(diagnostic, "message")),
    };
  });
};

/** The baseline file's counts, keyed by rule. */
export const readBaseline = (source: string): Record<string, number> => {
  const rules = field(JSON.parse(source), "rules");
  if (!isObject(rules)) throw new Error(`${baselinePath} must hold {"rules": {<rule>: <count>}}`);
  for (const [rule, allowed] of Object.entries(rules))
    if (typeof allowed !== "number" || !Number.isInteger(allowed) || allowed < 1)
      throw new Error(`${baselinePath}: ${rule} must have a positive whole count`);
  return Object.fromEntries(
    Object.entries(rules).map(([rule, allowed]): [string, number] => [rule, Number(allowed)]),
  );
};

export const countByRule = (findings: readonly Finding[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  return counts;
};

export const formatFinding = ({ file, line, column, severity, rule, message }: Finding) =>
  `${file}:${line}:${column}: ${severity} ${rule}: ${message}`;

/**
 * What fails the check (`problems`) and what only needs a lower baseline (`notices`). A finding
 * without a rule, such as a parse error, never matches a baseline entry.
 */
export const checkFindings = (
  findings: readonly Finding[],
  baseline: Readonly<Record<string, number>>,
): { problems: string[]; notices: string[] } => {
  const problems: string[] = [];
  const notices: string[] = [];
  const counts = countByRule(findings);
  for (const finding of findings)
    if (finding.rule === "" || baseline[finding.rule] === undefined)
      problems.push(formatFinding(finding));
  for (const [rule, found] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const allowed = baseline[rule];
    if (allowed !== undefined && found > allowed)
      problems.push(
        `${rule}: ${found} findings exceed the baseline of ${allowed}; ` +
          "fix the ones this change adds (`pnpm lint --report` lists them)",
      );
  }
  for (const [rule, allowed] of Object.entries(baseline)) {
    const found = counts.get(rule) ?? 0;
    if (found < allowed)
      notices.push(`${rule}: ${found} findings, under the baseline of ${allowed}`);
  }
  return { problems, notices };
};

/** The baseline lowered to `findings`: no count rises, no rule is added, and fixed rules go. */
export const loweredBaseline = (
  findings: readonly Finding[],
  baseline: Readonly<Record<string, number>>,
): Record<string, number> => {
  const counts = countByRule(findings);
  return Object.fromEntries(
    Object.entries(baseline)
      .map(([rule, allowed]): [string, number] => [rule, Math.min(allowed, counts.get(rule) ?? 0)])
      .filter(([, allowed]) => allowed > 0),
  );
};

const run = (command: string, args: readonly string[]) => {
  const result = spawnSync(join(root, "node_modules/.bin", command), args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return result;
};

const lint = (): Finding[] => {
  const patch = run("effect-tsgo", ["patch", "--no-typescript", "--oxlint"]);
  if (patch.status !== 0) {
    process.stderr.write(patch.stdout + patch.stderr);
    throw new Error(`effect-tsgo patch exited ${String(patch.status)}`);
  }
  const result = run("oxlint", ["--type-aware", "--format", "json", ...targets]);
  // Oxlint exits 1 when it reports an error, and with another code when it could not lint.
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr);
    throw new Error(`oxlint exited ${String(result.status)}`);
  }
  return findingsOf(JSON.parse(result.stdout));
};

if (import.meta.main) {
  const findings = lint();
  const path = join(root, baselinePath);
  if (process.argv.includes("--report")) {
    for (const finding of findings) console.log(formatFinding(finding));
  } else if (process.argv.includes("--update-baseline")) {
    const rules = loweredBaseline(findings, readBaseline(readFileSync(path, "utf8")));
    writeFileSync(path, `${JSON.stringify({ rules }, null, 2)}\n`);
    console.log(`Lowered ${baselinePath} to the current findings.`);
  } else {
    const { problems, notices } = checkFindings(findings, readBaseline(readFileSync(path, "utf8")));
    console.log(`oxlint: ${findings.length} findings across ${countByRule(findings).size} rules`);
    for (const notice of notices) console.log(notice);
    if (notices.length > 0)
      console.log(`Run \`pnpm lint --update-baseline\` to lower ${baselinePath}.`);
    for (const problem of problems) console.log(problem);
    if (problems.length > 0) process.exit(1);
  }
}
