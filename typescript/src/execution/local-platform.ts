import { execFile } from "node:child_process";
import { win32 } from "node:path";

/**
 * The operating system facts local execution depends on. The host passes `hostPlatform`; a test
 * passes another, so each platform's path also runs where the tests do.
 */
export interface LocalPlatform {
  readonly windows: boolean;
  /** The host's environment, read for Windows' system folder. */
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
