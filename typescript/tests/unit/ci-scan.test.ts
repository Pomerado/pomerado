import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../tools/ci-scan.sh", import.meta.url));
const missing = "0123456789abcdef0123456789abcdef01234567";
const zeros = "0".repeat(40);
const treeScan = "dir --config .gitleaks.toml --redact --no-banner .";
const rangeScan = (range: string) =>
  `git --config .gitleaks.toml --redact --no-banner --log-opts=${range} .`;

interface Event {
  readonly EVENT?: string;
  readonly REF?: string;
  readonly PR_BASE?: string;
  readonly PR_HEAD?: string;
  readonly PUSH_BEFORE?: string;
  readonly PUSH_AFTER?: string;
  readonly GITLEAKS_EXIT?: string;
}

describe("CI scan steps", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** A repository with two commits, and a stand-in for gitleaks that logs each call. */
  const setup = (message = "Change") => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-scan-"));
    const tools = mkdtempSync(join(tmpdir(), "ci-scan-tools-"));
    directories.push(cwd, tools);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd, encoding: "utf8" },
      ).trim();
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "--message", "Base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--quiet", "--allow-empty", "--message", message);
    const head = git("rev-parse", "HEAD");
    const log = join(tools, "calls.log");
    const gitleaks = join(tools, "gitleaks");
    writeFileSync(gitleaks, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit "\${GITLEAKS_EXIT:-0}"\n`);
    chmodSync(gitleaks, 0o755);
    const run = (mode: string, event: Event) => {
      rmSync(log, { force: true });
      const result = spawnSync("bash", [script, mode], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "",
          GITLEAKS: gitleaks,
          EVENT: "",
          REF: "",
          PR_BASE: "",
          PR_HEAD: "",
          PUSH_BEFORE: "",
          PUSH_AFTER: "",
          ...event,
        },
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
    };
    return { base, head, run };
  };

  it("scans a pull request's commits and its tree", () => {
    const { base, head, run } = setup();
    const result = run("secrets", { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([rangeScan(`${base}..${head}`), treeScan]);
  });

  it("scans the commits pushed to main and the tree", () => {
    const { base, head, run } = setup();
    const push = { EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: base, PUSH_AFTER: head };
    const result = run("secrets", push);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([rangeScan(`${base}..${head}`), treeScan]);
  });

  it("scans only the tree for a release tag push, without a warning", () => {
    const { head, run } = setup();
    const tag = { EVENT: "push", REF: "refs/tags/v1.0.0", PUSH_BEFORE: zeros, PUSH_AFTER: head };
    const result = run("secrets", tag);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([treeScan]);
    expect(result.stderr).toBe("");
  });

  it("warns and scans only the tree when a force push left no earlier commit", () => {
    const { head, run } = setup();
    const push = { EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: missing, PUSH_AFTER: head };
    const result = run("secrets", push);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([treeScan]);
    expect(result.stderr).toContain("::warning::");
  });

  // Each case builds its event from the repository's base and head commits.
  it.each<[string, (base: string, head: string) => Event]>([
    ["a pull request base missing from the checkout", (_base, head) => ({ EVENT: "pull_request", PR_BASE: missing, PR_HEAD: head })],
    ["an empty pull request base", (_base, head) => ({ EVENT: "pull_request", PR_HEAD: head })],
    ["a pull request head missing from the checkout", (base) => ({ EVENT: "pull_request", PR_BASE: base, PR_HEAD: missing })],
    ["a pushed commit missing from the checkout", (base) => ({ EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: base, PUSH_AFTER: missing })],
  ])("fails before any scan for %s", (_label, event) => {
    const { base, head, run } = setup();
    for (const mode of ["range", "secrets", "content"]) {
      const result = run(mode, event(base, head));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::");
      expect(result.calls).toEqual([]);
    }
  });

  it("fails when gitleaks reports a finding", () => {
    const { base, head, run } = setup();
    const pullRequest = { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head, GITLEAKS_EXIT: "1" };
    expect(run("secrets", pullRequest).status).toBe(1);
    const tag = { EVENT: "push", REF: "refs/tags/v1.0.0", PUSH_AFTER: head, GITLEAKS_EXIT: "1" };
    expect(run("secrets", tag).status).toBe(1);
  });

  it("prints the range it scans", () => {
    const { base, head, run } = setup();
    expect(run("range", { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head }).stdout).toBe(
      `${base}..${head}\n`,
    );
    expect(run("range", { EVENT: "workflow_dispatch" }).stdout).toBe("\n");
  });

  it("gives the content scan the same range", () => {
    const clean = setup();
    const event = { EVENT: "pull_request", PR_BASE: clean.base, PR_HEAD: clean.head };
    expect(clean.run("content", event).status).toBe(0);
    const flagged = setup(["Address review ", "P2", "-1"].join(""));
    const result = flagged.run("content", { ...event, PR_BASE: flagged.base, PR_HEAD: flagged.head });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`commit ${flagged.head.slice(0, 12)}:1:`);
  });

  it("exits with a usage error for an unknown mode", () => {
    expect(setup().run("all", {}).status).toBe(2);
  });
});
