import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { chromium, type Browser, type BrowserServer } from "playwright";
import { Cause, Effect, Exit, Fiber, Schema, type Scope } from "effect";
import {
  CredentialInsertion,
  type CredentialKeyboard,
} from "../destinations/credential-keyboard.js";
import { BrowserExecuteResponse, type BrowserExecute } from "../runtime/browser-execution.js";
import type { HostExecute } from "../runtime/host-execute.js";

export const NativeWorkerRequest = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("execute"),
    code: Schema.String,
    /**
     * Values to watch for: the worker answers which ones a typing call delivered, and in which
     * frame (`typed`).
     */
    watch: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("credential"),
    target: Schema.Struct({
      targetId: Schema.optional(Schema.String),
      bindingKey: Schema.String,
      documentOrigin: Schema.String,
    }),
    text: Schema.String,
  }),
);
type WithoutId<A> = A extends { readonly id: string } ? Omit<A, "id"> : never;
type NativePayload = WithoutId<typeof NativeWorkerRequest.Type>;

export const NativeWorkerReply = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    targetId: Schema.String,
    contextId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("response"), id: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("failure"), id: Schema.String, error: Schema.String }),
);
export const NativeWorkerOptions = Schema.Struct({
  endpoint: Schema.String,
  startupTimeoutMs: Schema.Number,
});

export interface PlaywrightOptions {
  readonly endpoint?: string;
  readonly headless?: boolean;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}
/**
 * An answered script and which watched values its typing calls delivered, by index, each with the
 * URLs of the frames it may have gone into: when the call started and once it completed, and for
 * keys typed with nothing focused every address a frame of the page loaded while the call ran.
 */
const WatchedResponse = Schema.Struct({
  ...BrowserExecuteResponse.fields,
  typed: Schema.optionalWith(
    Schema.Array(Schema.Tuple(Schema.Number, Schema.Array(Schema.String))),
    { exact: true },
  ),
});

/**
 * Page code run while the host watches for `values`. A value counts as typed once a `fill`,
 * `type` or `pressSequentially` call on a page, frame, locator or keyboard got it as the text to
 * enter, completed without error and typed it where `where` accepts every URL reported for it: the
 * frame's when the call started and once it completed, and for keys typed with nothing focused
 * every frame's of the page and every address one loaded while the call ran. A call that failed
 * or typed elsewhere, or code that never ran, types nothing.
 */
export interface TypingWatch {
  readonly executeResponse: BrowserExecute;
  /** The indexes into `values` that a completed typing call delivered where wanted so far. */
  readonly typed: () => ReadonlySet<number>;
}

export interface PlaywrightExecutor {
  readonly sessionId: string;
  readonly targetId: string;
  readonly executeResponse: BrowserExecute;
  /** Runs page code as `executeResponse` does, watching which of `values` it types `where`. */
  readonly watchTyping: (
    values: readonly string[],
    where: (frameUrl: string) => boolean,
  ) => TypingWatch;
  readonly execute: HostExecute;
  readonly keyboard: CredentialKeyboard;
  readonly close: Effect.Effect<void, Error>;
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Native Playwright transport failed", { cause });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const duration = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0 || value > 300_000)
    throw new Error(`${name} must be positive and at most 300000 ms`);
  return value;
};

type PendingResponse = (result: Effect.Effect<unknown, Error>) => void;
interface NativeOwnership {
  readonly remote: boolean;
  readonly cleanupTimeoutMs: number;
  readonly pending: Map<string, PendingResponse>;
  server?: BrowserServer;
  supervisor?: Browser;
  worker?: Worker;
  contextId?: string;
  stopped: boolean;
  stopFiber?: Fiber.RuntimeFiber<void, Error>;
}

const verifyOwnedContextClosed = (owner: NativeOwnership) =>
  Effect.gen(function* () {
    const { supervisor, contextId } = owner;
    if (contextId === undefined) return;
    if (supervisor === undefined || !supervisor.isConnected()) {
      if (owner.remote)
        return yield* Effect.fail(
          new Error("Browser disconnected; owned remote context cleanup is unconfirmed"),
        );
      return;
    }
    const cdp = yield* promise(() => supervisor.newBrowserCDPSession());
    return yield* Effect.gen(function* () {
      while (true) {
        const { browserContextIds } = yield* promise(() => cdp.send("Target.getBrowserContexts"));
        if (!browserContextIds.includes(contextId)) return;
        yield* Effect.sleep(10);
      }
    }).pipe(
      Effect.ensuring(
        promise(() => cdp.detach()).pipe(
          Effect.timeoutFail({
            duration: owner.cleanupTimeoutMs,
            onTimeout: () =>
              new Error("Ownership inspection detach timed out; cleanup unconfirmed"),
          }),
          Effect.interruptible,
          Effect.orDie,
        ),
      ),
    );
  });

const releaseNativeOwnership = (owner: NativeOwnership, reason: Error) =>
  Effect.gen(function* () {
    const failures: Error[] = [];
    const release = (run: Effect.Effect<unknown, Error>, operation: string) =>
      run.pipe(
        Effect.interruptible,
        Effect.timeoutFail({
          duration: owner.cleanupTimeoutMs,
          onTimeout: () => new Error(`${operation} timed out; remote cleanup is unconfirmed`),
        }),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failures.push(asError(Cause.squash(exit.cause)));
          }),
        ),
      );
    if (owner.worker !== undefined) {
      const worker = owner.worker;
      yield* release(
        promise(() => worker.terminate()),
        "Native execution stop",
      );
    }
    // Disconnect owns every context this worker created, including script-created contexts.
    yield* release(verifyOwnedContextClosed(owner), "Owned context cleanup verification");
    if (owner.supervisor !== undefined) {
      const supervisor = owner.supervisor;
      yield* release(
        promise(() => supervisor.close()),
        "Native supervisor disconnect",
      );
    }
    if (owner.server !== undefined) {
      const server = owner.server;
      yield* release(
        promise(() => server.close()),
        "Owned Chromium shutdown",
      );
    }
    const failure =
      failures.length > 0
        ? new AggregateError([reason, ...failures], "Native execution stopped; cleanup unconfirmed")
        : reason;
    for (const resume of owner.pending.values()) resume(Effect.fail(failure));
    owner.pending.clear();
    if (failures.length > 0) return yield* Effect.fail(failure);
  });

const stopNative = (owner: NativeOwnership, reason: Error) =>
  Effect.suspend(() => {
    owner.stopped = true;
    owner.stopFiber ??= Effect.runFork(
      releaseNativeOwnership(owner, reason).pipe(Effect.interruptible),
    );
    return Fiber.join(owner.stopFiber);
  }).pipe(Effect.uninterruptible);

const stopFromCallback = <A>(
  owner: NativeOwnership,
  reason: Error,
  resume: (result: Effect.Effect<A, Error>) => void,
) =>
  Effect.runCallback(stopNative(owner, reason), {
    onExit: (exit) =>
      resume(Effect.fail(Exit.isFailure(exit) ? asError(Cause.squash(exit.cause)) : reason)),
  });

const bindNativeWorker = (
  owner: NativeOwnership,
  worker: Worker,
  browser: Browser,
  startupTimeoutMs: number,
) =>
  Effect.async<{ targetId: string }, Error>((resume) => {
    const fail = (error: Error) => {
      clearTimeout(timer);
      stopFromCallback(owner, error, resume);
    };
    const timer = setTimeout(
      () => fail(new Error("Native browser startup timed out")),
      startupTimeoutMs,
    );
    worker.on("message", (message: unknown) => {
      const decoded = Schema.decodeUnknownEither(NativeWorkerReply)(message);
      if (decoded._tag === "Left") {
        fail(new Error("Malformed native worker response", { cause: decoded.left }));
        return;
      }
      const reply = decoded.right;
      if (reply.kind === "ready") {
        clearTimeout(timer);
        owner.contextId = reply.contextId;
        resume(Effect.succeed({ targetId: reply.targetId }));
      } else {
        if (owner.stopped) return;
        const complete = owner.pending.get(reply.id);
        owner.pending.delete(reply.id);
        complete?.(
          reply.kind === "failure"
            ? Effect.fail(new Error(reply.error))
            : Effect.succeed(reply.value),
        );
      }
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!owner.stopped)
        fail(new Error(`Native execution worker exited (${code}); completion uncertain`));
    });
    browser.on("disconnected", () => {
      if (!owner.stopped) fail(new Error("Native browser disconnected; completion uncertain"));
    });
    return Effect.sync(() => clearTimeout(timer)).pipe(
      Effect.zipRight(stopNative(owner, new Error("Native browser startup cancelled"))),
      Effect.orDie,
    );
  });

const dispatchNative = (
  owner: NativeOwnership,
  worker: Worker,
  payload: NativePayload,
  timeoutSec: number,
) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300)
          throw new Error("timeout_sec must be an integer between 1 and 300");
        if (owner.stopped)
          throw new Error("Native executor invalidated; execution was not replayed");
      },
      catch: asError,
    });
    return yield* Effect.async<unknown, Error>((resume) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        stopFromCallback(
          owner,
          new Error(
            "Native browser execution timed out; completion uncertain; call was not replayed",
          ),
          resume,
        );
      }, timeoutSec * 1_000);
      owner.pending.set(id, (result) => {
        clearTimeout(timer);
        resume(result);
      });
      try {
        worker.postMessage({ id, ...payload });
      } catch (cause) {
        clearTimeout(timer);
        owner.pending.delete(id);
        stopFromCallback(owner, asError(cause), resume);
      }
      return Effect.sync(() => clearTimeout(timer)).pipe(
        Effect.zipRight(
          stopNative(
            owner,
            new Error(
              "Native browser execution cancelled; completion uncertain; call was not replayed",
            ),
          ),
        ),
        Effect.orDie,
      );
    });
  });

/** Owns one native connection and context. A failed transport invalidates it without replay. */
export const makePlaywrightExecutor = (
  options: PlaywrightOptions = {},
): Effect.Effect<PlaywrightExecutor, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const startupTimeoutMs = yield* Effect.try({
      try: () => duration(options.startupTimeoutMs ?? 25_000, "startupTimeoutMs"),
      catch: asError,
    });
    const cleanupTimeoutMs = yield* Effect.try({
      try: () => duration(options.cleanupTimeoutMs ?? 5_000, "cleanupTimeoutMs"),
      catch: asError,
    });
    const owner: NativeOwnership = {
      remote: options.endpoint !== undefined,
      cleanupTimeoutMs,
      stopped: false,
      pending: new Map(),
    };
    const close = stopNative(owner, new Error("Native browser executor closed"));
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    if (options.endpoint === undefined)
      owner.server = yield* promise(() =>
        chromium.launchServer({ headless: options.headless ?? true, timeout: startupTimeoutMs }),
      );
    const endpoint = options.endpoint ?? owner.server?.wsEndpoint();
    if (endpoint === undefined)
      return yield* Effect.fail(new Error("Native Playwright endpoint missing"));
    const browser = yield* promise(() => chromium.connect(endpoint, { timeout: startupTimeoutMs }));
    owner.supervisor = browser;
    const worker = yield* Effect.try({
      try: () =>
        new Worker(
          new URL(
            import.meta.url.endsWith(".ts") ? "./playwright-worker.ts" : "./playwright-worker.js",
            import.meta.url,
          ),
          {
            // Generated browser code must not inherit host model or provider credentials.
            env: {},
            // Parent entrypoint flags such as --input-type do not apply to this file entrypoint.
            execArgv: [],
            workerData: { endpoint, startupTimeoutMs },
          },
        ),
      catch: asError,
    });
    owner.worker = worker;
    const ready = yield* bindNativeWorker(owner, worker, browser, startupTimeoutMs);
    const semaphore = yield* Effect.makeSemaphore(1);
    const call = (payload: NativePayload, timeoutSec: number) =>
      dispatchNative(owner, worker, payload, timeoutSec).pipe(semaphore.withPermits(1));
    const executeResponse: BrowserExecute = (code, timeoutSec = 60) =>
      call({ kind: "execute", code }, timeoutSec).pipe(
        Effect.flatMap((response) => Schema.decodeUnknown(BrowserExecuteResponse)(response)),
        Effect.mapError(asError),
      );
    const watchTyping = (
      values: readonly string[],
      where: (frameUrl: string) => boolean,
    ): TypingWatch => {
      const typed = new Set<number>();
      return {
        executeResponse: (code, timeoutSec = 60) =>
          call({ kind: "execute", code, watch: values }, timeoutSec).pipe(
            Effect.flatMap((response) => Schema.decodeUnknown(WatchedResponse)(response)),
            Effect.map(({ typed: delivered, ...response }) => {
              for (const [index, urls] of delivered ?? [])
                if (urls.length > 0 && urls.every(where)) typed.add(index);
              return response;
            }),
            Effect.mapError(asError),
          ),
        typed: () => typed,
      };
    };
    const execute: HostExecute = (code, timeoutSec = 30) =>
      executeResponse(code, timeoutSec).pipe(
        Effect.flatMap((response) => {
          if (response.success) return Effect.succeed(response.result);
          const error = new Error(response.error ?? "Native Playwright script failed");
          if (response.stderr) error.stack = response.stderr;
          return Effect.fail(error);
        }),
      );
    const keyboard: CredentialKeyboard = {
      insertText: (target, text) =>
        call({ kind: "credential", target, text }, 15).pipe(
          Effect.flatMap((value) => Schema.decodeUnknown(CredentialInsertion)(value)),
          Effect.mapError(asError),
        ),
    };
    return {
      sessionId: randomUUID(),
      targetId: ready.targetId,
      executeResponse,
      watchTyping,
      execute,
      keyboard,
      close,
    };
  }).pipe(Effect.uninterruptible);
