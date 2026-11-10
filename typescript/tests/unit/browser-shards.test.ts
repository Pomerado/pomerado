import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../tools/browser-shards.ts", import.meta.url));

interface Spec {
  readonly file: string;
  /** Describe titles, then the test's own title. */
  readonly titles: readonly string[];
  /** The duration a report gives the test, in seconds. */
  readonly seconds?: number;
  /** Playwright's outcome for the test, `expected` by default when it has a duration. */
  readonly status?: string;
  /** `skipped` for a test the spec skips on purpose. */
  readonly expectedStatus?: string;
  readonly line?: number;
}

interface Suite {
  title: string;
  file: string;
  specs: {
    title: string;
    file: string;
    line: number;
    tests: { status: string; expectedStatus: string; results: { duration: number }[] }[];
  }[];
  suites: Suite[];
}

/** A Playwright JSON report, or `--list` output when no spec has a duration, for the specs. */
const report = (specs: readonly Spec[], errors: readonly string[] = []) => {
  const files = new Map<string, Suite>();
  for (const spec of specs) {
    let suite = files.get(spec.file);
    if (suite === undefined) {
      suite = { title: spec.file, file: spec.file, specs: [], suites: [] };
      files.set(spec.file, suite);
    }
    for (const title of spec.titles.slice(0, -1)) {
      const parent: Suite = suite;
      suite = parent.suites.find((child) => child.title === title);
      if (suite === undefined) {
        suite = { title, file: spec.file, specs: [], suites: [] };
        parent.suites.push(suite);
      }
    }
    suite.specs.push({
      title: spec.titles.at(-1) ?? "",
      file: spec.file,
      line: spec.line ?? 1,
      tests: [
        {
          status: spec.status ?? (spec.seconds === undefined ? "skipped" : "expected"),
          expectedStatus: spec.expectedStatus ?? "passed",
          results: spec.seconds === undefined ? [] : [{ duration: spec.seconds * 1000 }],
        },
      ],
    });
  }
  return { config: {}, suites: [...files.values()], errors: errors.map((message) => ({ message })) };
};

const key = (spec: Spec) => [spec.file, ...spec.titles].join(" › ");

describe("browser shards", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const temporary = () => {
    const directory = mkdtempSync(join(tmpdir(), "browser-shards-"));
    directories.push(directory);
    return directory;
  };

  const run = (args: readonly string[], cwd?: string) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
      env: { PATH: process.env["PATH"] ?? "" },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  /** Plans `specs` against recorded `durations` and reads back each shard's lines and tests. */
  const planShards = (
    specs: readonly Spec[],
    durations: Record<string, number> | undefined,
    options: readonly string[] = [],
    sources: Record<string, string> = {},
  ) => {
    const root = temporary();
    const testDirectory = join(root, "tests");
    mkdirSync(testDirectory);
    for (const file of new Set(specs.map((spec) => spec.file)))
      writeFileSync(join(testDirectory, file), sources[file] ?? 'test("a test", () => {});\n');
    // A listing has each test's place but no results.
    const listed = specs.map(({ seconds: _seconds, status: _status, ...test }) => test);
    writeFileSync(join(root, "list.json"), JSON.stringify(report(listed)));
    const durationDirectory = join(root, "durations");
    mkdirSync(durationDirectory);
    if (durations !== undefined) writeFileSync(join(durationDirectory, "durations-1.json"), JSON.stringify(durations));
    const out = join(root, "shards");
    const result = run([
      "plan",
      "--tests",
      join(root, "list.json"),
      "--durations",
      durationDirectory,
      "--out",
      out,
      "--test-dir",
      testDirectory,
      ...options,
    ]);
    expect(result.status, result.output).toBe(0);
    const count = readdirSync(out).filter((name) => /^shard-\d+\.txt$/u.test(name)).length;
    return {
      output: result.output,
      root,
      shards: Array.from({ length: count }, (_, index) => ({
        lines: readFileSync(join(out, `shard-${index + 1}.txt`), "utf8").trim().split("\n"),
        tests: JSON.parse(readFileSync(join(out, `shard-${index + 1}.json`), "utf8")) as string[],
      })),
    };
  };

  const recorded = (specs: readonly Spec[]) => Object.fromEntries(specs.map((spec) => [key(spec), spec.seconds ?? 0]));

  it("splits by recorded duration, so a long file's tests spread over several shards", () => {
    const long = Array.from({ length: 8 }, (_, index) => ({
      file: "long.spec.ts",
      titles: [`slow ${index}`],
      seconds: 40,
    }));
    const short = Array.from({ length: 80 }, (_, index) => ({
      file: "short.spec.ts",
      titles: ["group", `quick ${index}`],
      seconds: 1,
    }));
    const specs = [...long, ...short];
    const { shards } = planShards(specs, recorded(specs), ["--target-seconds", "50", "--workers", "1"]);

    // 400 test-seconds at 50 per shard make 8 shards.
    expect(shards).toHaveLength(8);
    const all = shards.flatMap((shard) => shard.tests).sort();
    expect(all).toEqual(specs.map(key).sort());
    const seconds = new Map(specs.map((spec) => [key(spec), spec.seconds]));
    for (const shard of shards) {
      expect(shard.tests.filter((test) => test.startsWith("long.spec.ts"))).toHaveLength(1);
      expect(shard.tests.reduce((sum, test) => sum + (seconds.get(test) ?? 0), 0)).toBe(50);
    }
    // A shard's lines are its tests, one per line.
    expect(shards[0]?.lines.sort()).toEqual(shards[0]?.tests);
  });

  it("keeps long tests from starting after a shard's short ones, since tests run in file order", () => {
    // Split evenly by time, each shard would end with a long test that starts once its short tests
    // are done, at 4 s, and ends at 12 s. Together, the long tests end at 8 s, as the short ones do.
    const specs = [
      ...Array.from({ length: 16 }, (_, index) => ({ file: "a.spec.ts", titles: [`short ${index}`], seconds: 1 })),
      { file: "z.spec.ts", titles: ["long one"], seconds: 8 },
      { file: "z.spec.ts", titles: ["long two"], seconds: 8 },
    ];
    const { shards, output } = planShards(specs, recorded(specs), ["--target-seconds", "8", "--workers", "2"]);
    expect(shards.map((shard) => shard.tests.length).sort()).toEqual([16, 2]);
    expect(shards.find((shard) => shard.tests.length === 2)?.tests).toEqual(["z.spec.ts › long one", "z.spec.ts › long two"]);
    expect(output).not.toContain("about 12 s");
  });

  it("plans no empty shard when fewer shards end as early", () => {
    // Four workers run the four tests at once, so a second shard would end no earlier.
    const specs = Array.from({ length: 4 }, (_, index) => ({ file: "a.spec.ts", titles: [`long ${index}`], seconds: 30 }));
    const { shards } = planShards(specs, recorded(specs), ["--target-seconds", "20", "--workers", "4"]);
    expect(shards.map((shard) => shard.tests.length)).toEqual([4]);
  });

  it("estimates a test without a recorded duration from its file, and splits by count without durations", () => {
    const old = { file: "a.spec.ts", titles: ["old"], seconds: 30 };
    const added = { file: "a.spec.ts", titles: ["added"] };
    const other = { file: "b.spec.ts", titles: ["other"], seconds: 10 };
    const { shards } = planShards([old, added, other], recorded([old, other]), [
      "--target-seconds",
      "30",
      "--workers",
      "1",
    ]);
    // The added test counts as its file's 30 s, not the overall median of 20 s, so 70 s make 3 shards.
    expect(shards).toHaveLength(3);
    expect(shards.map((shard) => shard.tests)).toContainEqual(["a.spec.ts › added"]);

    const counted = planShards(
      Array.from({ length: 12 }, (_, index) => ({ file: "c.spec.ts", titles: [`t${index}`] })),
      undefined,
      ["--target-seconds", "6", "--workers", "1", "--default-seconds", "2"],
    );
    expect(counted.output).toContain("No recorded browser test durations");
    expect(counted.shards.map((shard) => shard.tests.length)).toEqual([3, 3, 3, 3]);
  });

  it("keeps a file whole when a test list can't name its tests apart", () => {
    const specs: Spec[] = [
      { file: "nested.spec.ts", titles: ["checkout"], seconds: 5 },
      { file: "nested.spec.ts", titles: ["checkout", "pays"], seconds: 5 },
      { file: "arrow.spec.ts", titles: ["a › b"], seconds: 5 },
      { file: "arrow.spec.ts", titles: ["c"], seconds: 5 },
      { file: "serial.spec.ts", titles: ["first"], seconds: 5 },
      { file: "serial.spec.ts", titles: ["second"], seconds: 5 },
      { file: "plain.spec.ts", titles: ["x"], seconds: 5 },
      { file: "plain.spec.ts", titles: ["y"], seconds: 5 },
    ];
    const { shards } = planShards(specs, recorded(specs), ["--target-seconds", "5", "--workers", "1"], {
      "serial.spec.ts": 'test.describe.configure({ mode: "serial" });\n',
    });
    const lines = shards.flatMap((shard) => shard.lines).sort();
    expect(lines).toEqual(["arrow.spec.ts", "nested.spec.ts", "plain.spec.ts › x", "plain.spec.ts › y", "serial.spec.ts"]);
    for (const file of ["arrow.spec.ts", "nested.spec.ts", "serial.spec.ts"]) {
      const holding = shards.filter((shard) => shard.tests.some((test) => test.startsWith(`${file} › `)));
      expect(holding).toHaveLength(1);
      expect(holding[0]?.tests.filter((test) => test.startsWith(`${file} › `))).toHaveLength(2);
    }
  });

  it("records durations, and fails a shard that misses a planned test or runs one over the budget", () => {
    const root = temporary();
    const ran = [
      { file: "a.spec.ts", titles: ["group", "quick"], seconds: 1.23 },
      { file: "a.spec.ts", titles: ["slow"], seconds: 130 },
    ];
    writeFileSync(join(root, "report.json"), JSON.stringify(report(ran)));
    writeFileSync(join(root, "expected.json"), JSON.stringify([...ran.map(key), "a.spec.ts › skipped by the list"]));
    const out = join(root, "durations.json");

    const passing = run(["record", "--results", join(root, "report.json"), "--out", out]);
    expect(passing.status, passing.output).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      "a.spec.ts › group › quick": 1.2,
      "a.spec.ts › slow": 130,
    });

    const failing = run([
      "record",
      "--results",
      join(root, "report.json"),
      "--expected",
      join(root, "expected.json"),
      "--out",
      out,
      "--budget-seconds",
      "100",
    ]);
    expect(failing.status).toBe(1);
    expect(failing.output).toContain("1 planned tests have no result, such as a.spec.ts › skipped by the list");
    expect(failing.output).toContain("a.spec.ts › slow took 130 s, over the 100 s budget");
    expect(failing.output).not.toContain("quick took");
  });

  it("passes a shard whose failed test passes in a fresh process, and names it flaky", () => {
    const root = temporary();
    const flaky = { file: "a.spec.ts", titles: ["races"], seconds: 2, status: "unexpected" };
    const broken = { file: "a.spec.ts", titles: ["broken"], seconds: 2, status: "unexpected" };
    const known = { file: "b.spec.ts", titles: ["known"], seconds: 2, status: "unexpected" };
    const fine = { file: "b.spec.ts", titles: ["fine"], seconds: 2 };
    writeFileSync(join(root, "first.json"), JSON.stringify(report([flaky, broken, known, fine])));
    writeFileSync(
      join(root, "rerun.json"),
      JSON.stringify(report([{ ...flaky, status: "expected" }, broken, known])),
    );
    const quarantine = (owner: string, issue: string) =>
      JSON.stringify({ tests: [{ test: key(known), owner, issue }] });
    const issue = "https://github.com/example-org/example-repo/issues/12";
    const record = (files: { results: string; rerun: string }) =>
      run([
        "record",
        "--results",
        join(root, files.results),
        "--rerun",
        join(root, files.rerun),
        "--quarantine",
        join(root, "quarantine.json"),
        "--out",
        join(root, "durations.json"),
      ]);

    writeFileSync(join(root, "quarantine.json"), quarantine("someone", issue));
    const mixed = record({ results: "first.json", rerun: "rerun.json" });
    expect(mixed.status).toBe(1);
    expect(mixed.output).toContain("::warning::Flaky: a.spec.ts › races failed, then passed");
    expect(mixed.output).toContain("::warning::Quarantined, owned by someone");
    expect(mixed.output).toContain("::error::Passed in neither run: a.spec.ts › broken");
    expect(mixed.output).not.toContain("Passed in neither run: b.spec.ts › known");

    writeFileSync(join(root, "first.json"), JSON.stringify(report([flaky, known, fine])));
    expect(record({ results: "first.json", rerun: "rerun.json" }).status).toBe(0);

    writeFileSync(join(root, "quarantine.json"), quarantine("", issue));
    expect(record({ results: "first.json", rerun: "rerun.json" }).output).toContain('needs "test", "owner" and "issue"');
    writeFileSync(join(root, "quarantine.json"), quarantine("someone", "an internal note"));
    expect(record({ results: "first.json", rerun: "rerun.json" }).output).toContain("full GitHub issue URL");
  });

  it("fails a shard whose test never passed, even one the first run didn't get to, or an error outside any test", () => {
    const root = temporary();
    const failing = { file: "a.spec.ts", titles: ["fails once"], seconds: 1, status: "unexpected" };
    const unreached = { file: "a.spec.ts", titles: ["not reached"], status: "skipped" };
    const skipped = { file: "a.spec.ts", titles: ["skipped on purpose"], status: "skipped", expectedStatus: "skipped" };
    const record = (first: object, rerun: object) => {
      writeFileSync(join(root, "first.json"), JSON.stringify(first));
      writeFileSync(join(root, "rerun.json"), JSON.stringify(rerun));
      return run([
        "record",
        "--results",
        join(root, "first.json"),
        "--rerun",
        join(root, "rerun.json"),
        "--out",
        join(root, "durations.json"),
      ]);
    };

    const neverPassed = record(
      report([failing, unreached, skipped]),
      report([{ ...failing, status: "expected" }, { ...unreached, seconds: 1, status: "unexpected" }]),
    );
    expect(neverPassed.status).toBe(1);
    expect(neverPassed.output).toContain("Passed in neither run: a.spec.ts › not reached");
    expect(neverPassed.output).not.toContain("skipped on purpose");

    const passedLater = record(
      report([failing, unreached, skipped]),
      report([{ ...failing, status: "expected" }, { ...unreached, seconds: 1, status: "expected" }]),
    );
    expect(passedLater.status, passedLater.output).toBe(0);

    const workerError = record(report([{ ...failing, status: "expected" }], ["worker teardown failed"]), report([]));
    expect(workerError.status).toBe(1);
    expect(workerError.output).toContain("The first run reported 1 errors outside any test");
  });

  it("refuses a quarantine entry for a test that no longer exists", () => {
    const specs = [{ file: "a.spec.ts", titles: ["kept"], seconds: 1 }];
    const root = temporary();
    writeFileSync(join(root, "a.spec.ts"), 'test("kept", () => {});\n');
    writeFileSync(join(root, "list.json"), JSON.stringify(report(specs)));
    writeFileSync(
      join(root, "quarantine.json"),
      JSON.stringify({
        tests: [
          { test: "a.spec.ts › renamed", owner: "someone", issue: "https://github.com/example-org/example-repo/issues/3" },
        ],
      }),
    );
    const result = run([
      "plan",
      "--tests",
      join(root, "list.json"),
      "--out",
      join(root, "shards"),
      "--test-dir",
      root,
      "--quarantine",
      join(root, "quarantine.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Quarantined tests that no longer exist, to remove: a.spec.ts › renamed");
  });

  it("repeats the tests a diff touches, as many as fit the budget", () => {
    const specs: Spec[] = [
      { file: "a.spec.ts", titles: ["first"], line: 10, seconds: 4 },
      { file: "a.spec.ts", titles: ["second"], line: 20, seconds: 5 },
      { file: "a.spec.ts", titles: ["third"], line: 30, seconds: 6 },
      { file: "b.spec.ts", titles: ["one"], line: 5, seconds: 1 },
      { file: "b.spec.ts", titles: ["two"], line: 9, seconds: 1 },
      { file: "c.spec.ts", titles: ["slow"], line: 3, seconds: 60 },
      { file: "d.spec.ts", titles: ["untouched"], line: 3, seconds: 1 },
    ];
    // In a.spec.ts, a line inside "second" changes and a line after "third" is deleted. A helper
    // above b.spec.ts's first test changes, and c.spec.ts's only test changes.
    const diff = [
      "diff --git a/tests/a.spec.ts b/tests/a.spec.ts",
      "--- a/tests/a.spec.ts",
      "+++ b/tests/a.spec.ts",
      "@@ -22 +22 @@",
      "-  const old = 1;",
      "+++ an added line whose text starts with two plus signs",
      "@@ -40,2 +39,0 @@",
      "diff --git a/tests/b.spec.ts b/tests/b.spec.ts",
      "--- a/tests/b.spec.ts",
      "+++ b/tests/b.spec.ts",
      "@@ -2,0 +3,2 @@",
      "diff --git a/tests/c.spec.ts b/tests/c.spec.ts",
      "--- a/tests/c.spec.ts",
      "+++ b/tests/c.spec.ts",
      "@@ -4 +4 @@",
      "diff --git a/tests/gone.spec.ts b/tests/gone.spec.ts",
      "--- a/tests/gone.spec.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");
    const { root } = planShards(specs, recorded(specs), ["--target-seconds", "20", "--workers", "2"]);
    writeFileSync(join(root, "changes.diff"), diff);
    const result = run([
      "plan",
      "--tests",
      join(root, "list.json"),
      "--durations",
      join(root, "durations"),
      "--out",
      join(root, "shards"),
      "--test-dir",
      "tests",
      "--target-seconds",
      "20",
      "--workers",
      "2",
      "--diff",
      join(root, "changes.diff"),
    ], root);
    expect(result.status, result.output).toBe(0);
    // 40 s of budget at 3 runs each fits 13 s of tests: b's two (2 s) and a's second and third (11 s).
    expect(readFileSync(join(root, "shards", "repeat.txt"), "utf8").trim().split("\n").sort()).toEqual([
      "a.spec.ts › second",
      "a.spec.ts › third",
      "b.spec.ts › one",
      "b.spec.ts › two",
    ]);
    expect(result.output).toContain("not repeated, over the time budget: c.spec.ts › slow");
  });
});
