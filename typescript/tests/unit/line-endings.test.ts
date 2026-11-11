import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const attributes = fileURLToPath(new URL("../../../.gitattributes", import.meta.url));

describe("repository line endings", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  // Git for Windows installs with core.autocrlf=true. The authoring parser needs LF, so a clone
  // made with that setting must still check text out with LF, and license texts unchanged.
  it("checks text out with LF under core.autocrlf=true and keeps third-party texts as committed", () => {
    const origin = mkdtempSync(join(tmpdir(), "line-endings-origin-"));
    const clone = mkdtempSync(join(tmpdir(), "line-endings-clone-"));
    const home = mkdtempSync(join(tmpdir(), "line-endings-home-"));
    directories.push(origin, clone, home);
    const emptyConfig = join(home, "gitconfig");
    writeFileSync(emptyConfig, "");
    // Only the fixture's own settings apply: no system or user config, hooks or GIT_* variables
    // from the machine that runs the test.
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyConfig,
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=",
          ...args,
        ],
        { cwd, encoding: "utf8", env: environment },
      );
    const files = {
      "typescript/authoring/core/SKILL.md":
        "<!-- pomerado:section core.intro:start\nText.\npomerado:section core.intro:end -->\n",
      "typescript/src/example.ts": "export const one = 1;\n",
      "third-party/example/LICENSE": "License line one\r\nLicense line two\r\n",
    };
    git(origin, "init", "--quiet", "--initial-branch=main");
    git(origin, "config", "core.autocrlf", "false");
    copyFileSync(attributes, join(origin, ".gitattributes"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), text);
    }
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "Fixture");

    git(clone, "-c", "core.autocrlf=true", "clone", "--quiet", "--config", "core.autocrlf=true", origin, ".");

    for (const [path, text] of Object.entries(files))
      expect(readFileSync(join(clone, path), "utf8"), path).toBe(text);
  });
});
