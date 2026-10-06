/**
 * Public content scan, run by the `content-scan` job in check.yml.
 *
 * This repository is public and is developed alongside private code. This scan fails on the generic
 * shapes of private material: internal hostnames, cloud account identifiers, internal ticket and
 * review references, and secret file names. The `secret-scan` job looks for credentials separately.
 *
 * Keep every rule generic. Never add a real customer, incident or teammate name to this file. It is
 * public, so a list of names would publish the very names it protects. A separate scan in the
 * private repository checks names before code reaches this one.
 *
 * Usage, from the repository root:
 *   node tools/check-public-content.ts                  scan every tracked file
 *   node tools/check-public-content.ts --commits A..B   also scan the messages of commits in A..B
 *
 * Findings print a location and a rule, not the matched text, because CI logs are public too.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface Finding {
  /** A tracked path, or `commit <sha>` for a commit message. */
  readonly source: string;
  /** 1-based. Zero for a finding about a file's name. */
  readonly line: number;
  /** 1-based. Zero for a finding about a file's name. */
  readonly column: number;
  readonly rule: string;
  readonly message: string;
}

interface Rule {
  readonly id: string;
  readonly message: string;
  /** Global regular expressions, matched one line at a time. */
  readonly patterns: readonly RegExp[];
  /** Lets one match through. `before` is the text on the same line ahead of the match. */
  readonly allowed?: (match: string, before: string) => boolean;
}

/** One or more hostname labels, then the `.internal` suffix as the last label. */
const internalHost = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+internal(?![\w.-])`;

/** Well-known public names under `.internal` that describe no private infrastructure. */
const publicInternalHost = /^(?:(?:host|gateway|kubernetes)\.docker|metadata\.google)\.internal$/iu;

/** Text ahead of a hash that puts it inside a CSS colour value, as in a border declaration. */
const cssColourContext =
  /(?:--[\w-]+|\b[a-z-]*(?:color|background|border|outline|fill|stroke|shadow|decoration|rule)[a-z-]*)\s*:[^;{}]*$|(?:gradient|color-mix)\([^;{}]*$/iu;

/** A hash and digits that read as a CSS hex colour where they stand. */
const isCssColour = (match: string, before: string): boolean =>
  [3, 4, 6, 8].includes(match.length - 1) && cssColourContext.test(before);

/** This repository's own issues and pull requests are public, so references to them are fine. */
const publicRepositoryReference = /^pomerado\/pomerado#/iu;

const rules: readonly Rule[] = [
  {
    id: "internal-hostname",
    message: "Internal hostname. Use example.com or localhost in public code and docs.",
    patterns: [
      // The hosting vendor's app domain, and our own test and staging environments.
      /\bonporter\.run\b/giu,
      /\b(?:test|staging)\.pomerado\.ai\b/giu,
      // A `.internal` host in a URL, as a quoted or assigned value, in an email address, or with
      // a port. Plain member access on a property named internal is left alone.
      new RegExp(String.raw`(?<=:\/\/(?:[^\s\/@]*@)?)${internalHost}`, "giu"),
      new RegExp(String.raw`(?<=["'\x60=@])${internalHost}`, "giu"),
      new RegExp(String.raw`(?<![\w.-])${internalHost}(?=:\d)`, "giu"),
    ],
    allowed: (match) => publicInternalHost.test(match),
  },
  {
    id: "cloud-account-id",
    message: "Cloud account, project or team identifier. Keep account details out of this repo.",
    patterns: [
      // Any AWS ARN, in every partition. ARNs carry account IDs and resource names.
      /\barn:aws(?:-[a-z]+)*:/giu,
      // Twelve-digit AWS account IDs where they identify an account: registry hosts, queue
      // URLs and assignments. Twelve digits alone also appear in UUIDs, so they are not enough.
      /\b\d{12}\.dkr\.ecr\./giu,
      /\bamazonaws\.com(?:\.cn)?\/\d{12}\b/giu,
      /\b(?:aws[_-]?)?account[_-]?id["']?\s*[:=]\s*["']?\d{12}\b/giu,
      // Vercel project and team IDs, which mix letters and digits after the prefix.
      /\b(?:prj|team)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/gu,
      // Vercel and Porter IDs assigned literally. A `${{ secrets.X }}` reference is fine.
      /\b(?:VERCEL_(?:ORG|PROJECT|TEAM)|PORTER_(?:PROJECT|CLUSTER|DEPLOYMENT_TARGET|APP))_ID\b["']?\s*[:=]\s*["']?[A-Za-z0-9]/gu,
      // Porter dashboard links, which carry the project ID.
      /\b(?:porter\.run|getporter\.dev)\/projects\/\d+/giu,
    ],
  },
  {
    id: "ticket-reference",
    message:
      "Internal ticket or pull request number. Describe the change, or link a public issue in this repo by its full URL.",
    patterns: [
      // A hash and digits standing alone: at a line start or after a space, bracket or comma.
      // A hash inside a URL, an HTML entity or a quoted CSS colour has another character ahead.
      /(?<![^\s(\[{,;])#\d{1,6}(?![\w-])/gu,
      // Cross-repository shorthand, owner/name then a hash and digits.
      /(?<![\w.\/-])[\w.-]+\/[\w.-]+#\d+(?![\w-])/gu,
      // Issue and pull request links into this organization's other, private, repositories.
      /\bgithub\.com\/pomerado\/(?!pomerado(?![\w.-]))[\w.-]+\/(?:issues|pull|discussions)\/\d+/giu,
      // Numbered pull requests, issues and tickets in prose.
      /\b(?:PR|MR)\s?#?\d+\b/gu,
      /\b(?:[Ii]ssue|[Tt]icket|[Pp]ull request)\s#?\d+\b/gu,
    ],
    allowed: (match, before) => isCssColour(match, before) || publicRepositoryReference.test(match),
  },
  {
    id: "review-reference",
    message: "Internal review reference. Say what the code must do instead of where it was asked.",
    patterns: [
      // A review finding ID such as a priority, a dash and an item number.
      /\b[Rr]eview\s+(?:finding\s+|item\s+)?[A-Z]{1,2}\d+(?:[-.]\d+)+\b/gu,
      /\bP\d-\d+\b/gu,
      // A numbered review round or pass.
      /\breview\s+(?:round|pass|cycle)\s+\d+\b/giu,
      /\b(?:round|pass)\s+\d+\s+(?:of\s+)?(?:the\s+)?review\b/giu,
    ],
  },
];

/** `.env` files, except the committed examples that hold no values. */
const envFileName =
  /^(?:\.env(?:rc)?|\.env\.(?!(?:example|sample|template)$)[\w.-]+|[\w.-]+\.env)$/iu;

/** Private keys and key stores. A `.pub` public key is fine. */
const keyFileName = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:pem|key|p12|pfx|jks|keystore|ppk|p8))$/iu;

/** Findings for a tracked path's file name. */
export const scanPath = (path: string): Finding[] => {
  const name = basename(path);
  const finding = (rule: string, message: string): Finding => ({
    source: path,
    line: 0,
    column: 0,
    rule,
    message,
  });
  if (envFileName.test(name)) {
    return [finding("env-file", "Environment file. Commit a `.env.example` without values instead.")];
  }
  if (keyFileName.test(name)) {
    return [finding("private-key-file", "Private key or key store file. Never commit key material.")];
  }
  return [];
};

/** Findings for one text, such as a file's contents or a commit message. One per rule and line. */
export const scanText = (source: string, text: string): Finding[] => {
  const findings: Finding[] = [];
  text.split(/\r?\n/u).forEach((line, index) => {
    for (const rule of rules) {
      const columns = rule.patterns.flatMap((pattern) =>
        [...line.matchAll(pattern)]
          .filter((match) => !rule.allowed?.(match[0], line.slice(0, match.index)))
          .map((match) => match.index + 1),
      );
      if (columns.length === 0) continue;
      findings.push({
        source,
        line: index + 1,
        column: Math.min(...columns),
        rule: rule.id,
        message: rule.message,
      });
    }
  });
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** A tracked file's text, or undefined for a binary file, a submodule or a deleted file. */
const readText = (path: string): string | undefined => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
};

/** The committer of commits GitHub makes itself, such as a merge from a pull request's page. */
const githubCommitter = "noreply@github.com";

/**
 * The first line GitHub writes when it merges a pull request of this repository: a merge commit
 * title, or a squashed title with the number appended in brackets. Group 1 or 2 is the number.
 */
const githubMergeTitle = /^Merge pull request (#\d+) from \S+$|^.*\S \((#\d+)\)$/du;

/** A commit message with the pull request number GitHub wrote in its first line blanked out. */
export const maskGitHubMergeNumber = (message: string): string => {
  const end = message.indexOf("\n");
  const match = githubMergeTitle.exec(end === -1 ? message : message.slice(0, end));
  const span = match?.indices?.[1] ?? match?.indices?.[2];
  if (span === undefined) return message;
  return message.slice(0, span[0]) + " ".repeat(span[1] - span[0]) + message.slice(span[1]);
};

/** Findings for every tracked file and, given a range such as `A..B`, its commit messages. */
export const scanRepository = (cwd: string, commits?: string): Finding[] => {
  const findings: Finding[] = [];
  for (const path of git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    findings.push(...scanPath(path));
    const text = readText(join(cwd, path));
    if (text !== undefined) findings.push(...scanText(path, text));
  }
  if (commits !== undefined) {
    const log = git(cwd, ["log", "-z", "--format=%H%n%ce%n%B", commits, "--"]);
    for (const entry of log.split("\0").filter(Boolean)) {
      const [sha = "", committer = "", ...lines] = entry.split("\n");
      const message = lines.join("\n");
      findings.push(
        ...scanText(
          `commit ${sha.slice(0, 12)}`,
          committer === githubCommitter ? maskGitHubMergeNumber(message) : message,
        ),
      );
    }
  }
  return findings;
};

const format = (finding: Finding): string =>
  `${finding.source}${finding.line > 0 ? `:${finding.line}:${finding.column}` : ""} ` +
  `${finding.rule}: ${finding.message}`;

const usage = "Usage: node tools/check-public-content.ts [--commits <base>..<head>]";

const main = (args: readonly string[]): number => {
  let commits: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--commits" && value !== undefined && value !== "") {
      commits = value;
      index++;
    } else {
      process.stderr.write(`${usage}\n`);
      return 2;
    }
  }
  let findings: Finding[];
  try {
    findings = scanRepository(process.cwd(), commits);
  } catch (error) {
    process.stderr.write(`The public content scan could not run: ${String(error)}\n`);
    return 2;
  }
  if (findings.length === 0) {
    process.stdout.write("Public content scan: no findings.\n");
    return 0;
  }
  process.stdout.write(`Public content scan: ${findings.length} finding(s).\n`);
  for (const finding of findings) process.stdout.write(`${format(finding)}\n`);
  process.stdout.write(
    "Matched text is not printed because CI logs are public. Keep rules generic, see the header of tools/check-public-content.ts.\n",
  );
  return 1;
};

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
