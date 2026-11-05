/**
 * Test selection from a test map, run by .github/workflows/test-map.yml and check.yml.
 *
 * A test map records, for each test file, every repository file its processes loaded, read, listed
 * or ran while that test file ran alone, through tools/test-map-trace.ts. Maps are built only from
 * `main`, by trusted runs, never from a pull request. A pull request run only reads the newest one.
 *
 * A pull request runs only the test files its change needs, unless the repository variable
 * TEST_SELECTION_DISABLED is `true` or it carries the `ci:full` label; pushes to main always run
 * every test. It selects everything when it can't see a change's reach:
 *
 * - no usable map, more than `maxChangedFiles` changed files, or a change to the toolchain, package
 *   manifests, test configuration, workflows or this selector;
 * - a changed file that no test read in the map, unless it is documentation, a test file, or a new
 *   file another changed file names, and an empty selection for any change other than
 *   documentation.
 *
 * Changed and new test files always run, as do test files whose map run failed, since a test that
 * stopped partway has no record of what it would have read next. So do the tests that reach what
 * changed on the base after the map was built, since the map can't know what those changes read.
 *
 * Usage:
 *   node tools/test-map.ts run --suite unit|browser [--shard k/n] --out partial.json
 *   node tools/test-map.ts merge --sha SHA --out test-map.json partial.json...
 *   node tools/test-map.ts select --base SHA --head SHA --out selection.json [--map test-map.json]
 *     [--tested SHA] [--enforce]
 *   node tools/test-map.ts guard --base SHA --head SHA --selection selection.json [--warn]
 *   node tools/test-map.ts report --selection selection.json --out report.json results.json...
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Suite = "unit" | "browser";

/** The test files of each suite, as vitest.config.ts and playwright.config.ts find them. */
export const suiteOf = (path: string): Suite | undefined =>
  /^typescript\/tests\/unit\/.+\.test\.ts$/u.test(path)
    ? "unit"
    : /^typescript\/tests\/browser\/.+\.spec\.ts$/u.test(path)
      ? "browser"
      : undefined;

/** A test map. Test files are numbered by their place in `tests`. */
export interface TestMap {
  readonly version: 1;
  /** The commit the map was built at. */
  readonly sha: string;
  readonly tests: readonly string[];
  /** Tests whose map run failed, so whose record may stop short. */
  readonly failed: readonly number[];
  /** Each repository file, by path, and the tests that loaded, read or ran it. */
  readonly files: Readonly<Record<string, readonly number[]>>;
  /** Each folder, by path ending in `/`, and the tests that listed it. */
  readonly folders: Readonly<Record<string, readonly number[]>>;
}

export interface Change {
  readonly status: "added" | "modified" | "deleted";
  readonly path: string;
}

export interface Selection {
  /** `full` runs every test; `selected` runs `unit` and `browser`, which may both be empty. */
  readonly mode: "full" | "selected";
  readonly reasons: readonly string[];
  readonly mapSha: string | null;
  readonly unit: readonly string[];
  readonly browser: readonly string[];
}

/** More changed files than this select everything. */
export const maxChangedFiles = 300;

/** Paths whose change selects everything: the toolchain, manifests, test setup, CI and its tools. */
const runsEverything = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /^\.npmrc$/u,
  /^\.nvmrc$/u,
  /^\.node-version$/u,
  /^tsconfig[^/]*\.json$/u,
  /^vitest[^/]*\.config\.ts$/u,
  /^playwright[^/]*\.config\.ts$/u,
  /^\.github\/workflows\//u,
  /^\.github\/actions\//u,
  // Every tool, since CI runs several (the browser shard planner, the scans, the workflow and
  // protocol checks) outside any test, and a tool's change must run the jobs that use it.
  /^tools\//u,
];

/** Documentation, which no test needs unless the map records one reading it. */
export const isDocumentation = (path: string): boolean =>
  (!path.startsWith("typescript/") && path.endsWith(".md")) ||
  path.startsWith("docs/") ||
  path === "LICENSE" ||
  (path.startsWith(".github/") && !runsEverything.some((pattern) => pattern.test(path)));

/**
 * The tests to run for a change. `headFiles` lists the files tracked at the head, and `readHead`
 * reads one of them, to find a new file that another changed file names.
 */
export const select = (
  map: TestMap | undefined,
  changes: readonly Change[],
  headFiles: ReadonlySet<string>,
  readHead: (path: string) => string,
  drift: readonly Change[] = [],
): Selection => {
  const full = (reasons: readonly string[]): Selection => ({
    mode: "full",
    reasons,
    mapSha: map?.sha ?? null,
    unit: [],
    browser: [],
  });
  if (map === undefined) return full(["no usable test map"]);
  if (changes.length > maxChangedFiles)
    return full([`${changes.length} changed files, more than ${maxChangedFiles}`]);
  const everything = changes.filter(({ path }) => runsEverything.some((p) => p.test(path)));
  if (everything.length > 0)
    return full(everything.map(({ path }) => `${path} changes the toolchain, test setup or CI`));

  const chosen = new Set<string>();
  const reasons: string[] = [];
  const unseen: string[] = [];
  const choose = (ids: readonly number[] | undefined) => {
    for (const id of ids ?? []) {
      const test = map.tests[id];
      if (test !== undefined) chosen.add(test);
    }
  };
  const readersOf = ({ path, status }: Change): readonly number[] => {
    const ids = [...(map.files[path] ?? [])];
    if (status === "modified") return ids;
    // A listing shows which files a folder holds, so adding or deleting one changes it.
    ids.push(...(map.folders[`${dirname(path)}/`] ?? []));
    for (let folder = dirname(path); folder !== "."; folder = dirname(folder))
      ids.push(...(map.folders[`${folder}/**`] ?? []));
    ids.push(...(map.folders["**"] ?? []));
    return ids;
  };
  /** Changed code files that name a new file by a relative path, such as "./helper.js". */
  const referrers = (path: string) => {
    const stem = basename(path).replace(/\.[^.]+$/u, "");
    const reference = new RegExp(`/${escapeRegExp(stem)}(\\.\\w+)?["'\`]`, "u");
    return changes.filter(
      (other) =>
        other.path !== path &&
        other.status !== "deleted" &&
        !isDocumentation(other.path) &&
        headFiles.has(other.path) &&
        reference.test(readHead(other.path)),
    );
  };
  let substantive = false;
  for (const change of changes) {
    const { path, status } = change;
    if (suiteOf(path) !== undefined) {
      substantive = true;
      if (headFiles.has(path)) chosen.add(path);
      continue;
    }
    const readers = readersOf(change);
    if (readers.length > 0) {
      substantive = true;
      choose(readers);
      continue;
    }
    if (isDocumentation(path)) continue;
    substantive = true;
    if (status === "added") {
      // A new file reaches tests through the files that load it: covered when one of them is a
      // test or has readers of its own, whose tests then run.
      const covering = referrers(path).filter(
        (other) => suiteOf(other.path) !== undefined || readersOf(other).length > 0,
      );
      for (const other of covering) {
        if (suiteOf(other.path) !== undefined) chosen.add(other.path);
        choose(readersOf(other));
      }
      if (covering.length > 0) continue;
    }
    unseen.push(path);
  }
  if (unseen.length > 0) return full(unseen.map((path) => `no test in the map read ${path}`));

  choose(map.failed);
  for (const test of map.failed.map((id) => map.tests[id]))
    if (test !== undefined) reasons.push(`${test} failed in the map run`);
  const known = new Set(map.tests);
  for (const path of headFiles)
    if (suiteOf(path) !== undefined && !known.has(path)) {
      chosen.add(path);
      reasons.push(`${path} is not in the map`);
    }
  for (const test of [...chosen]) if (!headFiles.has(test)) chosen.delete(test);
  if (chosen.size === 0 && substantive)
    return full(["the selection was empty for a change to more than documentation"]);
  // The tested tree also holds what reached the base after the map was built, which the map
  // knows nothing about: its tests, and the readers of what it changed, run too. Main ran every
  // test on it, so its changes count only for the tests they reach.
  const drifted = new Set<string>();
  for (const change of drift) {
    if (suiteOf(change.path) !== undefined) drifted.add(change.path);
    for (const id of readersOf(change)) {
      const test = map.tests[id];
      if (test !== undefined) drifted.add(test);
    }
  }
  const before = chosen.size;
  for (const test of drifted) if (headFiles.has(test)) chosen.add(test);
  if (chosen.size > before)
    reasons.push(
      `${chosen.size - before} more for ${drift.length} files changed on the base since the map`,
    );
  const sorted = [...chosen].toSorted();
  return {
    mode: "selected",
    reasons,
    mapSha: map.sha,
    unit: sorted.filter((test) => suiteOf(test) === "unit"),
    browser: sorted.filter((test) => suiteOf(test) === "browser"),
  };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** A Playwright file filter, a regular expression, that matches one spec file and no other. */
export const playwrightFilter = (path: string): string => `${escapeRegExp(`/${path}`)}$`;

/**
 * What the check and browser jobs run. They run a selection only when it is enforced; otherwise
 * every test. `unit` lists Vitest file filters and `browser` Playwright file filters.
 */
export const jobInputs = (
  selection: Selection,
  enforce: boolean,
): { run: "full" | "selected"; unit: readonly string[]; browser: readonly string[] } =>
  enforce && selection.mode === "selected"
    ? { run: "selected", unit: selection.unit, browser: selection.browser.map(playwrightFilter) }
    : { run: "full", unit: [], browser: [] };

/**
 * Checks a selection against its diff independently of `select`: a selection that runs no test
 * while more than documentation changed is wrong, whatever the map said.
 */
export const guard = (selection: Selection, changes: readonly Change[]): string | undefined => {
  if (selection.mode === "full") return undefined;
  if (selection.unit.length + selection.browser.length > 0) return undefined;
  const code = changes.filter(({ path }) => !isDocumentation(path));
  return code.length === 0
    ? undefined
    : `The selection runs no test, but ${code.length} changed file(s) are more than documentation, such as ${code[0]?.path ?? ""}`;
};

/**
 * The failed test files in Vitest or Playwright JSON results, by repository path, and the seconds
 * each test file took. Playwright names files from its test folder, typescript/tests/browser.
 */
export const readResults = (
  results: unknown,
): { failed: readonly string[]; seconds: Readonly<Record<string, number>> } => {
  const failed = new Set<string>();
  const seconds: Record<string, number> = {};
  const record = Object(results) as Record<string, unknown>;
  const pathOf = (file: unknown) => {
    if (typeof file !== "string") return undefined;
    // Vitest names files by absolute path, from a checkout that may sit anywhere on its runner.
    const index = file.lastIndexOf("/typescript/tests/");
    const path = index === -1 ? file : file.slice(index + 1);
    return path.startsWith("typescript/") ? path : `typescript/tests/browser/${path}`;
  };
  if (Array.isArray(record["testResults"]))
    for (const file of record["testResults"] as Record<string, unknown>[]) {
      const path = pathOf(file["name"]);
      if (path === undefined) continue;
      if (file["status"] === "failed") failed.add(path);
      const { startTime, endTime } = file;
      if (typeof startTime === "number" && typeof endTime === "number")
        seconds[path] = (seconds[path] ?? 0) + (endTime - startTime) / 1000;
    }
  const walk = (suites: unknown) => {
    if (!Array.isArray(suites)) return;
    for (const suite of suites as Record<string, unknown>[]) {
      for (const spec of (suite["specs"] as Record<string, unknown>[] | undefined) ?? []) {
        const path = pathOf(spec["file"] ?? suite["file"]);
        if (path === undefined) continue;
        if (spec["ok"] === false) failed.add(path);
        for (const test of (spec["tests"] as Record<string, unknown>[] | undefined) ?? [])
          for (const result of (test["results"] as Record<string, unknown>[] | undefined) ?? [])
            if (typeof result["duration"] === "number")
              seconds[path] = (seconds[path] ?? 0) + result["duration"] / 1000;
      }
      walk(suite["suites"]);
    }
  };
  walk(record["suites"]);
  return { failed: [...failed].toSorted(), seconds };
};

/**
 * Compares a selection with a run's JSON results: the failed test files, those the selection left
 * out, and the test-seconds of each suite the selection kept out of the run's total.
 */
export const compare = (selection: Selection, results: readonly unknown[]) => {
  const read = results.map(readResults);
  const failed = [...new Set(read.flatMap((result) => result.failed))].toSorted();
  // Shards split one spec file's tests, so a file's seconds add up across results.
  const seconds: Record<string, number> = {};
  for (const result of read)
    for (const [path, time] of Object.entries(result.seconds))
      seconds[path] = (seconds[path] ?? 0) + time;
  const selected = new Set([...selection.unit, ...selection.browser]);
  const missed = selection.mode === "full" ? [] : failed.filter((test) => !selected.has(test));
  const share = (suite: Suite) => {
    const files = Object.entries(seconds).filter(([path]) => suiteOf(path) === suite);
    const total = files.reduce((sum, [, time]) => sum + time, 0);
    const chosen = files
      .filter(([path]) => selection.mode === "full" || selected.has(path))
      .reduce((sum, [, time]) => sum + time, 0);
    return { selectedSeconds: Math.round(chosen), totalSeconds: Math.round(total) };
  };
  return { selection, failed, missed, unit: share("unit"), browser: share("browser") };
};

/** Changed files between two commits, renames as a deletion and an addition. */
export const changesBetween = (base: string, head: string, cwd = process.cwd()): Change[] => {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "-z", `${base}...${head}`],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const fields = output.split("\0").filter((field) => field !== "");
  const changes: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index] ?? "";
    const path = fields[index + 1] ?? "";
    changes.push({
      status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      path,
    });
  }
  return changes;
};

const trackedFiles = (ref: string, cwd = process.cwd()): Set<string> =>
  new Set(
    execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", ref], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path !== ""),
  );

/**
 * Turns what one test's processes recorded into repository files and folders. A built file in
 * `dist/` counts as its source, and the runtime source manifest as the modules it lists. A built
 * file with no known source counts as every source file the build reads, so a test reading it is
 * never missed. Paths that aren't files, such as a module resolver's guesses, are dropped.
 */
export const normalize = (
  recorded: Iterable<string>,
  tracked: ReadonlySet<string>,
  runtimeManifest: () => readonly string[],
  isBuiltFile: (path: string) => boolean,
): { files: Set<string>; folders: Set<string> } => {
  const folders = new Set<string>();
  const trackedFolders = new Set<string>();
  for (const path of tracked)
    for (let folder = dirname(path); folder !== "."; folder = dirname(folder))
      trackedFolders.add(`${folder}/`);
  const files = new Set<string>();
  const addSource = (path: string) => {
    if (tracked.has(path)) files.add(path);
  };
  for (const raw of recorded) {
    const path = raw.replace(/\/+$/u, raw.endsWith("/") ? "/" : "").replace(/\/{2,}/gu, "/");
    if (path === "**") {
      folders.add(path);
      continue;
    }
    if (path.endsWith("/**")) {
      if (trackedFolders.has(path.slice(0, -2))) folders.add(path);
      continue;
    }
    if (path.endsWith("/")) {
      if (trackedFolders.has(path)) folders.add(path);
      continue;
    }
    if (tracked.has(path)) {
      files.add(path);
      continue;
    }
    if (!path.startsWith("dist/")) continue;
    const built = path.slice("dist/".length);
    if (built === "runtime-sources.json") {
      for (const source of runtimeManifest()) addSource(source);
      continue;
    }
    if (built.endsWith(".d.ts") || built.endsWith(".map")) continue;
    const source = built.endsWith(".js") ? built.replace(/\.js$/u, ".ts") : built;
    if (tracked.has(source)) {
      files.add(source);
      continue;
    }
    if (!isBuiltFile(path)) continue;
    for (const file of tracked)
      if (file.startsWith("typescript/src/") || file.startsWith("typescript/authoring/"))
        files.add(file);
  }
  return { files, folders };
};

/** The source files dist/runtime-sources.json bundles, from the built manifest. */
const runtimeManifestSources = (root: string) => (): readonly string[] => {
  const manifest = JSON.parse(readFileSync(join(root, "dist/runtime-sources.json"), "utf8")) as {
    root?: string;
    modules?: { path?: string }[];
  };
  const base = (manifest.root ?? "dist/typescript/src").replace(/^dist\//u, "");
  return (manifest.modules ?? []).flatMap(({ path }) =>
    path === undefined ? [] : [join(base, path).replace(/\.js$/u, ".ts")],
  );
};

interface Partial {
  readonly tests: Readonly<
    Record<string, { passed: boolean; seconds: number; files: string[]; folders: string[] }>
  >;
}

/** Runs one test file alone with the trace preload and returns what its processes recorded. */
const runOne = async (root: string, suite: Suite, test: string, workers: number) => {
  const out = mkdtempSync(join(tmpdir(), "test-map-"));
  const preload = new URL("./test-map-trace.ts", import.meta.url).href;
  const args =
    suite === "unit"
      ? ["exec", "vitest", "run", test]
      : [
          "exec",
          "playwright",
          "test",
          playwrightFilter(test),
          `--workers=${workers}`,
          "--reporter=line",
        ];
  const started = Date.now();
  const code = await new Promise<number>((done) => {
    const child = spawn("corepack", ["pnpm", ...args], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import ${preload}`.trim(),
        TEST_MAP_OUT: out,
        TEST_MAP_ROOT: root,
      },
    });
    child.on("close", (status) => done(status ?? 1));
  });
  const recorded = new Set<string>();
  for (const file of readdirSync(out))
    for (const line of readFileSync(join(out, file), "utf8").split("\n"))
      if (line !== "") recorded.add(line);
  rmSync(out, { recursive: true, force: true });
  return { passed: code === 0, seconds: (Date.now() - started) / 1000, recorded };
};

const listTests = (root: string, suite: Suite): string[] =>
  [...trackedFiles("HEAD", root)].filter((path) => suiteOf(path) === suite).toSorted();

const runMap = async (
  suite: Suite,
  shard: string,
  out: string,
  workers: number,
  parallel: number,
) => {
  const root = process.cwd();
  const [index, total] = shard.split("/").map(Number);
  if (index === undefined || total === undefined || !(index >= 1 && index <= total))
    throw new Error(`Bad shard ${shard}; use k/n`);
  const tests = listTests(root, suite).filter((_, position) => position % total === index - 1);
  const tracked = trackedFiles("HEAD", root);
  const manifest = runtimeManifestSources(root);
  const isBuiltFile = (path: string) => {
    try {
      return statSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  };
  const results: Record<
    string,
    { passed: boolean; seconds: number; files: string[]; folders: string[] }
  > = {};
  const queue = [...tests];
  const worker = async () => {
    for (let test = queue.shift(); test !== undefined; test = queue.shift()) {
      const result = await runOne(root, suite, test, workers);
      const { files, folders } = normalize(result.recorded, tracked, manifest, isBuiltFile);
      results[test] = {
        passed: result.passed,
        seconds: result.seconds,
        files: [...files].toSorted(),
        folders: [...folders].toSorted(),
      };
      process.stdout.write(
        `${result.passed ? "mapped" : "FAILED"} ${test} in ${result.seconds.toFixed(1)} s: ${files.size} files\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const partial: Partial = { tests: results };
  writeFileSync(out, `${JSON.stringify(partial)}\n`);
};

export const merge = (sha: string, partials: readonly Partial[]): TestMap => {
  const entries = partials
    .flatMap((partial) => Object.entries(partial.tests))
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  const tests = entries.map(([test]) => test);
  const files: Record<string, number[]> = {};
  const folders: Record<string, number[]> = {};
  entries.forEach(([, record], id) => {
    for (const file of record.files) (files[file] ??= []).push(id);
    for (const folder of record.folders) (folders[folder] ??= []).push(id);
  });
  // A test runner lists its test folders to find test files, for every test of its suite. That is
  // no test's own dependency, and a new test file there runs anyway as a changed test.
  const suiteSizes = new Map<Suite | undefined, number>();
  for (const test of tests) suiteSizes.set(suiteOf(test), (suiteSizes.get(suiteOf(test)) ?? 0) + 1);
  for (const [folder, readers] of Object.entries(folders)) {
    const bySuite = new Map<Suite | undefined, number>();
    for (const id of readers) {
      const suite = suiteOf(tests[id] ?? "");
      bySuite.set(suite, (bySuite.get(suite) ?? 0) + 1);
    }
    if ([...bySuite].some(([suite, count]) => count > 1 && count === suiteSizes.get(suite)))
      delete folders[folder];
  }
  const failed = entries.flatMap(([, record], id) => (record.passed ? [] : [id]));
  return { version: 1, sha, tests, failed, files, folders };
};

/** A map older than this, counted from its commit to the base's, is not used. */
export const maxMapAgeDays = 3;

/**
 * The map at `path` when it is usable for a change based on `base`: its commit is on the base's
 * history and at most `maxMapAgeDays` older than the base. Otherwise why it isn't.
 */
export const readMap = (
  path: string | undefined,
  base: string,
  cwd = process.cwd(),
): TestMap | string => {
  if (path === undefined || path === "" || !existsSync(path)) return "no test map";
  let map: TestMap;
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as TestMap;
  } catch {
    return "the test map does not parse";
  }
  const isRecord = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    map.version !== 1 ||
    typeof map.sha !== "string" ||
    !Array.isArray(map.tests) ||
    !Array.isArray(map.failed) ||
    !isRecord(map.files) ||
    !isRecord(map.folders)
  )
    return "the test map has an unknown format";
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", map.sha, base], { cwd });
  if (ancestor.status !== 0) return `the test map's commit ${map.sha} is not on the base's history`;
  const time = (commit: string) =>
    Number(
      execFileSync("git", ["show", "-s", "--format=%ct", commit], { cwd, encoding: "utf8" }).trim(),
    );
  const days = (time(base) - time(map.sha)) / 86_400;
  if (days > maxMapAgeDays)
    return `the test map is ${days.toFixed(1)} days older than the base, more than ${maxMapAgeDays}`;
  return map;
};

const summary = (text: string) => {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined && file !== "") appendFileSync(file, `${text}\n`);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      suite: { type: "string" },
      shard: { type: "string", default: "1/1" },
      out: { type: "string" },
      sha: { type: "string" },
      map: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      tested: { type: "string" },
      selection: { type: "string" },
      workers: { type: "string", default: "4" },
      parallel: { type: "string", default: "1" },
      warn: { type: "boolean", default: false },
      enforce: { type: "boolean", default: false },
    },
  });
  const need = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
    return value;
  };
  if (command === "run") {
    const suite = need("suite");
    if (suite !== "unit" && suite !== "browser") throw new Error("--suite is unit or browser");
    await runMap(
      suite,
      need("shard"),
      resolve(need("out")),
      Number(values.workers),
      Number(values.parallel),
    );
  } else if (command === "merge") {
    const partials = positionals.map((path) => JSON.parse(readFileSync(path, "utf8")) as Partial);
    const map = merge(need("sha"), partials);
    writeFileSync(need("out"), `${JSON.stringify(map)}\n`);
    process.stdout.write(
      `Mapped ${map.tests.length} test files, ${map.failed.length} failed, at ${map.sha}\n`,
    );
  } else if (command === "select") {
    const head = need("head");
    const base = need("base");
    // The commit the tests run on: the merge of the pull request into its base, or its head.
    const tested = values.tested ?? head;
    const changes = changesBetween(base, head);
    const headFiles = trackedFiles(tested);
    const readHead = (path: string) =>
      execFileSync("git", ["show", `${tested}:${path}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const map = readMap(values.map, base);
    const drift =
      typeof map === "string"
        ? []
        : changesBetween(map.sha, tested === head ? base : `${tested}^1`);
    const chosen = select(
      typeof map === "string" ? undefined : map,
      changes,
      headFiles,
      readHead,
      drift,
    );
    const selection = typeof map === "string" ? { ...chosen, reasons: [map] } : chosen;
    writeFileSync(need("out"), `${JSON.stringify(selection, null, 2)}\n`);
    const enforce = values.enforce === true;
    const inputs = jobInputs(selection, enforce);
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined && output !== "")
      appendFileSync(
        output,
        `run=${inputs.run}\nunit=${JSON.stringify(inputs.unit)}\nbrowser=${JSON.stringify(inputs.browser)}\n`,
      );
    const line =
      selection.mode === "full"
        ? `Test selection picks every test: ${selection.reasons.join("; ")}`
        : `Test selection picks ${selection.unit.length} unit and ${selection.browser.length} browser test files`;
    process.stdout.write(`${line}\n`);
    summary(`### Test selection\n\n${line}\n`);
  } else if (command === "guard") {
    const selection = JSON.parse(readFileSync(need("selection"), "utf8")) as Selection;
    const problem = guard(selection, changesBetween(need("base"), need("head")));
    if (problem !== undefined) {
      // A job that only records the selection warns; the jobs that run it fail.
      process.stdout.write(`${values.warn === true ? "::warning::" : "::error::"}${problem}\n`);
      if (values.warn !== true) process.exitCode = 1;
    } else
      process.stdout.write("The selection runs tests for every change beyond documentation.\n");
  } else if (command === "report") {
    const selection = JSON.parse(readFileSync(need("selection"), "utf8")) as Selection;
    const report = compare(
      selection,
      positionals.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown),
    );
    const { missed, failed } = report;
    writeFileSync(need("out"), `${JSON.stringify(report, null, 2)}\n`);
    const line =
      missed.length === 0
        ? `No failed test file fell outside the selection (${failed.length} failed).`
        : `${missed.length} failed test file(s) fell outside the selection: ${missed.join(", ")}`;
    const time = `The selection covers ${report.unit.selectedSeconds} of ${report.unit.totalSeconds} unit test-seconds and ${report.browser.selectedSeconds} of ${report.browser.totalSeconds} browser test-seconds in these results.`;
    process.stdout.write(`${missed.length === 0 ? "" : "::warning::"}${line}\n${time}\n`);
    summary(`### Test selection report\n\n${line} ${time}\n`);
  } else {
    throw new Error("Use run, merge, select, guard or report");
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
