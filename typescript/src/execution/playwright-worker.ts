import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { compileFunction } from "node:vm";
import { format } from "node:util";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { Cause, Effect, Exit, Schema } from "effect";
import type { BrowserExecuteResponse } from "../runtime/browser-execution.js";

// Match the lease/screening entries: compiled packages need no hook; source tests resolve NodeNext imports.
if (import.meta.url.endsWith(".ts"))
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (context.parentURL?.endsWith(".ts") && /^\.\.?\/.*\.js$/.test(specifier)) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
      }
      return nextResolve(specifier, context);
    },
    load: (url, context, nextLoad) =>
      url.startsWith("file:") && url.endsWith(".ts")
        ? {
            format: "module",
            shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
              mode: "transform",
              sourceUrl: url,
            }),
          }
        : nextLoad(url, context),
  });
const { makeCredentialKeyboard } = await import("../destinations/credential-keyboard.js");
const { NativeWorkerOptions, NativeWorkerRequest } = await import("./playwright-execute.js");

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Native browser worker failed", { cause });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const outputLimit = 1_048_576;
const Target = Schema.Struct({
  targetInfo: Schema.Struct({ targetId: Schema.String, browserContextId: Schema.String }),
});
const identify = (context: BrowserContext, page: Page) =>
  Effect.gen(function* () {
    const session = yield* promise(() => context.newCDPSession(page));
    return yield* promise(() => session.send("Target.getTargetInfo")).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(Target)(value)),
      Effect.map((value) => value.targetInfo),
      Effect.mapError(asError),
      Effect.ensuring(promise(() => session.detach()).pipe(Effect.orDie)),
    );
  });

const script = (code: string, page: Page, context: BrowserContext, browser: Browser) =>
  Effect.gen(function* () {
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (error: boolean, args: readonly unknown[]) => {
      const line = `${format(...args)}\n`;
      const existing = error ? stderr : stdout;
      if (Buffer.byteLength(existing) + Buffer.byteLength(line) > outputLimit) {
        overflow = true;
        throw new Error("Native script output exceeds 1 MiB");
      }
      if (error) stderr += line;
      else stdout += line;
    };
    const console = {
      log: (...args: unknown[]) => append(false, args),
      info: (...args: unknown[]) => append(false, args),
      debug: (...args: unknown[]) => append(false, args),
      warn: (...args: unknown[]) => append(true, args),
      error: (...args: unknown[]) => append(true, args),
    };
    const result = yield* Effect.tryPromise({
      try: async () => {
        const invoke = compileFunction(`return (async () => {\n${code}\n})();`, [
          "page",
          "context",
          "browser",
          "console",
        ]);
        const value: unknown = await Reflect.apply(invoke, undefined, [
          page,
          context,
          browser,
          console,
        ]);
        if (overflow) throw new Error("Native script output exceeds 1 MiB");
        if (value === undefined) return undefined;
        const json = JSON.stringify(value, (_key, item: unknown) => {
          if (
            typeof item === "bigint" ||
            typeof item === "function" ||
            typeof item === "symbol" ||
            (typeof item === "number" && !Number.isFinite(item))
          )
            throw new Error("Native script result is not JSON serializable");
          return item;
        });
        if (json === undefined) throw new Error("Native script result is not JSON serializable");
        if (Buffer.byteLength(json) > outputLimit)
          throw new Error("Native script result exceeds 1 MiB");
        return JSON.parse(json) as unknown;
      },
      catch: asError,
    }).pipe(Effect.either);
    if (result._tag === "Left") {
      const error = result.left;
      const stack = error.stack ?? error.message;
      return {
        success: false,
        error: error.message,
        stdout,
        stderr: `${stderr}${stack}`.slice(0, outputLimit),
      } satisfies BrowserExecuteResponse;
    }
    return {
      success: true,
      ...(result.right === undefined ? {} : { result: result.right }),
      stdout,
      stderr,
    } satisfies BrowserExecuteResponse;
  });

const credential = (
  request: Extract<typeof NativeWorkerRequest.Type, { readonly kind: "credential" }>,
  context: BrowserContext,
  primaryTargetId: string,
) =>
  Effect.gen(function* () {
    const wanted = request.target.targetId ?? primaryTargetId;
    let owner: Page | undefined;
    for (const page of context.pages()) {
      if ((yield* identify(context, page)).targetId === wanted) owner = page;
    }
    if (owner === undefined) return yield* Effect.fail(new Error("Credential page closed"));
    const owningPage = owner;
    const sessions = new Map<string, CDPSession>();
    return yield* Effect.gen(function* () {
      // Same-process frames have no independent CDP target; their DOM is covered by the page session.
      sessions.set("page", yield* promise(() => context.newCDPSession(owningPage)));
      for (const frame of owningPage.frames()) {
        if (frame === owningPage.mainFrame()) continue;
        const connected = yield* promise(() => context.newCDPSession(frame)).pipe(Effect.either);
        if (connected._tag === "Right") sessions.set(String(sessions.size), connected.right);
        else if (!connected.left.message.includes("does not have a separate CDP session"))
          return yield* Effect.fail(connected.left);
      }
      const keyboard = makeCredentialKeyboard({
        sessions: () => [...sessions.keys()],
        send: (method, params, id) => {
          const session = sessions.get(id);
          if (session === undefined)
            return Effect.runPromise(Effect.fail(new Error("Credential CDP session unavailable")));
          switch (method) {
            case "DOM.getDocument":
              return session.send(
                method,
                Schema.decodeUnknownSync(
                  Schema.Struct({ depth: Schema.Number, pierce: Schema.Boolean }),
                )(params),
              );
            case "DOM.resolveNode":
              return session.send(
                method,
                Schema.decodeUnknownSync(Schema.Struct({ backendNodeId: Schema.Number }))(params),
              );
            case "Runtime.callFunctionOn":
              return session.send(
                method,
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    objectId: Schema.String,
                    functionDeclaration: Schema.String,
                    arguments: Schema.mutable(
                      Schema.Array(Schema.Struct({ value: Schema.Unknown })),
                    ),
                    returnByValue: Schema.Boolean,
                  }),
                )(params),
              );
            case "Runtime.releaseObject":
              return session.send(
                method,
                Schema.decodeUnknownSync(Schema.Struct({ objectId: Schema.String }))(params),
              );
            default:
              return Effect.runPromise(
                Effect.fail(new Error("Unsupported credential CDP command")),
              );
          }
        },
      });
      return yield* keyboard.insertText(request.target, request.text);
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach([...sessions.values()], (session) => promise(() => session.detach()), {
            discard: true,
          }),
        ).pipe(Effect.orDie),
      ),
    );
  });

await Effect.runPromise(
  Effect.gen(function* () {
    const port = parentPort;
    if (port === null) return yield* Effect.fail(new Error("Native worker requires parent IPC"));
    const options = yield* Schema.decodeUnknown(NativeWorkerOptions)(workerData).pipe(
      Effect.mapError(asError),
    );
    const browser = yield* promise(() =>
      chromium.connect(options.endpoint, { timeout: options.startupTimeoutMs }),
    );
    const context = yield* promise(() => browser.newContext());
    const page = yield* promise(() => context.newPage());
    const target = yield* identify(context, page);
    port.postMessage({
      kind: "ready",
      targetId: target.targetId,
      contextId: target.browserContextId,
    });
    const semaphore = yield* Effect.makeSemaphore(1);
    port.on("message", (value: unknown) => {
      const handle = Effect.gen(function* () {
        const request = yield* Schema.decodeUnknown(NativeWorkerRequest)(value).pipe(
          Effect.mapError(asError),
        );
        const response = yield* Effect.gen(function* () {
          if (request.kind === "execute")
            return yield* script(request.code, page, context, browser);
          return yield* credential(request, context, target.targetId);
        }).pipe(Effect.either);
        port.postMessage(
          response._tag === "Right"
            ? { kind: "response", id: request.id, value: response.right }
            : {
                kind: "failure",
                id: request.id,
                error:
                  request.kind === "credential"
                    ? "Credential insertion unavailable"
                    : response.left.message,
              },
        );
      }).pipe(semaphore.withPermits(1));
      Effect.runCallback(handle, {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) return;
          // Malformed IPC invalidates this worker rather than sending an uncorrelated response.
          port.close();
          queueMicrotask(() => {
            throw asError(Cause.squash(exit.cause));
          });
        },
      });
    });
  }),
);
