/**
 * Splits the browser tests into CI shards of about equal duration, and records each test's duration
 * for the next plan. .github/workflows/check.yml runs it.
 *
 * Playwright's own `--shard` gives each shard an equal number of tests in file order. The tests
 * differ in length by up to a hundred times, so some shards took several times as long as others.
 * This plan uses each test's duration from the latest Release run on main instead, and Playwright's
 * `--test-list` to run each shard's tests.
 *
 * - `plan` reads `playwright test --list --reporter=json` and the durations, picks the shard count
 *   that keeps each shard's share near the target, splits the tests so each shard's simulated run
 *   ends about when the others do, and writes `shard-<k>.txt` (the test list) and
 *   `shard-<k>.json` (the tests the shard must report) for each shard. It prints `shards=[1,…,N]`
 *   for the workflow's matrix. A test without a recorded duration counts as the median of its
 *   file's recorded tests, or of all of them. Without any durations, every test counts as
 *   `--default-seconds`, which splits by count as Playwright does.
 *   With `--diff`, the output of `git diff --unified=0` for a pull request, it also writes
 *   `repeat.txt`, the tests whose own lines in a spec file change, as many as fit the target when
 *   each runs three times, and prints `repeat=true` when there are any. With `--quarantine`, it
 *   fails on an entry that names a test that no longer exists.
 * - `record` reads one shard's JSON report, and with `--rerun` the report of running its failed
 *   tests once more. It writes each test's duration. Every test must pass in one of the two runs,
 *   unless the spec skips it on purpose or the quarantine list names it; a test that passed only
 *   the second time is flaky and only warns. It also fails on an error outside any test, when a
 *   test the plan gave the shard has no result, so a test the list missed can't pass unnoticed,
 *   or when a test took longer than `--budget-seconds`. One test longer than a shard's share sets
 *   the shortest time the whole run can take, so split such a test or give it a controlled clock.
 *
 * A test-list line names a file and a title path, and Playwright runs every test whose title path
 * starts with it. A file is planned whole, as one line, when its tests can't be named apart that
 * way: when a title holds the list's delimiter `›`, when one test's title path starts with another's,
 * or when the file runs tests in serial mode, whose tests must stay together.
 *
 * Usage:
 *   node tools/browser-shards.ts plan --tests <list.json> --durations <dir> --out <dir>
 *     [--target-seconds 80] [--workers 4] [--max-shards 16] [--default-seconds 3]
 *     [--quarantine <quarantine.json>] [--diff <changes.diff>] [--repeat-each 3]
 *   node tools/browser-shards.ts record --results <report.json> [--rerun <report.json>]
 *     --expected <shard-k.json> [--quarantine <quarantine.json>] --out <durations.json>
 *     [--budget-seconds 80]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const delimiter = " › ";

/** One test, by its file relative to the test directory and its title path within the file. */
export interface TestId {
  readonly file: string;
  readonly titles: readonly string[];
}

export const testKey = (test: TestId) => [test.file, ...test.titles].join(delimiter);

interface ReportSuite {
  readonly title?: unknown;
  readonly file?: unknown;
  readonly specs?: readonly ReportSpec[];
  readonly suites?: readonly ReportSuite[];
}

interface ReportSpec {
  readonly title?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly tests?: readonly {
    readonly status?: unknown;
    readonly expectedStatus?: unknown;
    readonly results?: readonly { readonly duration?: unknown }[];
  }[];
}

export interface ReportTest extends TestId {
  /** The line of the test's declaration in its file. */
  readonly line: number;
  /** The last attempt's duration in seconds, when the report has one. */
  readonly seconds: number | undefined;
  /** Playwright's outcome: `expected`, `unexpected`, `flaky` or `skipped`. */
  readonly status: string | undefined;
  /** `skipped` for a test the spec skips on purpose. */
  readonly expectedStatus: string | undefined;
}

/** Every test in a Playwright JSON report, or in the output of `--list --reporter=json`. */
export const reportTests = (report: unknown): ReportTest[] => {
  const tests: ReportTest[] = [];
  const walk = (suite: ReportSuite, titles: readonly string[]) => {
    for (const spec of suite.specs ?? []) {
      if (typeof spec.file !== "string" || typeof spec.title !== "string")
        throw new Error("A report spec has no file or title.");
      for (const test of spec.tests ?? []) {
        const duration = test.results?.at(-1)?.duration;
        tests.push({
          file: spec.file,
          titles: [...titles, spec.title],
          line: typeof spec.line === "number" ? spec.line : 0,
          seconds: typeof duration === "number" && Number.isFinite(duration) ? duration / 1000 : undefined,
          status: typeof test.status === "string" ? test.status : undefined,
          expectedStatus: typeof test.expectedStatus === "string" ? test.expectedStatus : undefined,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, String(child.title)]);
  };
  const suites = (report as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) throw new Error("The report has no suites.");
  // Each top-level suite is a file, whose title is the file name the specs already carry.
  for (const file of suites as ReportSuite[]) walk(file, []);
  return tests;
};

/** Recorded durations in seconds by test key, merged from every JSON file in `directory`. */
export const readDurations = (directory: string | undefined): Map<string, number> => {
  const durations = new Map<string, number>();
  if (directory === undefined || !existsSync(directory)) return durations;
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const [key, seconds] of Object.entries(parsed))
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) durations.set(key, seconds);
  }
  return durations;
};

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const startsWith = (titles: readonly string[], prefix: readonly string[]) =>
  prefix.length <= titles.length && prefix.every((title, index) => titles[index] === title);

/** Files whose tests a test list can't name one by one, so the plan keeps them whole. */
export const wholeFiles = (tests: readonly TestId[], serialFiles: ReadonlySet<string>): Set<string> => {
  const whole = new Set([...serialFiles].filter((file) => tests.some((test) => test.file === file)));
  const byFile = Map.groupBy(tests, (test) => test.file);
  for (const [file, fileTests] of byFile) {
    const named = fileTests.some((test) =>
      test.titles.some((title) => title.includes("›") || title !== title.trim() || title === ""),
    );
    const nested = fileTests.some((test, index) =>
      fileTests.some((other, otherIndex) => otherIndex !== index && startsWith(other.titles, test.titles)),
    );
    if (named || nested) whole.add(file);
  }
  return whole;
};

export interface PlanOptions {
  /** Seconds of test time each worker should get, which sets the shard count. */
  readonly targetSeconds: number;
  /** Playwright workers per shard. */
  readonly workers: number;
  readonly maxShards: number;
  /** Each test's estimate when no test has a recorded duration. */
  readonly defaultSeconds: number;
}

/** One test-list line, a test or a whole file, with the tests it selects. */
export interface Unit {
  readonly line: string;
  /** Keys of the tests the line selects. */
  readonly tests: string[];
  /** Each test's place in Playwright's run order, and its estimated seconds. */
  readonly runs: { readonly order: number; readonly seconds: number }[];
  seconds: number;
}

export interface Shard {
  /** Test-list lines, one per test or per whole file. */
  readonly lines: string[];
  /** Keys of every test the lines select. */
  readonly tests: string[];
  /** The shard's tests in run order, to simulate how its workers take them. */
  runs: { readonly order: number; readonly seconds: number }[];
  /** Estimated seconds until the shard's last test ends. */
  makespan: number;
}

export interface Plan {
  readonly shards: Shard[];
  /** How many tests had a recorded duration. */
  readonly known: number;
  readonly total: number;
}

/** Groups the tests into test-list units, each with its estimated seconds. */
export const planUnits = (
  tests: readonly TestId[],
  durations: ReadonlyMap<string, number>,
  serialFiles: ReadonlySet<string>,
  defaultSeconds: number,
): { units: Unit[]; known: number } => {
  const recorded = tests.flatMap((test) => {
    const seconds = durations.get(testKey(test));
    return seconds === undefined ? [] : [{ test, seconds }];
  });
  const overall = median(recorded.map(({ seconds }) => seconds)) ?? defaultSeconds;
  const fileMedians = new Map(
    [...Map.groupBy(recorded, ({ test }) => test.file)].map(([file, rows]) => [
      file,
      median(rows.map(({ seconds }) => seconds)) ?? overall,
    ]),
  );
  const whole = wholeFiles(tests, serialFiles);
  const units = new Map<string, Unit>();
  tests.forEach((test, order) => {
    const line = whole.has(test.file) ? test.file : testKey(test);
    const seconds = durations.get(testKey(test)) ?? fileMedians.get(test.file) ?? overall;
    const unit = units.get(line) ?? { line, tests: [], runs: [], seconds: 0 };
    unit.tests.push(testKey(test));
    unit.runs.push({ order, seconds });
    unit.seconds += seconds;
    units.set(line, unit);
  });
  return { units: [...units.values()], known: recorded.length };
};

/**
 * When the last of `runs` ends, as Playwright runs them: in run order, each to the first worker
 * that is free.
 */
const makespan = (runs: readonly { readonly seconds: number }[], workers: number) => {
  const free = Array.from({ length: workers }, () => 0);
  for (const run of runs) {
    let first = 0;
    for (let worker = 1; worker < workers; worker += 1) if ((free[worker] ?? 0) < (free[first] ?? 0)) first = worker;
    free[first] = (free[first] ?? 0) + run.seconds;
  }
  return Math.max(...free);
};

/**
 * Splits the tests into shards. Playwright runs a shard's tests in file order, each on the next
 * free worker, so a long test late in that order ends well after the rest. Each unit, longest
 * first, goes to the shard where the simulated end of its last test is earliest. Ties go by
 * shard number, so every run with the same inputs makes the same plan. A shard left empty, when
 * fewer shards end as early, is dropped.
 */
export const plan = (
  tests: readonly TestId[],
  durations: ReadonlyMap<string, number>,
  serialFiles: ReadonlySet<string>,
  options: PlanOptions,
): Plan => {
  if (tests.length === 0) throw new Error("There are no browser tests to plan.");
  const { units, known } = planUnits(tests, durations, serialFiles, options.defaultSeconds);
  const total = units.reduce((sum, unit) => sum + unit.seconds, 0);
  const count = Math.max(
    1,
    Math.min(options.maxShards, units.length, Math.ceil(total / (options.workers * options.targetSeconds))),
  );
  const shards: Shard[] = Array.from({ length: count }, () => ({ lines: [], tests: [], runs: [], makespan: 0 }));
  const ordered = [...units].sort((a, b) => b.seconds - a.seconds || (a.line < b.line ? -1 : 1));
  for (const unit of ordered) {
    let best: { shard: Shard; runs: Shard["runs"]; makespan: number } | undefined;
    for (const shard of shards) {
      const runs = [...shard.runs, ...unit.runs].sort((a, b) => a.order - b.order);
      const end = makespan(runs, options.workers);
      if (best === undefined || end < best.makespan) best = { shard, runs, makespan: end };
    }
    if (best === undefined) continue;
    best.shard.lines.push(unit.line);
    best.shard.tests.push(...unit.tests);
    best.shard.runs = best.runs;
    best.shard.makespan = best.makespan;
  }
  for (const shard of shards) {
    shard.lines.sort();
    shard.tests.sort();
  }
  return { shards: shards.filter((shard) => shard.tests.length > 0), known, total: tests.length };
};

/** The new-side lines that `git diff --unified=0` changes, by file. */
export const changedLines = (diff: string): Map<string, Set<number>> => {
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  // Lines left in the current hunk's body, which can start with anything, even "+++ ".
  let body = 0;
  for (const text of diff.split("\n")) {
    if (body > 0) {
      body -= 1;
      continue;
    }
    if (text.startsWith("+++ ")) {
      const path = text.slice(4);
      lines = path.startsWith("b/") ? new Set() : undefined;
      if (lines !== undefined) changed.set(path.slice(2), lines);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (hunk === null) continue;
    const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const count = hunk[3] === undefined ? 1 : Number(hunk[3]);
    body = removed + count;
    if (lines === undefined) continue;
    // A deletion has no new lines, so it touches the lines on both sides of it.
    if (count === 0) for (const line of [start, start + 1]) lines.add(line);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return changed;
};

/**
 * Keys of the tests whose own lines change. A test spans from its declaration to the next test's,
 * so a change inside its body touches it. A change above a file's first test, such as to an import
 * or a shared helper, touches every test in the file. This is an approximation: a hook or helper
 * between two tests counts as part of the test above it, and changed fixture files outside the
 * spec files touch no test.
 */
export const changedTests = (
  tests: readonly ReportTest[],
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  testDirectory: string,
): Set<string> => {
  const touched = new Set<string>();
  for (const [file, fileTests] of Map.groupBy(tests, (test) => test.file)) {
    const lines = changed.get(`${testDirectory}/${file}`);
    if (lines === undefined || lines.size === 0) continue;
    const starts = [...new Set(fileTests.map((test) => test.line))].sort((a, b) => a - b);
    const first = starts[0] ?? 0;
    const above = [...lines].some((line) => line < first);
    for (const test of fileTests) {
      const next = starts.find((start) => start > test.line) ?? Number.POSITIVE_INFINITY;
      if (above || [...lines].some((line) => line >= test.line && line < next)) touched.add(testKey(test));
    }
  }
  return touched;
};

/**
 * The units holding changed tests that fit the budget when each runs `repeatEach` times, shortest
 * first, and the ones left out.
 */
export const repeatUnits = (
  units: readonly Unit[],
  changed: ReadonlySet<string>,
  repeatEach: number,
  budgetSeconds: number,
): { repeated: Unit[]; skipped: Unit[] } => {
  const candidates = units
    .filter((unit) => unit.tests.some((test) => changed.has(test)))
    .sort((a, b) => a.seconds - b.seconds || (a.line < b.line ? -1 : 1));
  const repeated: Unit[] = [];
  const skipped: Unit[] = [];
  let seconds = 0;
  for (const unit of candidates) {
    if ((seconds + unit.seconds) * repeatEach <= budgetSeconds) {
      repeated.push(unit);
      seconds += unit.seconds;
    } else skipped.push(unit);
  }
  return { repeated, skipped };
};

/** Spec files that put a describe block in serial mode. */
const findSerialFiles = (testDirectory: string, files: ReadonlySet<string>): Set<string> =>
  new Set(
    [...files].filter((file) =>
      /describe\.serial\b|mode:\s*["']serial["']/u.test(readFileSync(join(testDirectory, file), "utf8")),
    ),
  );

const number = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number.`);
  return parsed;
};

const output = (line: string) => {
  const path = process.env["GITHUB_OUTPUT"];
  if (path) appendFileSync(path, `${line}\n`);
};

const summary = (text: string) => {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path) appendFileSync(path, `${text}\n`);
};

const runPlan = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      tests: { type: "string" },
      durations: { type: "string" },
      out: { type: "string" },
      "test-dir": { type: "string", default: "typescript/tests/browser" },
      "target-seconds": { type: "string" },
      workers: { type: "string" },
      "max-shards": { type: "string" },
      "default-seconds": { type: "string" },
      quarantine: { type: "string" },
      diff: { type: "string" },
      "repeat-each": { type: "string" },
    },
  });
  if (values.tests === undefined || values.out === undefined)
    throw new Error("plan needs --tests and --out.");
  const list = JSON.parse(readFileSync(values.tests, "utf8")) as { errors?: unknown };
  if (Array.isArray(list.errors) && list.errors.length > 0)
    throw new Error(`Listing the browser tests failed: ${JSON.stringify(list.errors).slice(0, 2000)}`);
  const tests = reportTests(list);
  const durations = readDurations(values.durations);
  const options: PlanOptions = {
    targetSeconds: number(values["target-seconds"], 80, "target-seconds"),
    workers: number(values.workers, 4, "workers"),
    maxShards: number(values["max-shards"], 16, "max-shards"),
    defaultSeconds: number(values["default-seconds"], 3, "default-seconds"),
  };
  const serialFiles = findSerialFiles(values["test-dir"], new Set(tests.map((test) => test.file)));
  const result = plan(tests, durations, serialFiles, options);
  mkdirSync(values.out, { recursive: true });
  result.shards.forEach((shard, index) => {
    writeFileSync(join(values.out ?? "", `shard-${index + 1}.txt`), `${shard.lines.join("\n")}\n`);
    writeFileSync(join(values.out ?? "", `shard-${index + 1}.json`), `${JSON.stringify(shard.tests)}\n`);
  });
  output(`shards=${JSON.stringify(result.shards.map((_, index) => index + 1))}`);
  const keys = new Set(tests.map(testKey));
  const stale = readQuarantine(values.quarantine).filter((entry) => !keys.has(entry.test));
  if (stale.length > 0)
    throw new Error(`Quarantined tests that no longer exist, to remove: ${stale.map((entry) => entry.test).join("; ")}`);
  if (values.diff !== undefined) {
    const repeatEach = number(values["repeat-each"], 3, "repeat-each");
    const { units } = planUnits(tests, durations, serialFiles, options.defaultSeconds);
    const changed = changedTests(tests, changedLines(readFileSync(values.diff, "utf8")), values["test-dir"]);
    const { repeated, skipped } = repeatUnits(units, changed, repeatEach, options.targetSeconds * options.workers);
    writeFileSync(join(values.out, "repeat.txt"), `${repeated.map((unit) => unit.line).join("\n")}\n`);
    output(`repeat=${repeated.length > 0}`);
    summary(
      [
        `Changed browser tests to repeat ${repeatEach} times: ${repeated.reduce((sum, unit) => sum + unit.tests.length, 0)}.`,
        ...skipped.map((unit) => `- not repeated, over the time budget: ${unit.line}`),
      ].join("\n"),
    );
  }
  if (result.known === 0)
    console.log("::warning::No recorded browser test durations were found, so the shards split by test count.");
  summary(
    [
      `Browser shards: ${result.shards.length}, for ${result.total} tests, ${result.known} with a recorded duration.`,
      ...result.shards.map(
        (shard, index) =>
          `- shard ${index + 1}: ${shard.tests.length} tests, ` +
          `about ${Math.round(shard.makespan)} s with ${options.workers} workers`,
      ),
    ].join("\n"),
  );
};

/** A test kept from failing CI while its owner fixes it. */
export interface QuarantineEntry {
  readonly test: string;
  /** The GitHub login of the person fixing it. */
  readonly owner: string;
  /** The public issue that tracks the fix. */
  readonly issue: string;
}

/** Reads the quarantine list, and fails on an entry without an owner or issue. */
export const readQuarantine = (path: string | undefined): QuarantineEntry[] => {
  if (path === undefined) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { tests?: unknown };
  if (!Array.isArray(parsed.tests)) throw new Error(`${path} needs a "tests" array.`);
  return parsed.tests.map((entry: unknown) => {
    const { test, owner, issue } = (entry ?? {}) as Record<string, unknown>;
    if (typeof test !== "string" || typeof owner !== "string" || owner === "" || typeof issue !== "string")
      throw new Error(`Each quarantined test in ${path} needs "test", "owner" and "issue": ${JSON.stringify(entry)}`);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/u.test(issue))
      throw new Error(`${test} needs its issue as a full GitHub issue URL, not ${issue}.`);
    return { test, owner, issue };
  });
};

export interface Verdict {
  /** Tests that failed, then passed when run again in a fresh process. */
  readonly flaky: string[];
  /** Quarantined tests that passed in neither run, which don't fail the shard. */
  readonly quarantined: QuarantineEntry[];
  /** Tests that passed in neither run and fail the shard. */
  readonly failed: string[];
  readonly problems: string[];
}

/** A report's tests, and the errors it reports outside any test, such as a worker's. */
export interface Report {
  readonly tests: readonly ReportTest[];
  readonly errors: number;
}

export const readReport = (path: string): Report => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { errors?: unknown };
  return { tests: reportTests(parsed), errors: Array.isArray(parsed.errors) ? parsed.errors.length : 0 };
};

const passed = (status: string | undefined) => status === "expected" || status === "flaky";

/**
 * Judges a shard from its report and, when tests failed, the report of running them once more.
 * Every test must pass in one of the two runs, or be one the spec skips on purpose: a test that
 * failed, or didn't run because another failed, passes only if the second run passes it. An error
 * outside any test in either run, a planned test with no result, and a test over the time budget
 * are problems too.
 */
export const judge = (
  first: Report,
  rerun: Report | undefined,
  expected: readonly string[] | undefined,
  quarantine: readonly QuarantineEntry[],
  budgetSeconds: number | undefined,
): Verdict => {
  const problems: string[] = [];
  for (const [name, report] of [["first", first], ["second", rerun]] as const)
    if (report !== undefined && report.errors > 0)
      problems.push(`The ${name} run reported ${report.errors} errors outside any test. Its log names them.`);
  if (expected !== undefined) {
    const reported = new Set(first.tests.map(testKey));
    const missing = expected.filter((key) => !reported.has(key));
    if (missing.length > 0)
      problems.push(`${missing.length} planned tests have no result, such as ${missing.slice(0, 5).join("; ")}`);
  }
  if (budgetSeconds !== undefined)
    for (const test of first.tests)
      if (passed(test.status) && test.seconds !== undefined && test.seconds > budgetSeconds)
        problems.push(
          `${testKey(test)} took ${Math.round(test.seconds)} s, over the ${budgetSeconds} s budget for one ` +
            "browser test. Split it, or give its waits a controlled clock.",
        );
  const again = new Map((rerun?.tests ?? []).map((test) => [testKey(test), test.status]));
  const quarantined = new Map(quarantine.map((entry) => [entry.test, entry]));
  const verdict: Verdict = { flaky: [], quarantined: [], failed: [], problems };
  for (const test of first.tests) {
    if (passed(test.status) || (test.status === "skipped" && test.expectedStatus === "skipped")) continue;
    const key = testKey(test);
    const entry = quarantined.get(key);
    if (passed(again.get(key))) verdict.flaky.push(key);
    else if (entry !== undefined) verdict.quarantined.push(entry);
    else verdict.failed.push(key);
  }
  return verdict;
};

const runRecord = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      results: { type: "string" },
      rerun: { type: "string" },
      expected: { type: "string" },
      quarantine: { type: "string" },
      out: { type: "string" },
      "budget-seconds": { type: "string" },
    },
  });
  if (values.results === undefined || values.out === undefined) throw new Error("record needs --results and --out.");
  const first = readReport(values.results);
  const durations: Record<string, number> = {};
  for (const test of first.tests)
    if (test.seconds !== undefined) durations[testKey(test)] = Math.round(test.seconds * 10) / 10;
  writeFileSync(values.out, `${JSON.stringify(durations)}\n`);
  const verdict = judge(
    first,
    values.rerun === undefined ? undefined : readReport(values.rerun),
    values.expected === undefined ? undefined : (JSON.parse(readFileSync(values.expected, "utf8")) as string[]),
    readQuarantine(values.quarantine),
    values["budget-seconds"] === undefined ? undefined : number(values["budget-seconds"], 0, "budget-seconds"),
  );
  const lines: string[] = [];
  for (const key of verdict.flaky) {
    console.log(`::warning::Flaky: ${key} failed, then passed when run again in a fresh process.`);
    lines.push(`- flaky (failed, then passed in a fresh process): ${key}`);
  }
  for (const entry of verdict.quarantined) {
    console.log(`::warning::Quarantined, owned by ${entry.owner} (${entry.issue}): ${entry.test} passed in neither run.`);
    lines.push(`- quarantined, passed in neither run, owner ${entry.owner}, ${entry.issue}: ${entry.test}`);
  }
  for (const key of verdict.failed) {
    console.log(`::error::Passed in neither run: ${key}`);
    lines.push(`- passed in neither run: ${key}`);
  }
  for (const problem of verdict.problems) console.log(`::error::${problem}`);
  if (lines.length > 0) summary(["Browser test failures in this shard:", ...lines].join("\n"));
  if (verdict.failed.length > 0 || verdict.problems.length > 0) process.exitCode = 1;
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "plan") runPlan(args);
    else if (command === "record") runRecord(args);
    else throw new Error("Usage: node tools/browser-shards.ts plan|record [options]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
