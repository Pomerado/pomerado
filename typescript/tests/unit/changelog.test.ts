import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assemble, parseFragment, release, type Fragment } from "../../../tools/changelog.js";

const script = fileURLToPath(new URL("../../../tools/changelog.ts", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const lines = (...text: string[]) => `${text.join("\n")}\n`;

const changelog = lines(
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Breaking changes",
  "",
  "- An older breaking change.",
  "  - Migrate by doing the older thing.",
  "",
  "### Fixes",
  "",
  "- An older fix.",
  "",
  "## 0.1.0",
  "",
  "### Fixes",
  "",
  "- A released fix.",
);

const fragment = (name: string, section: Fragment["section"], ...body: string[]): Fragment => ({
  name,
  section,
  body: body.join("\n"),
});

describe("assemble", () => {
  it("puts fragments above the entries already in their sections, and adds a missing section in order", () => {
    const result = assemble(changelog, [
      fragment("newest-fix.md", "Fixes", "- The newest fix."),
      fragment("new-option.md", "Other changes", "- A new option."),
      fragment("renamed-export.md", "Breaking changes", "- A renamed export.", "  - Migrate by renaming the import."),
      fragment("older-fix.md", "Fixes", "- A fix merged earlier."),
    ]);
    expect(result).toBe(
      lines(
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "### Breaking changes",
        "",
        "- A renamed export.",
        "  - Migrate by renaming the import.",
        "- An older breaking change.",
        "  - Migrate by doing the older thing.",
        "",
        "### Other changes",
        "",
        "- A new option.",
        "",
        "### Fixes",
        "",
        "- The newest fix.",
        "- A fix merged earlier.",
        "- An older fix.",
        "",
        "## 0.1.0",
        "",
        "### Fixes",
        "",
        "- A released fix.",
      ),
    );
  });

  it("fills an empty Unreleased, keeping its introduction first", () => {
    const empty = lines("# Changelog", "", "## Unreleased", "", "This line is next.", "", "## 0.1.0", "", "- A released fix.");
    expect(
      assemble(empty, [
        fragment("fix.md", "Fixes", "- A fix."),
        fragment("breaking.md", "Breaking changes", "- A breaking change."),
      ]),
    ).toBe(
      lines(
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "This line is next.",
        "",
        "### Breaking changes",
        "",
        "- A breaking change.",
        "",
        "### Fixes",
        "",
        "- A fix.",
        "",
        "## 0.1.0",
        "",
        "- A released fix.",
      ),
    );
  });

  it("leaves the changelog unchanged with no fragments, and refuses one without Unreleased", () => {
    expect(assemble(changelog, [])).toBe(changelog);
    expect(() => assemble(lines("# Changelog", "", "## 0.1.0"), [fragment("a.md", "Fixes", "- A fix.")])).toThrow(
      "## Unreleased",
    );
  });
});

describe("release", () => {
  it("renames Unreleased to the version under a new, empty Unreleased", () => {
    const released = release(assemble(changelog, [fragment("fix.md", "Fixes", "- A fix.")]), "0.2.0");
    expect(released.startsWith(lines("# Changelog", "", "## Unreleased", "", "## 0.2.0", "", "### Breaking changes"))).toBe(
      true,
    );
    expect(released).toContain(lines("### Fixes", "", "- A fix.", "- An older fix.", "", "## 0.1.0"));
    // The next fragment goes under the new Unreleased, not into the release.
    expect(assemble(released, [fragment("next.md", "Fixes", "- The next fix.")])).toContain(
      lines("## Unreleased", "", "### Fixes", "", "- The next fix.", "", "## 0.2.0"),
    );
  });

  it("refuses an Unreleased with no change in it", () => {
    const empty = lines("# Changelog", "", "## Unreleased", "", "## 0.1.0", "", "- A released fix.");
    expect(() => release(empty, "0.2.0")).toThrow("no change");
    expect(release(assemble(empty, [fragment("fix.md", "Fixes", "- A fix.")]), "0.2.0")).toContain(
      lines("## Unreleased", "", "## 0.2.0", "", "### Fixes", "", "- A fix.", "", "## 0.1.0"),
    );
  });

  it("refuses a version that is already there or isn't a plain X.Y.Z", () => {
    expect(() => release(changelog, "0.1.0")).toThrow("already");
    for (const version of ["0.2", "v0.2.0", "0.2.0-canary.1", "01.2.0"])
      expect(() => release(changelog, version)).toThrow("X.Y.Z");
  });
});

describe("parseFragment", () => {
  it("reads the section and the entries", () => {
    expect(
      parseFragment("renamed-export.md", "---\r\nsection: Breaking changes\r\n---\r\n\r\n- A change.\r\n  - Migrate.\r\n\r\n"),
    ).toEqual(fragment("renamed-export.md", "Breaking changes", "- A change.", "  - Migrate."));
  });

  it("refuses a malformed fragment and says why", () => {
    const refusals: [name: string, text: string, reason: string][] = [
      ["Bad_Name.md", "---\nsection: Fixes\n---\n- A fix.\n", "file name"],
      ["fix.txt", "---\nsection: Fixes\n---\n- A fix.\n", "file name"],
      ["fix.md", "- A fix.\n", "header"],
      ["fix.md", "---\nsection: Bug fixes\n---\n- A fix.\n", "Breaking changes, Other changes or Fixes"],
      ["fix.md", "---\nsection: Fixes\nextra: yes\n---\n- A fix.\n", "header"],
      ["fix.md", "---\nsection: Fixes\n---\n\n", "no entry"],
      ["fix.md", "---\nsection: Fixes\n---\nA fix.\n", "- "],
      ["fix.md", "---\nsection: Fixes\n---\n- A fix.\n\n## 0.2.0\n", "- "],
      ["fix.md", "---\nsection: Fixes\n---\n- A fix.\n### Fixes\n", "- "],
    ];
    for (const [name, text, reason] of refusals) expect(() => parseFragment(name, text), name + text).toThrow(reason);
  });
});

describe("the changelog command", () => {
  const repository = () => {
    const directory = mkdtempSync(join(tmpdir(), "changelog-test-"));
    directories.push(directory);
    // Each commit and merge takes the next minute, unless the test sets the clock.
    let time = 1_700_000_000;
    const clock = { set: (seconds: number) => (time = seconds) };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `${time} +0000`,
          GIT_COMMITTER_DATE: `${time} +0000`,
          GIT_MERGE_AUTOEDIT: "no",
        },
      });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(directory, "changes"));
    writeFileSync(join(directory, "changes/README.md"), "How to write a fragment.\n");
    writeFileSync(join(directory, "CHANGELOG.md"), changelog);
    git("add", "--all");
    git("commit", "--quiet", "-m", "Start");
    const commit = (file: string, text: string) => {
      writeFileSync(join(directory, file), text);
      git("add", "--all");
      time += 60;
      git("commit", "--quiet", "-m", `Change ${file}`);
    };
    const merge = (branch: string) => {
      time += 60;
      git("merge", "--quiet", "--no-ff", "-m", `Merge ${branch}`, branch);
    };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
    const read = () => readFileSync(join(directory, "CHANGELOG.md"), "utf8");
    return { directory, git, commit, merge, clock, run, read };
  };

  const fix = (entry: string) => `---\nsection: Fixes\n---\n- ${entry}\n`;

  it("orders fragments by when their pull requests merged, not when they were written or their names", () => {
    const { git, commit, merge, clock, run, read } = repository();
    git("switch", "--quiet", "--create", "written-first");
    commit("changes/zebra.md", fix("Written first, merged last."));
    git("switch", "--quiet", "main");
    git("switch", "--quiet", "--create", "written-last");
    clock.set(1_700_100_000);
    commit("changes/apple.md", fix("Written last, merged first."));
    git("switch", "--quiet", "main");
    merge("written-last");
    merge("written-first");

    expect(run("assemble")).toMatchObject({ status: 0 });
    expect(read()).toContain(
      lines("### Fixes", "", "- Written first, merged last.", "- Written last, merged first.", "- An older fix."),
    );
  });

  it("dates a renamed fragment from its rename", () => {
    const { git, commit, run, read } = repository();
    commit("changes/before-rename.md", fix("Renamed earlier."));
    git("mv", "changes/before-rename.md", "changes/renamed.md");
    commit("changes/renamed.md", fix("Renamed earlier."));
    commit("changes/later.md", fix("Added after the rename."));

    expect(run("assemble")).toMatchObject({ status: 0 });
    expect(read()).toContain(lines("- Added after the rename.", "- Renamed earlier.", "- An older fix."));
  });

  it("ignores dotfiles and editor backups, and prints its usage for an unknown command", () => {
    const { directory, commit, run } = repository();
    commit("changes/fix.md", fix("A fix."));
    for (const name of [".DS_Store", "fix.md~", "fix.md.swp", ".fix.md.swp"])
      writeFileSync(join(directory, "changes", name), "not a fragment");

    expect(run("check")).toMatchObject({ status: 0, stdout: "1 changelog fragment is well formed.\n" });
    for (const args of [[], ["publish"], ["release"], ["check", "extra"], ["release", "0.2.0", "extra"]])
      expect(run(...args)).toMatchObject({ status: 2, stderr: expect.stringContaining("Usage:") });
    expect(run("assemble")).toMatchObject({ status: 0 });
    expect(existsSync(join(directory, "changes/.DS_Store"))).toBe(true);
    expect(existsSync(join(directory, "changes/fix.md"))).toBe(false);
  });

  it("checks every fragment, assembles them newest first and deletes them, and cuts a release", () => {
    const { directory, commit, run } = repository();
    commit("changes/apple-fix.md", "---\nsection: Fixes\n---\n- The first fix merged.\n");
    commit("changes/zebra-fix.md", "---\nsection: Fixes\n---\n- The second fix merged.\n");
    writeFileSync(join(directory, "changes/uncommitted.md"), "---\nsection: Other changes\n---\n- Not yet committed.\n");

    expect(run("check")).toMatchObject({ status: 0 });
    writeFileSync(join(directory, "changes/broken.md"), "- No header.\n");
    const refused = run("check");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("changes/broken.md");
    expect(run("assemble").status).toBe(1);
    expect(readFileSync(join(directory, "CHANGELOG.md"), "utf8")).toBe(changelog);
    rmSync(join(directory, "changes/broken.md"));

    expect(run("assemble")).toMatchObject({ status: 0 });
    const assembled = readFileSync(join(directory, "CHANGELOG.md"), "utf8");
    expect(assembled).toContain(
      lines("### Other changes", "", "- Not yet committed.", "", "### Fixes", "", "- The second fix merged.", "- The first fix merged.", "- An older fix."),
    );
    for (const name of ["zebra-fix.md", "apple-fix.md", "uncommitted.md"])
      expect(existsSync(join(directory, "changes", name))).toBe(false);
    expect(existsSync(join(directory, "changes/README.md"))).toBe(true);

    commit("changes/after.md", "---\nsection: Fixes\n---\n- A fix for the next release.\n");
    expect(run("release", "0.1.0")).toMatchObject({ status: 1 });
    expect(existsSync(join(directory, "changes/after.md"))).toBe(true);
    expect(run("release", "0.2.0")).toMatchObject({ status: 0 });
    const released = readFileSync(join(directory, "CHANGELOG.md"), "utf8");
    expect(released).toContain(lines("## Unreleased", "", "## 0.2.0"));
    expect(released).toContain(lines("- A fix for the next release.", "- The second fix merged."));
    expect(existsSync(join(directory, "changes/after.md"))).toBe(false);
  });
});
