import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanWorkflowText, scanWorkflows } from "../../../tools/check-workflows.js";

const script = fileURLToPath(new URL("../../../tools/check-workflows.ts", import.meta.url));
const sha = "0123456789abcdef0123456789abcdef01234567";
const sha256 = `sha256:${"a".repeat(64)}`;

const lines = (text: string): number[] =>
  scanWorkflowText("workflow.yml", text).map((finding) => finding.line);

describe("workflow supply-chain check", () => {
  it.each([
    ["an action at a commit SHA", `      - uses: actions/checkout@${sha} # v7.0.1`],
    ["a quoted action at a commit SHA", `      - uses: "actions/checkout@${sha}"`],
    ["an action in a subdirectory", `      - uses: github/codeql-action/init@${sha}`],
    ["a reusable workflow at a commit SHA", `    uses: owner/repo/.github/workflows/ci.yml@${sha}`],
    ["a local action", "      - uses: ./.github/actions/setup"],
    ["a local reusable workflow", "    uses: ./.github/workflows/check.yml"],
    ["a docker action at a digest", `      - uses: docker://alpine@${sha256}`],
    ["a container at a digest", `    container: node:24@${sha256}`],
    ["a service image at a digest", `        image: postgres:17@${sha256}`],
    ["a container mapping", "    container:"],
    ["an image from an expression", "        image: ${{ inputs.image }}"],
    ["a download piped into a parser", "        run: curl -fsS https://example.com/x.json | jq .version"],
    ["a download checked by its hash", "          curl -fsSLo tool.tgz https://example.com/tool.tgz"],
    ["a checksum piped into sha256sum", '          echo "$SUM  tool.tgz" | sha256sum --check'],
    ["a comment", "      # uses: actions/checkout@v4"],
  ])("accepts %s", (_label, text) => {
    expect(lines(text)).toEqual([]);
  });

  it.each([
    ["an action at a tag", "      - uses: actions/checkout@v4"],
    ["an action at a branch", "      - uses: actions/checkout@main"],
    ["an action at a short SHA", "      - uses: actions/checkout@0123456"],
    ["an action with no ref", "      - uses: actions/checkout"],
    ["a quoted action at a tag", '      - uses: "actions/checkout@v4" # pinned'],
    ["a reusable workflow at a tag", "    uses: owner/repo/.github/workflows/ci.yml@v1"],
    ["a docker action at a tag", "      - uses: docker://alpine:3.22"],
    ["a container at a tag", "    container: node:24"],
    ["a container image at a tag", "      image: node:24-bookworm"],
    ["a service image with no tag", "        image: postgres"],
    ["curl piped into bash", "        run: curl -fsSL https://example.com/install.sh | bash"],
    ["wget piped into sh with sudo", "          wget -qO- https://example.com/i | sudo sh -s -- -y"],
    ["curl piped into an absolute shell", "          curl -sL https://example.com/i | /bin/bash"],
    ["bash reading a download", "          bash <(curl -fsSL https://example.com/install.sh)"],
    ["sh running a download", '          sh -c "$(curl -fsSL https://example.com/install.sh)"'],
  ])("flags %s", (_label, text) => {
    expect(lines(text)).toEqual([1]);
  });

  it("reports the line of each finding", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      `      - uses: actions/checkout@${sha} # v7.0.1`,
      "      - uses: actions/setup-node@v4",
    ].join("\n");
    expect(scanWorkflowText("w.yml", workflow)).toEqual([
      {
        path: "w.yml",
        line: 5,
        message:
          "uses actions/setup-node@v4, which must be pinned to a full 40-character commit SHA",
      },
    ]);
  });

  it("finds nothing in this repository's workflows", () => {
    expect(scanWorkflows(process.cwd())).toEqual([]);
  });

  describe("command line", () => {
    let root: string | undefined;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    const run = (files: Record<string, string>) => {
      root = mkdtempSync(join(tmpdir(), "check-workflows-"));
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    };

    it("fails on an unpinned action in a workflow or a composite action", () => {
      const result = run({
        ".github/workflows/ci.yml": `steps:\n  - uses: actions/checkout@${sha}\n`,
        ".github/actions/setup/action.yml": "runs:\n  steps:\n    - uses: actions/cache@v4\n",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(".github/actions/setup/action.yml:3: uses actions/cache@v4");
    });

    it("passes pinned workflows", () => {
      const result = run({ ".github/workflows/ci.yml": `steps:\n  - uses: actions/checkout@${sha}\n` });
      expect(result.status).toBe(0);
    });
  });
});
