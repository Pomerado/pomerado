import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";

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
 * A path that names one place on one machine. On Windows that is `C:\...`: a relative PATH entry
 * would be searched from the working folder, and `\folder` from the current drive.
 */
const fixedPath = (path: string) =>
  process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path);

/** Git for Windows' toolchain folders, which hold `git.exe` in their `bin`. */
const gitToolchains = new Set(["mingw64", "mingw32", "clangarm64", "clang64"]);

/**
 * The Git for Windows install a PATH entry holding `git.exe` belongs to: the entry's parent for
 * `<install>\cmd` or `<install>\bin`, and two folders up for `<install>\mingw64\bin`.
 */
const gitInstallOf = (entry: string) => {
  const parent = dirname(entry);
  const folder = basename(entry).toLowerCase();
  if (folder === "cmd") return parent;
  if (folder !== "bin") return undefined;
  return gitToolchains.has(basename(parent).toLowerCase()) ? dirname(parent) : parent;
};

/**
 * The POSIX shell workspace commands run in on Windows: the `sh.exe` Git for Windows installs in
 * its `bin` folder, which puts Git's Unix tools on the PATH. It runs no program to find it: it
 * looks in Git's default install folder for every user, then in the install of each `git.exe` on
 * the PATH, then in the default folder for one user. Only a fixed path counts.
 */
export const findWindowsShell = (platform: LocalPlatform): string | undefined => {
  const { ProgramFiles, ProgramW6432, LOCALAPPDATA } = platform.environment;
  const path = platform.environment["PATH"] ?? platform.environment["Path"] ?? "";
  const installs = [
    ...[ProgramW6432, ProgramFiles].flatMap((folder) => (folder ? [join(folder, "Git")] : [])),
    ...path
      .split(";")
      .filter((entry) => fixedPath(entry) && existsSync(join(entry, "git.exe")))
      .flatMap((entry) => gitInstallOf(entry) ?? []),
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, "Programs", "Git")] : []),
  ];
  return installs
    .map((install) => join(install, "bin", "sh.exe"))
    .find((shell) => fixedPath(shell) && existsSync(shell));
};
