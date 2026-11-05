/**
 * Supply-chain check for GitHub Actions workflows, run by `pnpm test`.
 *
 * A tag or branch can be moved to other code after review, so everything a workflow runs from
 * outside this repository names the exact content it runs:
 *
 * - `uses:` names a full 40-character commit SHA, such as `actions/checkout@<sha> # v7.0.1`. A local
 *   `./` action or reusable workflow is reviewed with the change, and a `docker://` image needs an
 *   `@sha256:` digest.
 * - A job's `container:` or a service's `image:` names an `@sha256:` digest.
 * - No step pipes a download into a shell, such as `curl ... | bash`. Download a pinned version
 *   and check its SHA-256 before running it, as the gitleaks step in check.yml does.
 *
 * It reads `.github/workflows/`, `.github/actions/` and a root `action.yml`, one line at a time.
 *
 * Usage, from the repository root:
 *   node tools/check-workflows.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly message: string;
}

const commit = /^[^@\s]+@[0-9a-f]{40}$/;
const digest = /@sha256:[0-9a-f]{64}$/;
const uses = /^\s*(?:-\s+)?uses:\s*(.*)$/;
const image = /^\s*(?:-\s+)?(?:container|image):\s*(.*)$/;
const pipedDownload = [
  /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+)?(?:\S*\/)?(?:ba|z|da|k)?sh\b/,
  /\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*<\(\s*(?:curl|wget)\b/,
  /\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/,
];

/** The value of a YAML scalar on one line, without quotes or a trailing comment. */
const scalar = (value: string): string => {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*?)\1/.exec(trimmed);
  if (quoted) return quoted[2] ?? "";
  return trimmed.replace(/\s+#.*$/, "").trim();
};

const usesProblem = (reference: string): string | undefined => {
  if (reference.startsWith("./")) return undefined;
  if (reference.startsWith("docker://"))
    return digest.test(reference)
      ? undefined
      : `uses ${reference}, which must name an @sha256: digest`;
  return commit.test(reference)
    ? undefined
    : `uses ${reference}, which must be pinned to a full 40-character commit SHA`;
};

export function scanWorkflowText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((content, index) => {
    if (/^\s*#/.test(content)) return;
    const add = (message: string): void => {
      findings.push({ path, line: index + 1, message });
    };
    const reference = uses.exec(content);
    if (reference) {
      const problem = usesProblem(scalar(reference[1] ?? ""));
      if (problem) add(problem);
    }
    const named = image.exec(content);
    if (named) {
      const value = scalar(named[1] ?? "");
      // An empty value opens a mapping, whose own `image:` line is checked. An expression is
      // resolved at run time, from inputs this check can't see.
      if (value !== "" && !value.includes("${{") && !digest.test(value))
        add(`runs image ${value}, which must name an @sha256: digest`);
    }
    if (pipedDownload.some((pattern) => pattern.test(content)))
      add("pipes a download into a shell; pin its version and check its SHA-256 before running it");
  });
  return findings;
}

const yamlFiles = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { recursive: true, encoding: "utf8" })
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => join(directory, name))
    : [];

export function scanWorkflows(root: string): Finding[] {
  const files = [
    ...yamlFiles(join(root, ".github", "workflows")),
    ...yamlFiles(join(root, ".github", "actions")),
    ...["action.yml", "action.yaml"].map((name) => join(root, name)).filter(existsSync),
  ];
  return files.flatMap((file) =>
    scanWorkflowText(relative(root, file), readFileSync(file, "utf8")),
  );
}

const main = (): number => {
  const findings = scanWorkflows(process.cwd());
  for (const finding of findings)
    process.stdout.write(`${finding.path}:${finding.line}: ${finding.message}\n`);
  if (findings.length > 0) {
    process.stdout.write(`Workflow check: ${findings.length} finding(s).\n`);
    return 1;
  }
  process.stdout.write("Workflow check: no findings.\n");
  return 0;
};

if (import.meta.main) process.exitCode = main();
