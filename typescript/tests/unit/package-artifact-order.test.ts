import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The release workflow publishes the tarball check.yml's check job uploads, after checking it
// against the SHA-256 that job recorded. A package installed without a lockfile resolves fresh from
// the registry and runs on the same runner, so the tarball must be hashed and uploaded before any
// such install, or that code could change the bytes before they are fixed.

const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/check.yml", import.meta.url)), "utf8");

/** The check job's lines, from its key to the next job's. */
const checkJob = (() => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === "  check:");
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
})();

/** An install that resolves from the registry: npm install or npx, or pnpm add or dlx. */
const unlocked = /\bnpm\s+(?:install|i|add|exec)\b|\bnpx\b|\bpnpm\s+(?:add|dlx)\b/;

describe("the published tarball", () => {
  it("is hashed and uploaded before the check job installs anything without a lockfile", () => {
    const digest = checkJob.findIndex((line) => /^\s+id: package-digest\s*$/.test(line));
    const upload = checkJob.findIndex((line) => /^\s+id: package\s*$/.test(line));
    const install = checkJob.findIndex((line) => unlocked.test(line));
    expect(digest).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(digest);
    expect(install).toBeGreaterThan(upload);
  });
});
