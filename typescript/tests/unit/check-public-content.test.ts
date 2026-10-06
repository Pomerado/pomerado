import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { maskGitHubMergeNumber, scanPath, scanText } from "../../../tools/check-public-content.js";

const script = fileURLToPath(new URL("../../../tools/check-public-content.ts", import.meta.url));

// Positive samples are joined from parts so this file passes the scan it tests.
const j = (...parts: readonly string[]): string => parts.join("");

const rulesIn = (text: string): string[] => scanText("sample", text).map((finding) => finding.rule);

describe("public content scan rules", () => {
  it.each([
    ["the hosting vendor's app domain", j("https://app-1a2b.on", "porter.run/health")],
    ["a test environment host", j("https://dashboard.test", ".pomerado.ai")],
    ["the staging host", j("staging", ".pomerado.ai")],
    ["the staging API host", j("curl https://api.staging", ".pomerado.ai/v1")],
    ["an internal host in a URL", j("http://db.", "internal:5432/app")],
    ["an internal host after URL credentials", j("redis://user:pw@cache.", "internal")],
    ["an internal host as a quoted value", j('host: "search.', 'internal"')],
    ["an internal host as an assigned value", j("API_HOST=api.svc.", "internal")],
    ["an internal host with a port", j("connect to queue.", "internal:5672 first")],
    ["an internal host in an email address", j("ops@corp.", "internal")],
  ])("flags %s", (_label, text) => {
    expect(rulesIn(text)).toEqual(["internal-hostname"]);
  });

  it.each([
    ["an IAM role ARN", j("arn:", "aws:iam::123456789012:role/deploy")],
    ["an ARN in another partition", j("arn:", "aws-us-gov:s3:::bucket")],
    ["an ECR registry host", j("123456789012", ".dkr.ecr.us-east-1.amazonaws.com/app")],
    ["an SQS queue URL", j("https://sqs.us-east-1.amazonaws", ".com/123456789012/jobs")],
    ["an account ID assignment", j("AWS_ACCOUNT", "_ID=123456789012")],
    ["an account ID property", j('"accountId', '": "123456789012"')],
    ["a Vercel project ID", j("prj", "_a1B2c3D4e5F6g7H8i9J0k1L2m3N4")],
    ["a Vercel team ID", j("team", "_Z9y8X7w6V5u4T3s2R1q0P9o8")],
    ["a Vercel org ID assignment", j("VERCEL_ORG", "_ID=abc123")],
    ["a Porter project ID assignment", j("PORTER_PROJECT", "_ID: 12345")],
    ["a Porter dashboard link", j("https://dashboard.porter", ".run/projects/12345/apps")],
  ])("flags %s", (_label, text) => {
    expect(rulesIn(text)).toEqual(["cloud-account-id"]);
  });

  it.each([
    ["a hash and digits after a name", j("// Fixed the race (Name, ", "#", "617)")],
    ["a hash and digits at a line start", j("#", "1234 follow-up")],
    ["a hash and digits in prose", j("This replaces the workaround from ", "#", "88.")],
    ["a hash and digits in a list", j("[", "#", "12, ", "#", "13]")],
    ["a hash and digits in a CSS-free comment", j("/* see ", "#", "617 */")],
    ["cross-repository shorthand", j("acme/private-repo", "#", "12")],
    ["a link into another repository of the organization", j("https://github.com/Pomerado/", "other-repo/pull/", "9")],
    ["a numbered pull request", j("as in PR", " 42")],
    ["a numbered pull request with a hash", j("PR", "#", "42")],
    ["a numbered issue", j("tracked in issue", " 7")],
    ["a numbered ticket", j("Ticket", " 301 covers this")],
  ])("flags %s", (_label, text) => {
    expect(rulesIn(text)).toEqual(["ticket-reference"]);
  });

  it.each([
    ["a review finding ID", j("Addresses review ", "P3", "-3")],
    ["a review finding with a label", j("review finding ", "R2", ".1")],
    ["a bare priority finding ID", j("(", "P1", "-4)")],
    ["a numbered review round", j("// Review round", " 1: cookie shapes")],
    ["a numbered review pass", j("found in review pass", " 2")],
    ["a review named by its round", j("from round", " 3 of review")],
  ])("flags %s", (_label, text) => {
    expect(rulesIn(text)).toEqual(["review-reference"]);
  });

  it.each([
    ["public example hosts", "https://example.com and http://localhost:3000/mcp"],
    ["the production site", "https://pomerado.ai/docs"],
    ["member access on a property named internal", "if (this.internal) return options.internal ? a : b;"],
    ["Docker's host name", "http://host.docker.internal:8080/"],
    ["the cloud metadata host", 'const metadata = "metadata.google.internal";'],
    ["UUIDs", "11111111-1111-4111-8111-111111111111"],
    ["plain twelve-digit numbers", "timestamp 170000000000 and 123456789012 bytes"],
    ["identifiers that start like Vercel IDs", "team_membershipsWithRoles and prj_short1"],
    ["secret references in workflows", "VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}"],
    ["CSS colour declarations", "color: #333; border: 1px solid #617; --accent: #1234;"],
    ["CSS gradients", "background: linear-gradient(90deg, #000 0%, #111111 100%);"],
    ["quoted colours", 'const fill = "#000000"; const tone = { color: "#617" };'],
    ["markdown headings", "## 2. Setup\n# Title"],
    ["a shebang", "#!/usr/bin/env node"],
    ["HTML entities", "&#123; and &#x7B;"],
    ["URL fragments", "https://example.com/docs/page#123 and /guide#42"],
    ["this repository's issue URL", "https://github.com/Pomerado/pomerado/issues/12#issuecomment-3"],
    ["this repository's shorthand", "Fixed in Pomerado/pomerado#12"],
    ["an upstream project's issue URL", "https://github.com/microsoft/playwright/issues/1234"],
    ["hex colours with letters", "the badge uses #1a2b3c and #fff"],
    ["Guardian review prose", "Every execution receives fresh Guardian review before it runs."],
    ["product version numbers", "ES2024, HTTP/2 and UTF-8 in round 2 of retries"],
  ])("allows %s", (_label, text) => {
    expect(scanText("sample", text)).toEqual([]);
  });

  it("reports the line, column and rule of each finding", () => {
    const text = j("first line\n", "second (Name, ", "#", "617)\n", "third arn:", "aws:s3:::x");
    expect(scanText("notes.md", text)).toEqual([
      expect.objectContaining({ source: "notes.md", line: 2, column: 15, rule: "ticket-reference" }),
      expect.objectContaining({ source: "notes.md", line: 3, column: 7, rule: "cloud-account-id" }),
    ]);
  });
});

describe("public content scan file names", () => {
  it.each([
    [".env", "env-file"],
    ["config/.env.local", "env-file"],
    [".env.production", "env-file"],
    [".envrc", "env-file"],
    ["deploy/prod.env", "env-file"],
    ["id_ed25519", "private-key-file"],
    ["home/.ssh/id_rsa", "private-key-file"],
    ["certs/server.pem", "private-key-file"],
    ["certs/server.key", "private-key-file"],
    ["signing/release.p12", "private-key-file"],
  ])("flags %s", (path, rule) => {
    expect(scanPath(path)).toEqual([expect.objectContaining({ source: path, rule })]);
  });

  it.each([
    ".env.example",
    "config/.env.sample",
    "id_ed25519.pub",
    "typescript/src/env.ts",
    "docs/environment.md",
    "keys.ts",
  ])("allows %s", (path) => {
    expect(scanPath(path)).toEqual([]);
  });
});

describe("GitHub merge titles", () => {
  const hash = "#";

  it.each([
    ["a merge commit title", j("Merge pull request ", hash, "12 from acme/topic\n\nAdd a scan")],
    ["a squashed title", j("Add a scan (", hash, "12)\n\n* Add a scan")],
  ])("blanks only the number in %s", (_label, message) => {
    const masked = maskGitHubMergeNumber(message);
    expect(masked).toHaveLength(message.length);
    expect(masked).not.toContain(hash);
    expect(scanText("commit", masked)).toEqual([]);
  });

  it.each([
    ["a number elsewhere in the title", j("Fix the race (Name, ", hash, "617) in checkout")],
    ["a number in the body", j("Add a scan\n\nFollows ", hash, "617 (", hash, "12)")],
    ["a merge title with more after the branch", j("Merge pull request ", hash, "12 from acme/topic and ", hash, "13")],
  ])("leaves %s alone", (_label, message) => {
    expect(maskGitHubMergeNumber(message)).toBe(message);
  });
});

describe("public content scan command", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  const repository = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "public-content-"));
    directories.push(directory);
    execFileSync("git", ["init", "--quiet", directory]);
    return directory;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd },
    );
  const commit = (cwd: string, message: string, committer = "test@example.com") => {
    git(cwd, "add", "--all");
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "--message", message],
      { cwd, env: { ...process.env, GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: committer } },
    );
  };
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

  it("passes a clean repository", () => {
    const cwd = repository();
    writeFileSync(join(cwd, "README.md"), "# Example\n\nSee https://example.com.\n");
    commit(cwd, "Add a readme");
    const result = run(cwd);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no findings");
  });

  it("fails on a tracked file and prints the location without the matched text", () => {
    const cwd = repository();
    const host = j("api.staging", ".pomerado.ai");
    writeFileSync(join(cwd, "notes.md"), `Clean line\nCall https://${host} first\n`);
    writeFileSync(join(cwd, ".env"), "TOKEN=\n");
    commit(cwd, "Add notes");
    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(".env env-file:");
    expect(result.stdout).toContain("notes.md:2:18 internal-hostname:");
    expect(result.stdout).not.toContain(host);
  });

  it("ignores untracked and binary files", () => {
    const cwd = repository();
    writeFileSync(join(cwd, "image.bin"), Buffer.from([0, ...Buffer.from(j("PR", " 42"))]));
    commit(cwd, "Add a binary file");
    writeFileSync(join(cwd, "scratch.md"), j("PR", " 42\n"));
    expect(run(cwd).status).toBe(0);
  });

  it("scans commit messages in the given range only", () => {
    const cwd = repository();
    commit(cwd, j("Older work for ticket", " 5"));
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    commit(cwd, "Clean change");
    expect(run(cwd, "--commits", `${base}..HEAD`).status).toBe(0);
    commit(cwd, j("Address review ", "P2", "-1"));
    const result = run(cwd, "--commits", `${base}..HEAD`);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^commit [0-9a-f]{12}:1:\d+ review-reference:/mu);
  });

  it("allows the pull request number in a merge GitHub made, and nowhere else", () => {
    const cwd = repository();
    commit(cwd, "Base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const mergeTitle = j("Merge pull request ", "#", "4 from acme/topic");
    commit(cwd, `${mergeTitle}\n\nAdd a scan`, "noreply@github.com");
    commit(cwd, j("Add a scan (", "#", "4)"), "noreply@github.com");
    expect(run(cwd, "--commits", `${base}..HEAD`).status).toBe(0);
    commit(cwd, mergeTitle);
    const result = run(cwd, "--commits", `${base}..HEAD`);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/ticket-reference/gu)).toHaveLength(1);
  });

  it("exits with a usage error for unknown arguments and a bad range", () => {
    const cwd = repository();
    commit(cwd, "Empty");
    expect(run(cwd, "--all").status).toBe(2);
    expect(run(cwd, "--commits").status).toBe(2);
    expect(run(cwd, "--commits", "missing..HEAD").status).toBe(2);
  });

  it("passes on its own source and tests", () => {
    for (const path of [script, fileURLToPath(import.meta.url)]) {
      expect(scanText(path, readFileSync(path, "utf8"))).toEqual([]);
    }
  });
});
