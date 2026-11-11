import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compare,
  readResults,
  guard,
  jobInputs,
  merge,
  normalize,
  readMap,
  select,
  type Change,
  type TestMap,
} from "../../../tools/test-map.js";

const script = fileURLToPath(new URL("../../../tools/test-map.ts", import.meta.url));
const preload = new URL("../../../tools/test-map-trace.ts", import.meta.url).href;
const selectScript = fileURLToPath(new URL("../../../tools/test-map-select.sh", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "test-map-test-"));
  directories.push(directory);
  return directory;
};

const unitA = "typescript/tests/unit/a.test.ts";
const unitB = "typescript/tests/unit/b.test.ts";
const specC = "typescript/tests/browser/c.spec.ts";
const map: TestMap = {
  version: 1,
  sha: "1".repeat(40),
  tests: [specC, unitA, unitB],
  failed: [],
  files: {
    "typescript/src/shared.ts": [0, 1],
    "typescript/src/only-b.ts": [2],
    "typescript/authoring/core/SKILL.md": [0],
    "README.md": [1],
  },
  folders: { "typescript/authoring/core/": [0] },
};
const headFiles = new Set([
  unitA,
  unitB,
  specC,
  "typescript/src/shared.ts",
  "typescript/src/only-b.ts",
]);
const modified = (path: string): Change => ({ status: "modified", path });
const added = (path: string): Change => ({ status: "added", path });
const pick = (
  changes: readonly Change[],
  options: {
    map?: TestMap | undefined;
    files?: Set<string>;
    head?: Record<string, string>;
    drift?: readonly Change[];
  } = {},
) =>
  select(
    "map" in options ? options.map : map,
    changes,
    options.files ?? headFiles,
    (path) => options.head?.[path] ?? "",
    options.drift,
  );

describe("select", () => {
  it("runs the tests that read a changed file, and only those", () => {
    expect(pick([modified("typescript/src/only-b.ts")])).toMatchObject({
      mode: "selected",
      unit: [unitB],
      browser: [],
    });
    expect(pick([modified("typescript/src/shared.ts")])).toMatchObject({
      unit: [unitA],
      browser: [specC],
    });
    expect(pick([modified("typescript/authoring/core/SKILL.md")])).toMatchObject({
      unit: [],
      browser: [specC],
    });
  });

  it("runs everything for a changed file no test read, such as one only a computed path loads", () => {
    const selection = pick([
      modified("typescript/src/only-b.ts"),
      modified("typescript/src/hidden.ts"),
    ]);
    expect(selection.mode).toBe("full");
    expect(selection.reasons.join()).toContain("typescript/src/hidden.ts");
  });

  it("runs everything for the toolchain, test setup, workflows and the selector, and without a map", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "package.json",
      "vitest.config.ts",
      ".github/workflows/check.yml",
      "tools/test-map-trace.ts",
      "tools/test-map-select.sh",
      "tools/browser-shards.ts",
    ])
      expect(pick([modified(path)]).mode).toBe("full");
    expect(pick([modified("typescript/src/only-b.ts")], { map: undefined }).mode).toBe("full");
    const many = Array.from({ length: 301 }, (_, index) => modified(`docs/page-${index}.md`));
    expect(pick(many).mode).toBe("full");
  });

  it("runs no test for documentation no test reads, and the readers of documentation a test reads", () => {
    expect(pick([modified("docs/guide.md"), modified("CHANGELOG.md")])).toMatchObject({
      mode: "selected",
      unit: [],
      browser: [],
    });
    expect(pick([modified("README.md")])).toMatchObject({ mode: "selected", unit: [unitA] });
  });

  it("runs a changed test, a new test and a test whose map run failed", () => {
    const files = new Set([...headFiles, "typescript/tests/unit/new.test.ts"]);
    const selection = pick([modified(unitB)], { map: { ...map, failed: [0] }, files });
    expect(selection).toMatchObject({
      mode: "selected",
      unit: [unitB, "typescript/tests/unit/new.test.ts"],
      browser: [specC],
    });
  });

  it("counts a new file in a folder a test lists, and a new file another changed file names", () => {
    expect(pick([added("typescript/authoring/core/NEW.md")])).toMatchObject({
      mode: "selected",
      browser: [specC],
    });
    const head = { "typescript/src/only-b.ts": 'import { x } from "./helper.js";' };
    const files = new Set([...headFiles, "typescript/src/helper.ts"]);
    expect(
      pick([modified("typescript/src/only-b.ts"), added("typescript/src/helper.ts")], {
        files,
        head,
      }),
    ).toMatchObject({
      mode: "selected",
      unit: [unitB],
    });
    expect(
      pick([added("typescript/src/orphan.ts")], {
        files: new Set([...headFiles, "typescript/src/orphan.ts"]),
      }).mode,
    ).toBe("full");
  });

  it("runs everything for a new file only documentation or a bare word names", () => {
    const files = new Set([...headFiles, "typescript/src/x.ts", "docs/guide.md"]);
    // Documentation that mentions the file, and code that uses its name only as a word.
    const head = {
      "docs/guide.md": "See ./x.ts for details.",
      "typescript/src/only-b.ts": "const x = 1; // x marks the spot",
    };
    const changes = [
      added("typescript/src/x.ts"),
      modified("docs/guide.md"),
      modified("typescript/src/only-b.ts"),
    ];
    expect(pick(changes, { files, head }).mode).toBe("full");
  });

  it("counts a new or deleted file below a folder a test lists as a whole tree", () => {
    const withTree: TestMap = { ...map, folders: { "typescript/authoring/": [2] } };
    const tree: TestMap = { ...map, folders: { "typescript/authoring/**": [2] } };
    const nested = "typescript/authoring/deep/nested/NEW.md";
    // A listing of only the top folder doesn't show a file two folders down.
    expect(pick([added(nested)], { map: withTree }).mode).toBe("full");
    expect(pick([added(nested)], { map: tree })).toMatchObject({ mode: "selected", unit: [unitB] });
    expect(pick([{ status: "deleted", path: nested }], { map: tree })).toMatchObject({
      unit: [unitB],
    });
    const wholeRepository: TestMap = { ...map, folders: { "**": [1] } };
    expect(pick([added("examples/new-example.ts")], { map: wholeRepository })).toMatchObject({
      mode: "selected",
      unit: [unitA],
    });
  });

  it("treats a rename as a deletion and an addition, each with its own readers", () => {
    const files = new Set([...headFiles, "typescript/authoring/core/RENAMED.md"]);
    const selection = pick(
      [
        { status: "deleted", path: "typescript/src/only-b.ts" },
        added("typescript/authoring/core/RENAMED.md"),
      ],
      { files },
    );
    expect(selection).toMatchObject({ mode: "selected", unit: [unitB], browser: [specC] });
  });

  it("runs everything when a code change would otherwise run no test", () => {
    // The only test that read the file is deleted along with it.
    const files = new Set([unitA, specC, "typescript/src/shared.ts"]);
    const selection = pick(
      [
        { status: "deleted", path: "typescript/src/only-b.ts" },
        { status: "deleted", path: unitB },
      ],
      { files },
    );
    expect(selection.mode).toBe("full");
  });

  it("also runs the tests that reach what changed on the base after the map was built", () => {
    // The map predates a base commit that changed a file the browser test reads, added a test and
    // touched the toolchain and a file no test read. The pull request changes only one file.
    const unitD = "typescript/tests/unit/d.test.ts";
    const files = new Set([...headFiles, unitD, "package.json", "typescript/src/unread.ts"]);
    const drift = [
      modified("typescript/src/shared.ts"),
      added(unitD),
      modified("package.json"),
      modified("typescript/src/unread.ts"),
    ];
    expect(pick([modified("typescript/src/only-b.ts")], { files, drift })).toMatchObject({
      mode: "selected",
      unit: [unitA, unitB, unitD],
      browser: [specC],
    });
    // What the base changed never hides a pull request's own empty selection.
    const emptied = pick(
      [
        { status: "deleted", path: "typescript/src/only-b.ts" },
        { status: "deleted", path: unitB },
      ],
      { files: new Set([unitA, specC, "typescript/src/shared.ts"]), drift },
    );
    expect(emptied.mode).toBe("full");
  });
});

describe("job inputs", () => {
  const selected = {
    mode: "selected",
    reasons: [],
    mapSha: null,
    unit: [unitA],
    browser: ["typescript/tests/browser/foo.spec.ts"],
  } as const;

  it("run the selection only when it is enforced, and every test otherwise", () => {
    expect(jobInputs(selected, false)).toEqual({ run: "full", unit: [], browser: [] });
    expect(jobInputs({ ...selected, mode: "full" }, true)).toEqual({
      run: "full",
      unit: [],
      browser: [],
    });
    const enforced = jobInputs(selected, true);
    expect(enforced).toMatchObject({ run: "selected", unit: [unitA] });
  });

  it("filter Playwright to each selected spec file and no file whose name ends the same way", () => {
    // Playwright reads each filter as a regular expression over the absolute file path.
    const [filter = ""] = jobInputs(selected, true).browser;
    const matches = (path: string) => new RegExp(filter, "giu").test(path);
    expect(matches("/checkout/typescript/tests/browser/foo.spec.ts")).toBe(true);
    expect(matches("/checkout/typescript/tests/browser/other-foo.spec.ts")).toBe(false);
    expect(matches("/checkout/typescript/tests/browser/fooXspec.ts")).toBe(false);
  });
});

describe("guard", () => {
  const empty = { mode: "selected", reasons: [], mapSha: null, unit: [], browser: [] } as const;
  it("fails an empty selection for a change to more than documentation, whatever chose it", () => {
    expect(guard(empty, [modified("typescript/src/only-b.ts")])).toContain("runs no test");
    expect(guard(empty, [modified("docs/guide.md")])).toBeUndefined();
    expect(
      guard({ ...empty, mode: "full" }, [modified("typescript/src/only-b.ts")]),
    ).toBeUndefined();
  });
});

describe("map building", () => {
  it("counts built files as their sources and drops guesses and folders every test lists", () => {
    const tracked = new Set([
      "typescript/src/a.ts",
      "typescript/src/b.ts",
      "typescript/authoring/x.md",
      "typescript/tests/unit/a.test.ts",
    ]);
    const recorded = [
      "dist/typescript/src/a.js",
      "dist/runtime-sources.json",
      "typescript/src/a.jsx",
      "typescript/src//",
      "node_modules",
      "dist/typescript/authoring/x.md",
    ];
    const { files, folders } = normalize(
      recorded,
      tracked,
      () => ["typescript/src/b.ts"],
      () => false,
    );
    expect([...files].toSorted()).toEqual([
      "typescript/authoring/x.md",
      "typescript/src/a.ts",
      "typescript/src/b.ts",
    ]);
    expect([...folders]).toEqual(["typescript/src/"]);
    // A built file with no source of its own stands for every source file.
    expect(
      normalize(
        ["dist/generated.json"],
        tracked,
        () => [],
        () => true,
      ).files.size,
    ).toBe(3);

    const built = merge("2".repeat(40), [
      {
        tests: {
          [unitA]: {
            passed: true,
            seconds: 1,
            files: ["typescript/src/a.ts"],
            folders: ["typescript/tests/unit/", "typescript/src/"],
          },
        },
      },
      {
        tests: {
          [unitB]: {
            passed: false,
            seconds: 1,
            files: ["typescript/src/a.ts"],
            folders: ["typescript/tests/unit/"],
          },
        },
      },
    ]);
    expect(built).toEqual({
      version: 1,
      sha: "2".repeat(40),
      tests: [unitA, unitB],
      failed: [1],
      files: { "typescript/src/a.ts": [0, 1] },
      folders: { "typescript/src/": [0] },
    });
  });

  it("adds up a spec file's seconds across the shards that split it", () => {
    const shard = (duration: number, ok: boolean) => ({
      suites: [
        {
          file: "c.spec.ts",
          specs: [{ ok, file: "c.spec.ts", tests: [{ results: [{ duration }] }] }],
        },
      ],
    });
    const selection = {
      mode: "selected",
      reasons: [],
      mapSha: null,
      unit: [],
      browser: [],
    } as const;
    expect(compare(selection, [shard(1000, true), shard(3000, false)])).toMatchObject({
      failed: [specC],
      missed: [specC],
      browser: { selectedSeconds: 0, totalSeconds: 4 },
    });
  });

  it("reads failed test files and their seconds from Vitest and Playwright results", () => {
    // The job that ran the tests may have had its checkout elsewhere than the reader's.
    const vitest = {
      testResults: [
        {
          name: "/runner/a/repo/typescript/tests/unit/a.test.ts",
          status: "failed",
          startTime: 1000,
          endTime: 3500,
        },
        { name: "/runner/a/repo/typescript/tests/unit/b.test.ts", status: "passed" },
      ],
    };
    const playwright = {
      suites: [
        {
          file: "c.spec.ts",
          specs: [
            {
              ok: false,
              file: "c.spec.ts",
              tests: [{ results: [{ duration: 1500 }, { duration: 500 }] }],
            },
          ],
          suites: [],
        },
        { file: "d.spec.ts", specs: [{ ok: true, file: "d.spec.ts" }] },
      ],
    };
    expect(readResults(vitest)).toEqual({ failed: [unitA], seconds: { [unitA]: 2.5 } });
    expect(readResults(playwright)).toEqual({ failed: [specC], seconds: { [specC]: 2 } });
  });
});

describe("trace preload", () => {
  it("records what processes and threads load, read, list and copy, without changing results", () => {
    const root = temporary();
    const out = temporary();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("lib/imported.mjs", "export const value = 1;\n");
    for (const path of [
      "data/computed.txt",
      "data/child.txt",
      "data/worker.txt",
      "data/echoed.txt",
      "data/listed/item.txt",
      "data/tree/deep/item.txt",
      "data/held/inside.txt",
      "data/copied/deep/item.txt",
    ])
      write(path, "text\n");
    const reading = (path: string) =>
      `import { readFileSync } from "node:fs";\nreadFileSync(new URL("${path}", import.meta.url));\n`;
    write("child.mjs", reading("./data/child.txt"));
    write("worker.mjs", reading("./data/worker.txt"));
    write("echo.mjs", `${reading("./data/echoed.txt")}process.stdout.write("hi");\n`);
    write(
      "main.mjs",
      `
import { closeSync, cpSync, openSync, readFileSync, readdirSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { value } from "./lib/imported.mjs";
const here = (path) => new URL(path, import.meta.url);
const name = ["comp", "uted"].join("");
readFileSync(here(\`./data/\${name}.txt\`));
readdirSync(here("./data/listed/"));
readdirSync(here("./data/tree/"), { recursive: true });
cpSync(here("./data/copied/"), join(tmpdir(), "test-map-copy-" + process.pid), { recursive: true });
// Scoped reads on Linux open a file below a held folder descriptor.
if (process.platform === "linux") {
  const fd = openSync(here("./data/held/"), "r");
  readFileSync(\`/proc/self/fd/\${fd}/inside.txt\`);
  closeSync(fd);
}
const child = spawnSync(process.execPath, [here("./child.mjs").pathname], { env: { PATH: process.env.PATH } });
await new Promise((done, fail) => {
  const worker = new Worker(here("./worker.mjs"), { execArgv: [], env: {} });
  worker.on("exit", done);
  worker.on("error", fail);
});
// Results and errors stay as they are untraced.
readdirSync(here("./"), { recursive: true });
const echoed = await promisify(execFile)(process.execPath, [here("./echo.mjs").pathname], { env: { PATH: process.env.PATH } });
let code;
try { readFileSync("file://host/missing"); } catch (error) { code = error.code; }
console.log(JSON.stringify({ status: child.status, value, stdout: echoed.stdout, code }));
`,
    );
    const run = spawnSync(process.execPath, [join(root, "main.mjs")], {
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_OPTIONS: `--import ${preload}`,
        TEST_MAP_OUT: out,
        TEST_MAP_ROOT: root,
      },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ status: 0, value: 1, stdout: "hi", code: "ENOENT" });
    const recorded = new Set(
      readdirSync(out).flatMap((file) => readFileSync(join(out, file), "utf8").split("\n")),
    );
    for (const path of [
      "main.mjs",
      "lib/imported.mjs",
      "data/computed.txt",
      "data/listed/",
      "data/tree/**",
      "data/copied/deep/item.txt",
      "child.mjs",
      "data/child.txt",
      "worker.mjs",
      "data/worker.txt",
      "echo.mjs",
      "data/echoed.txt",
      "**",
      ...(process.platform === "linux" ? ["data/held/inside.txt"] : []),
    ])
      expect(recorded).toContain(path);
  });
});

describe("select and guard commands", () => {
  it("select a change's tests from git, and guard rejects an empty selection for code", () => {
    const repo = temporary();
    // The host's own git configuration, such as commit signing, stays out of the scenario.
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    for (const path of headFiles) write(path, "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("typescript/src/only-b.ts", "export const changed = true;\n");
    git("commit", "-q", "-am", "change");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "map.json"), JSON.stringify({ ...map, sha: base }));
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "" },
      });

    // The workflow's script downloads the newest map through gh, selects and guards; a stand-in
    // gh serves the map. Enforced, it hands the test jobs the selection as step outputs.
    const bin = temporary();
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = api ]; then echo 42; exit; fi',
        'while [ $# -gt 0 ]; do if [ "$1" = -D ]; then dir="$2"; fi; shift; done',
        'mkdir -p "$dir" && cp "$MAP" "$dir/test-map.json"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const outputs = join(repo, "outputs.txt");
    const selected = spawnSync("bash", [selectScript, repo], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        MAP: join(repo, "map.json"),
        REPO: "example-org/example-repo",
        BASE: base,
        HEAD: head,
        ENFORCE: "true",
        GITHUB_OUTPUT: outputs,
      },
    });
    expect(selected.status, selected.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, "selection.json"), "utf8"))).toMatchObject({
      mode: "selected",
      unit: [unitB],
      browser: [],
    });
    expect(readFileSync(outputs, "utf8")).toContain(`run=selected\nunit=["${unitB}"]\nbrowser=[]`);
    expect(
      cli("guard", "--selection", "selection.json", "--base", base, "--head", head).status,
    ).toBe(0);

    writeFileSync(
      join(repo, "empty.json"),
      JSON.stringify({ mode: "selected", reasons: [], mapSha: null, unit: [], browser: [] }),
    );
    const rejected = cli("guard", "--selection", "empty.json", "--base", base, "--head", head);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toContain("runs no test");

    // The tests run on the merge of the pull request into a base that moved on since the map: a
    // commit there changed a file two tests read and added a test, and both reach the selection.
    git("checkout", "-q", "-b", "moved", base);
    write("typescript/src/shared.ts", "export const moved = true;\n");
    write("typescript/tests/unit/d.test.ts", "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "moved");
    const movedBase = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", "-m", "merge", head);
    const merged = cli(
      "select",
      ...["--map", "map.json", "--base", movedBase, "--head", head],
      ...["--tested", git("rev-parse", "HEAD"), "--out", "merged.json"],
    );
    expect(merged.status, merged.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, "merged.json"), "utf8"))).toMatchObject({
      mode: "selected",
      unit: [unitA, unitB, "typescript/tests/unit/d.test.ts"],
      browser: [specC],
    });

    // No map, a map off the base's history and a stale map all select everything.
    expect(readMap(join(repo, "missing.json"), base, repo)).toBe("no test map");
    writeFileSync(join(repo, "foreign.json"), JSON.stringify(map));
    expect(readMap(join(repo, "foreign.json"), base, repo)).toContain("not on the base's history");
    const later = `@${Number(git("show", "-s", "--format=%ct", base)) + 4 * 86_400} +0000`;
    const env = { ...gitEnv, GIT_COMMITTER_DATE: later };
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "later"], { cwd: repo, env });
    expect(readMap(join(repo, "map.json"), git("rev-parse", "HEAD"), repo)).toContain("days older");
  });
});
