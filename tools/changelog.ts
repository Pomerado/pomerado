/**
 * Changelog fragments. Each pull request records its user-facing change in its own file under
 * `changes/`, rather than editing CHANGELOG.md, so open pull requests don't conflict with each other
 * over the top of `## Unreleased`. A fragment names its section in a small header:
 *
 *   ---
 *   section: Fixes
 *   ---
 *
 *   - What changed, for someone who uses the package.
 *     - A detail or a migration step.
 *
 * The section is one of `sections`. The body is one or more `- ` entries, each with any lines
 * indented under it. changes/README.md says the same for contributors.
 *
 * Usage, from the repository root:
 *   node tools/changelog.ts check            check every fragment in changes/
 *   node tools/changelog.ts assemble         move every fragment into CHANGELOG.md's Unreleased
 *   node tools/changelog.ts release X.Y.Z    assemble, then rename Unreleased to X.Y.Z under a
 *                                            new, empty Unreleased
 *
 * Assembling puts each fragment at the top of its section, above the entries already there, newest
 * first, as entries were written by hand before. A fragment's age is when it reached the current
 * branch's first-parent history, which for `main` is when its pull request merged. An uncommitted
 * fragment counts as newest. Fragments git can't tell apart, as in a shallow clone, go by file name.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** CHANGELOG.md's sections, in the order a release lists them. */
export const sections = ["Breaking changes", "Other changes", "Fixes"] as const;
export type Section = (typeof sections)[number];

export interface Fragment {
  /** The file name under changes/. */
  readonly name: string;
  readonly section: Section;
  /** The entries, without leading or trailing blank lines. */
  readonly body: string;
}

const fragmentName = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
const isSection = (value: string): value is Section => (sections as readonly string[]).includes(value);

/** Reads one fragment, or throws an error that says what is wrong with it. */
export const parseFragment = (name: string, text: string): Fragment => {
  const fail: (problem: string) => never = (problem) => {
    throw new Error(`changes/${name}: ${problem}`);
  };
  if (!fragmentName.test(name))
    fail("the file name must be a short slug of lowercase letters, digits and dashes, ending in .md");
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const section = /^section: (.+)$/u.exec(lines[1] ?? "")?.[1]?.trim();
  if (lines[0] !== "---" || section === undefined || lines[2] !== "---")
    fail("start with a header of three lines: ---, section: <section>, ---");
  if (section === undefined || !isSection(section))
    fail(`the section must be one of ${sections.slice(0, -1).join(", ")} or ${sections.at(-1)}`);
  const body = lines.slice(3).join("\n").replace(/^\n+/u, "").trimEnd();
  if (body === "") fail("has no entry under its header");
  const stray = body.split("\n").find((line) => line !== "" && !line.startsWith("- ") && !/^\s/u.test(line));
  if (!body.startsWith("- ") || stray !== undefined)
    fail(`every entry starts with "- ", and its other lines are indented under it: ${stray ?? body.split("\n")[0]}`);
  return { name, section, body };
};

const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";

/** Inserts `block` at `index`, with a blank line before it after text and a blank line before a heading. */
const insert = (lines: string[], index: number, block: readonly string[]) => {
  const before = index > 0 && !isBlank(lines[index - 1]) ? [""] : [];
  const after = lines[index]?.startsWith("#") ? [""] : [];
  lines.splice(index, 0, ...before, ...block, ...after);
};

const unreleased = (lines: readonly string[]) => {
  const start = lines.indexOf("## Unreleased");
  if (start === -1) throw new Error("CHANGELOG.md has no `## Unreleased` heading to add changes under.");
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return { start, end: next === -1 ? lines.length : next };
};

/**
 * Adds fragments to the changelog's `## Unreleased`. Each goes at the top of its section, above the
 * entries already there, in the order given, so pass the newest first. A missing section is added in
 * the order of `sections`.
 */
export const assemble = (changelog: string, fragments: readonly Fragment[]): string => {
  const lines = changelog.replace(/\n$/u, "").split("\n");
  unreleased(lines);
  if (fragments.length === 0) return changelog;
  for (const [order, section] of sections.entries()) {
    const entries = fragments.filter((fragment) => fragment.section === section).flatMap((fragment) => fragment.body.split("\n"));
    if (entries.length === 0) continue;
    const { start, end } = unreleased(lines);
    const heading = lines.findIndex((line, index) => index > start && index < end && line === `### ${section}`);
    if (heading !== -1) {
      let index = heading + 1;
      while (index < end && isBlank(lines[index])) index += 1;
      insert(lines, index, entries);
      continue;
    }
    const later = new Set(sections.slice(order + 1).map((name) => `### ${name}`));
    let index = lines.findIndex((line, at) => at > start && at < end && later.has(line));
    if (index === -1) {
      index = end;
      while (index > start + 1 && isBlank(lines[index - 1])) index -= 1;
    }
    insert(lines, index, [`### ${section}`, "", ...entries]);
  }
  return `${lines.join("\n")}\n`;
};

/** Renames `## Unreleased` to `## <version>` and starts a new, empty `## Unreleased` above it. */
export const release = (changelog: string, version: string): string => {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version))
    throw new Error(`${version} is not a plain X.Y.Z release version.`);
  const lines = changelog.replace(/\n$/u, "").split("\n");
  if (lines.includes(`## ${version}`)) throw new Error(`CHANGELOG.md already has a ## ${version} heading.`);
  const { start } = unreleased(lines);
  lines.splice(start, 1, "## Unreleased", "", `## ${version}`);
  return `${lines.join("\n")}\n`;
};

/** When each path under changes/ was added, newest first, as git's first-parent history shows. */
const addedAt = (): Map<string, number> => {
  const added = new Map<string, number>();
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["log", "--first-parent", "--diff-filter=A", "--name-only", "--format=%x00%ct", "--", "changes"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return added;
  }
  for (const commit of log.split("\0").slice(1)) {
    const [time, ...paths] = commit.split("\n");
    for (const path of paths.filter((path) => path !== ""))
      if (!added.has(path)) added.set(path, Number(time));
  }
  return added;
};

const changes = "changes";

/** Every fragment under changes/, newest first, and the problems of those that don't parse. */
const readFragments = () => {
  const fragments: Fragment[] = [];
  const problems: string[] = [];
  const names = (existsSync(changes) ? readdirSync(changes, { withFileTypes: true }) : [])
    .filter((entry) => entry.name !== "README.md")
    .map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`));
  for (const name of names) {
    try {
      fragments.push(parseFragment(name, name.endsWith("/") ? "" : readFileSync(join(changes, name), "utf8")));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const added = addedAt();
  const age = (fragment: Fragment) => added.get(`${changes}/${fragment.name}`) ?? Number.POSITIVE_INFINITY;
  fragments.sort((a, b) => age(b) - age(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { fragments, problems };
};

if (import.meta.main) {
  const [command, version] = process.argv.slice(2);
  const { fragments, problems } = readFragments();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error("changes/README.md shows how to write a fragment.");
    process.exit(1);
  }
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  try {
    if (command === "check") {
      assemble(changelog, fragments);
      console.log(`${fragments.length} changelog fragment${fragments.length === 1 ? " is" : "s are"} well formed.`);
    } else if (command === "assemble" || (command === "release" && version !== undefined)) {
      const assembled = assemble(changelog, fragments);
      writeFileSync("CHANGELOG.md", command === "release" ? release(assembled, version ?? "") : assembled);
      for (const fragment of fragments) rmSync(join(changes, fragment.name));
      console.log(
        `Moved ${fragments.length} changelog fragment${fragments.length === 1 ? "" : "s"} into CHANGELOG.md` +
          (command === "release" ? `, under ## ${version}.` : "."),
      );
    } else {
      console.error("Usage: node tools/changelog.ts check | assemble | release X.Y.Z");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
