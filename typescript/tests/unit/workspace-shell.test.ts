import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hostPlatform, type LocalPlatform } from "../../src/execution/local-platform.js";
import { createLocalWorkspace, windowsShellMissing } from "../../src/execution/local-workspace.js";

// Windows has no /bin/sh, so offline commands there run in the POSIX shell Git for Windows
// installs. Most cases here run that path on macOS and Linux, with a stand-in sh.exe that records
// how it was started and marks its output.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-shell-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * A Git for Windows install folder: `cmd\git.exe`, `mingw64\bin\git.exe`, and a `bin\sh.exe` that
 * records its arguments, its MSYS settings and the script it reads, then runs /bin/sh.
 */
const gitInstall = (parent: string) => {
  const install = join(parent, "Git");
  for (const folder of ["bin", "cmd", join("mingw64", "bin")]) {
    mkdirSync(join(install, folder), { recursive: true });
    if (folder !== "bin") writeFileSync(join(install, folder, "git.exe"), "");
  }
  const log = join(parent, "sh-started.txt");
  const shell = join(install, "bin", "sh.exe");
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$#" "$@" "MSYS=$MSYS" "CHERE_INVOKING=$CHERE_INVOKING" > '${log}'`,
      `eval "script=\\\${$#}"; cp "$script" '${log}.script'`,
      'echo "git-for-windows sh"',
      'exec /bin/sh "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  return {
    install,
    started: () => readFileSync(log, "utf8").split("\n").slice(0, -1),
    script: () => readFileSync(`${log}.script`, "utf8"),
  };
};

/** A Windows host that runs only taskkill, emulated by ending the process by its ID. */
const windows = (environment: Record<string, string>) => {
  const runs: string[] = [];
  const platform: LocalPlatform = {
    windows: true,
    environment: { SystemRoot: "C:\\Windows", ...environment },
    run: async (file, args) => {
      runs.push(file);
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

const exec = async (platform: LocalPlatform, cmd: string, shell?: string) => {
  const scope = await Effect.runPromise(Scope.make());
  cleanup.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const workspace = await Effect.runPromise(
    createLocalWorkspace({ platform }).pipe(Scope.extend(scope)),
  );
  const run = workspace.session.exec;
  if (run === undefined) throw new Error("The workspace runs no commands");
  writeFileSync(join(workspace.root, "a.json"), "{}");
  writeFileSync(join(workspace.root, "b.json"), "{}");
  return run({ cmd, ...(shell === undefined ? {} : { shell }) });
};

// Globs with and without spaces, both quote kinds, an escaped quote, a dollar sign, a command
// substitution, backticks and a backslash, as sh itself reads them.
const quoting = `printf '[%s]' *.json no*match 'it''s' "say \\"hi\\"" '$HOME' "$(echo sub)" \`echo tick\` 'a\\b'`;
const quoted = '[a.json][b.json][no*match][its][say "hi"][$HOME][sub][tick][a\\b]';

// Runs on every platform: /bin/sh on macOS and Linux, Git for Windows' sh on Windows.
it("runs a command as sh reads it, globs, quotes and substitutions included", async () => {
  expect(await exec(hostPlatform, quoting)).toMatchObject({ exitCode: 0, output: quoted });
});

describe.skipIf(process.platform === "win32")("offline commands on Windows", () => {
  it("run in Git's default install folder, starting no program to find it", async () => {
    const programs = temporary();
    gitInstall(programs);
    const { platform, runs } = windows({ ProgramFiles: programs });

    const result = await exec(platform, "echo offline");

    expect(result).toMatchObject({ exitCode: 0, output: "git-for-windows sh\noffline\n" });
    expect(runs).not.toContain("git");
  });

  it("run in the install of a git.exe on the PATH, from its cmd or toolchain folder", async () => {
    for (const folder of ["cmd", join("mingw64", "bin")]) {
      const { install } = gitInstall(temporary());
      const { platform } = windows({ PATH: `${temporary()};${join(install, folder)}` });

      const result = await exec(platform, "echo offline");

      expect(result).toMatchObject({ exitCode: 0, output: "git-for-windows sh\noffline\n" });
    }
  });

  it("read the command from a file, so the MSYS runtime parses none of it", async () => {
    const programs = temporary();
    const git = gitInstall(programs);
    const { platform } = windows({ ProgramFiles: programs });

    const result = await exec(platform, quoting);

    expect(result).toMatchObject({ exitCode: 0, output: `git-for-windows sh\n${quoted}` });
    const [count, script, ...settings] = git.started();
    expect(count).toBe("1");
    expect(script).toMatch(/command\.sh$/);
    expect(git.script()).toBe(quoting);
    expect(settings).toEqual(["MSYS=noglob", "CHERE_INVOKING=1"]);
  });

  it("run in the shell the host found, whatever shell the command asks for", async () => {
    const programs = temporary();
    gitInstall(programs);
    const { platform } = windows({ ProgramFiles: programs });

    const result = await exec(platform, "echo offline", "bash");

    expect(result).toMatchObject({ exitCode: 0, output: "git-for-windows sh\noffline\n" });
  });

  it("fail with what to install, and start nothing, without Git for Windows on a fixed path", async () => {
    // A relative PATH entry would be searched from the working folder.
    const { install } = gitInstall(temporary());
    const { platform, runs } = windows({
      ProgramFiles: temporary(),
      PATH: relative(process.cwd(), join(install, "cmd")),
    });

    await expect(exec(platform, "echo offline")).rejects.toThrow(windowsShellMissing);
    expect(runs).toEqual([]);
  });
});
