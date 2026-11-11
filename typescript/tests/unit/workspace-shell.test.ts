import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalPlatform } from "../../src/execution/local-platform.js";
import { createLocalWorkspace, windowsShellMissing } from "../../src/execution/local-workspace.js";

// Windows has no /bin/sh, so offline commands there run in the POSIX shell Git for Windows
// installs. These run that path on macOS and Linux, with a stand-in sh.exe that marks its output.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A Git for Windows install folder whose bin/sh.exe runs /bin/sh after printing a marker. */
const gitInstall = (parent: string) => {
  const install = join(parent, "Git");
  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "mingw64", "libexec", "git-core"), { recursive: true });
  const shell = join(install, "bin", "sh.exe");
  writeFileSync(shell, '#!/bin/sh\necho "git-for-windows sh"\nexec /bin/sh "$@"\n');
  chmodSync(shell, 0o755);
  return install;
};

const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-shell-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** A Windows host whose `git --exec-path` prints `gitExecPath`, or fails when it is absent. */
const windows = (environment: Record<string, string>, gitExecPath?: string) => {
  const runs: string[] = [];
  const platform: LocalPlatform = {
    windows: true,
    environment: { SystemRoot: "C:\\Windows", ...environment },
    run: async (file, args) => {
      runs.push(file);
      if (file === "git")
        return gitExecPath === undefined
          ? { exitCode: null, stdout: "" }
          : { exitCode: 0, stdout: `${gitExecPath}\n` };
      try {
        process.kill(Number(args[1]), "SIGKILL");
      } catch {
        return { exitCode: 128, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    },
  };
  return { platform, runs };
};

const exec = async (platform: LocalPlatform, cmd: string) => {
  const scope = await Effect.runPromise(Scope.make());
  cleanup.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const workspace = await Effect.runPromise(
    createLocalWorkspace({ platform }).pipe(Scope.extend(scope)),
  );
  const run = workspace.session.exec;
  if (run === undefined) throw new Error("The workspace runs no commands");
  return run({ cmd });
};

describe.skipIf(process.platform === "win32")("offline commands on Windows", () => {
  it("run in the sh.exe of the Git that is on the PATH", async () => {
    const install = gitInstall(temporary());
    const { platform } = windows({}, join(install, "mingw64", "libexec", "git-core"));

    const result = await exec(platform, "echo offline");

    expect(result).toMatchObject({ exitCode: 0, output: "git-for-windows sh\noffline\n" });
  });

  it("run in Git's default install folder when no git is on the PATH", async () => {
    const programs = temporary();
    gitInstall(programs);
    const { platform } = windows({ ProgramFiles: programs });

    const result = await exec(platform, "echo offline");

    expect(result).toMatchObject({ exitCode: 0, output: "git-for-windows sh\noffline\n" });
  });

  it("fail with what to install, and start nothing, when there is no Git for Windows", async () => {
    const { platform, runs } = windows({ ProgramFiles: temporary() });

    await expect(exec(platform, "echo offline")).rejects.toThrow(windowsShellMissing);
    expect(runs).toEqual(["git"]);
  });
});
