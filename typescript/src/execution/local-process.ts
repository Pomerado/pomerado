import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcess } from "node:child_process";
import { Cause, Deferred, Effect, Exit, Fiber, Option, type Scope } from "effect";
import { localError, localOutputLimit } from "./local-path.js";
import { hostPlatform, windowsSystemProgram, type LocalPlatform } from "./local-platform.js";

export interface LocalProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface LocalProcess {
  readonly child: ChildProcess;
  readonly result: Effect.Effect<LocalProcessResult, Error>;
  readonly close: Effect.Effect<void, Error>;
}

const signalGroup = (child: ChildProcess) =>
  Effect.try({
    try: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    },
    catch: localError,
  });

/** taskkill's exit code when no process has the ID, such as one that has already ended. */
const taskkillNotFound = 128;

/**
 * How long taskkill may take. It stays well inside the close's 5 s confirmation, so the fallback
 * kill still runs when taskkill hangs.
 */
const taskkillTimeoutMs = 2_000;
/** How long the close waits for a command's own output to end before it stops reading it. */
const outputGraceMs = 500;

/**
 * Windows has no process groups. While the command runs, `taskkill /T /F` ends it and every
 * process it started, as Playwright stops a browser; when taskkill cannot, the command itself
 * still ends. Once it has ended, its ID may belong to another program, so nothing is killed by ID.
 * A process it left running is no longer linked to it and can hold its output open, so when the
 * output has not ended shortly after, the host stops reading it, and the close completes as it
 * does on macOS and Linux.
 */
const killTree = (platform: LocalPlatform, child: ChildProcess, closed: Effect.Effect<void>) =>
  Effect.gen(function* () {
    if (child.pid === undefined) return;
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = windowsSystemProgram(platform, "taskkill.exe");
      const args = ["/pid", String(child.pid), "/T", "/F"];
      const { exitCode } = yield* Effect.promise(() =>
        platform.run(taskkill, args, taskkillTimeoutMs),
      );
      if (exitCode !== 0 && exitCode !== taskkillNotFound) child.kill("SIGKILL");
    }
    if (Option.isNone(yield* closed.pipe(Effect.timeoutOption(outputGraceMs)))) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });

/**
 * Each command owns a process group on macOS and Linux, and a process tree with no window on
 * Windows. Local execution is caller compute, not an OS sandbox.
 */
export const createLocalProcess = (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly ipc?: boolean;
  readonly outputLimit?: number;
  readonly platform?: LocalPlatform;
}): Effect.Effect<LocalProcess, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const platform = options.platform ?? hostPlatform;
    const ended = yield* Deferred.make<LocalProcessResult, Error>();
    const child = yield* Effect.try({
      try: () =>
        spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: { ...options.environment },
          // A detached Windows child gets its own console window; it needs no group to stop.
          ...(platform.windows ? { windowsHide: true } : { detached: true }),
          serialization: "advanced",
          stdio: options.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        }),
      catch: localError,
    });
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const lengths = { stdout: 0, stderr: 0 };
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let closeFiber: Fiber.RuntimeFiber<void, Error> | undefined;
    const close = Effect.suspend(() => {
      closeFiber ??= Effect.runFork(
        (platform.windows
          ? killTree(platform, child, Deferred.await(ended).pipe(Effect.either, Effect.asVoid))
          : signalGroup(child)
        ).pipe(
          Effect.zipRight(Deferred.await(ended).pipe(Effect.either, Effect.asVoid)),
          Effect.timeoutFail({
            duration: 5_000,
            onTimeout: () => new Error("Local process stop is unconfirmed"),
          }),
          Effect.interruptible,
        ),
      );
      return Fiber.join(closeFiber);
    }).pipe(Effect.uninterruptible);
    const capture = (channel: "stdout" | "stderr", bytes: Buffer) => {
      lengths[channel] += bytes.length;
      if (lengths[channel] > (options.outputLimit ?? localOutputLimit)) {
        failure ??= new Error(`Local process ${channel} exceeds output limit`);
        Effect.runCallback(close, {
          onExit: (exit) => {
            if (Exit.isFailure(exit))
              Effect.runSync(Deferred.fail(ended, localError(Cause.squash(exit.cause))));
          },
        });
        return;
      }
      const text = decoders[channel].write(bytes);
      if (channel === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (bytes: Buffer) => capture("stdout", bytes));
    child.stderr?.on("data", (bytes: Buffer) => capture("stderr", bytes));
    child.on("error", (cause) => {
      failure = localError(cause);
    });
    child.once("close", (exitCode, signal) => {
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      Effect.runSync(
        failure === undefined
          ? Deferred.succeed(ended, { exitCode, signal, stdout, stderr })
          : Deferred.fail(ended, failure),
      );
    });
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    return { child, result: Deferred.await(ended), close };
  }).pipe(Effect.uninterruptible);
