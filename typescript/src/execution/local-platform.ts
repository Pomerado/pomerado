import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

/**
 * The operating system facts local execution depends on. The host passes `hostPlatform`; a test
 * passes another, so each platform's path also runs where the tests do.
 */
export interface LocalPlatform {
  readonly windows: boolean;
  /** The host's environment, read for Windows' system and program folders. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * Runs a system program, with no shell and no window, to its end. `exitCode` is null when it
   * could not start, ended by a signal or ran past `timeoutMs`.
   */
  readonly run: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
}

export const hostPlatform: LocalPlatform = {
  windows: process.platform === "win32",
  environment: process.env,
  run: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          const code = error === null ? 0 : error.code;
          resolve({ exitCode: typeof code === "number" ? code : null, stdout });
        },
      );
    }),
};

/** A program in Windows' own System32 folder, named by path so no search can substitute another. */
export const windowsSystemProgram = (platform: LocalPlatform, name: string): string =>
  win32.join(
    platform.environment["SystemRoot"] || platform.environment["windir"] || "C:\\Windows",
    "System32",
    name,
  );

/**
 * Windows can refuse to remove a file for a moment after the process that held it ends, or while
 * antivirus software reads it, so removing a folder there retries briefly.
 */
export const removalRetries = (platform: LocalPlatform) =>
  platform.windows ? { maxRetries: 5, retryDelay: 100 } : {};

/**
 * The POSIX shell workspace commands run in on Windows: the `sh.exe` Git for Windows installs in
 * its `bin` folder, which puts Git's Unix tools on the PATH. It is found from the `git` on the
 * PATH, then in Git's default install folders, for every user or for one.
 */
export const findWindowsShell = async (platform: LocalPlatform): Promise<string | undefined> => {
  const { exitCode, stdout } = await platform.run("git", ["--exec-path"], 5_000);
  // `git --exec-path` names `<install>/<toolchain>/libexec/git-core`, such as mingw64.
  const execPath = exitCode === 0 ? stdout.trim() : "";
  const fromGit = execPath === "" ? [] : [resolve(execPath, "../../..")];
  const { ProgramFiles, ProgramW6432, LOCALAPPDATA } = platform.environment;
  const installs = [
    ...fromGit,
    ...[ProgramW6432, ProgramFiles].flatMap((folder) => (folder ? [join(folder, "Git")] : [])),
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, "Programs", "Git")] : []),
  ];
  return installs
    .map((install) => join(install, "bin", "sh.exe"))
    .find((shell) => existsSync(shell));
};
