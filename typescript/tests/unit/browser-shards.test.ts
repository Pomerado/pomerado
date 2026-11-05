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
}

interface Suite {
  title: string;
  file: string;
  specs: { title: string; file: string; tests: { results: { duration: number }[] }[] }[];
  suites: Suite[];
}

/** A Playwright JSON report, or `--list` output when no spec has a duration, for the specs. */
const report = (specs: readonly Spec[]) => {
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
      tests: [{ results: spec.seconds === undefined ? [] : [{ duration: spec.seconds * 1000 }] }],
    });
  }
  return { config: {}, suites: [...files.values()], errors: [] };
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

  const run = (args: readonly string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
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
    writeFileSync(join(root, "list.json"), JSON.stringify(report(specs.map(({ file, titles }) => ({ file, titles })))));
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
    const count = readdirSync(out).filter((name) => name.endsWith(".txt")).length;
    return {
      output: result.output,
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
});
