import { stageSources } from "./local-operation-stage.js";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { DialogDecider } from "../runtime/kernel-operation.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import type { CommitMark } from "../runtime/context.js";
import { createLocalProcess, type LocalProcess, type LocalProcessResult } from "./local-process.js";
import { localError, localOutputLimit } from "./local-path.js";
import { LocalOperationMessage, type LocalOperationResult } from "./local-operation-protocol.js";
import type { LocalWorkspace } from "./local-workspace.js";

export interface LocalOperationOptions {
  readonly workspace: LocalWorkspace;
  readonly entrypoint: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input?: unknown;
  readonly retainedOutput?: { readonly value: unknown };
  readonly browser?: { readonly sessionId: string; readonly executeResponse: BrowserExecute };
  readonly siteOrigin?: string;
  readonly siteDomain?: string;
  readonly timeoutMs?: number;
  readonly mode?: "run" | "contract";
  readonly validateInput?: boolean;
  readonly target?: "browser" | "pureFiles";
  readonly ask?: InputAsker;
  readonly decideDialog?: DialogDecider;
}
export interface LocalOperationJournal {
  readonly effect: "not_sent" | "possible" | "verified";
  readonly confirmation?: "message" | "readback";
  readonly commits: readonly CommitMark[];
}
export class LocalOperationFailure extends Error {
  override readonly name = "LocalOperationFailure";
  constructor(
    message: string,
    readonly journal: LocalOperationJournal,
    readonly code?: string,
    readonly tag?: string,
  ) {
    super(message);
  }
}
export interface LocalOperationOutput extends LocalOperationJournal {
  readonly output: unknown;
  readonly schemas: { readonly input: unknown; readonly output: unknown };
  readonly stdout: string;
  readonly stderr: string;
  readonly write?: WriteDeclaration;
  readonly inputDecodes?: true;
}

const sendToChild = (process: LocalProcess, message: object) =>
  Effect.async<void, Error>((resume) => {
    if (!process.child.connected || process.child.send === undefined) {
      resume(Effect.fail(new Error("Local child IPC disconnected")));
      return;
    }
    process.child.send(message, (error) =>
      resume(error === null ? Effect.void : Effect.fail(localError(error))),
    );
  });
const failureCode = (error: Error) =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;
const suspended = <A, E>(deadline: Deadline, run: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => deadline.suspend()),
    () => run,
    (resume) => Effect.sync(resume),
  );
const handleRequest = (
  options: LocalOperationOptions,
  deadline: Deadline,
  message: Exclude<LocalOperationMessage, { kind: "result" | "error" | "cancel" | "journal" }>,
): Effect.Effect<unknown, Error> =>
  Effect.suspend<unknown, Error, never>(() => {
    if (message.kind === "execute") {
      if (options.mode === "contract" || options.target === "pureFiles")
        return Effect.fail(
          new Error("Browser access is unavailable for this local operation mode"),
        );
      if (options.browser === undefined || message.sessionId !== options.browser.sessionId)
        return Effect.fail(new Error("Local operation browser session mismatch"));
      return options.browser.executeResponse(message.body.code, message.body.timeout_sec);
    }
    if (message.kind === "ask")
      return options.ask === undefined
        ? Effect.fail(new Error("Local operation input is unavailable"))
        : suspended(deadline, options.ask(message.request)).pipe(
            // ScriptInput validates raw answers in the child; the host has already typed them.
            Effect.map((answers) =>
              Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.value])),
            ),
          );
    return options.decideDialog === undefined
      ? Effect.fail(new Error("Local operation dialog decision is unavailable"))
      : suspended(deadline, options.decideDialog({ ...message.report, interactionId: message.id }));
  });

const handleTerminalMessage = (
  message: Extract<LocalOperationMessage, { kind: "result" | "error" | "cancel" }>,
  completed: Deferred.Deferred<LocalOperationResult, Error>,
  pending: Map<string, Fiber.RuntimeFiber<void, never>>,
) => {
  if (message.kind === "result") {
    Effect.runSync(
      pending.size === 0
        ? Deferred.succeed(completed, message)
        : Deferred.fail(
            completed,
            new Error(
              "Local operation returned while host requests were pending; completion uncertain",
            ),
          ),
    );
    return;
  }
  if (message.kind === "error") {
    Effect.runSync(
      Deferred.fail(
        completed,
        new LocalOperationFailure(
          message.error,
          operationJournal(message),
          message.code,
          message.tag,
        ),
      ),
    );
    return;
  }
  if (message.kind === "cancel") {
    const fiber = pending.get(message.id);
    if (fiber !== undefined) Effect.runCallback(Fiber.interrupt(fiber));
    return;
  }
};

const decodeMessage = (raw: unknown) =>
  Effect.try({
    try: () => {
      if (serialize(raw).byteLength > localOutputLimit)
        throw new Error("Local operation IPC exceeds output limit");
      return raw;
    },
    catch: localError,
  }).pipe(Effect.flatMap(Schema.decodeUnknown(LocalOperationMessage)), Effect.mapError(localError));

const receiveOperation = (
  process: LocalProcess,
  options: LocalOperationOptions,
  deadline: Deadline,
) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<LocalOperationResult, Error>();
    const pending = new Map<string, Fiber.RuntimeFiber<void, never>>();
    let finished = false;
    let current: LocalOperationJournal = { effect: "not_sent", commits: [] };
    const listener = (raw: unknown) => {
      if (finished) return;
      const decoded = Effect.runSync(decodeMessage(raw).pipe(Effect.either));
      if (decoded._tag === "Left") {
        finished = true;
        Effect.runSync(Deferred.fail(completed, decoded.left));
        return;
      }
      const message = decoded.right;
      if (message.kind === "journal" || message.kind === "error" || message.kind === "result")
        current = operationJournal(message);
      if (message.kind === "journal") return;
      if (message.kind === "result" || message.kind === "error" || message.kind === "cancel") {
        if (message.kind !== "cancel") finished = true;
        handleTerminalMessage(message, completed, pending);
        return;
      }
      if (pending.has(message.id)) {
        Effect.runSync(Deferred.fail(completed, new Error("Duplicate local operation request")));
        return;
      }
      const task = handleRequest(options, deadline, message).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit))
            return sendToChild(process, { kind: "reply", id: message.id, value: exit.value });
          const error = localError(Cause.squash(exit.cause));
          const code = failureCode(error);
          return sendToChild(process, {
            kind: "failure",
            id: message.id,
            error: error.message,
            ...(code === undefined ? {} : { code }),
          });
        }),
        Effect.catchAll((error) => Deferred.fail(completed, error)),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(message.id);
          }),
        ),
      );
      pending.set(message.id, Effect.runFork(task));
    };
    process.child.on("message", listener);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        process.child.off("message", listener);
        yield* Effect.forEach(
          pending.values(),
          (fiber) =>
            Fiber.interrupt(fiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)
                  ? Effect.die(localError(Cause.squash(exit.cause)))
                  : Effect.void,
              ),
            ),
          {
            discard: true,
            concurrency: "unbounded",
          },
        );
      }),
    );
    const completion = Deferred.await(completed);
    const exited = process.result.pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? completion
          : Effect.fail(
              new Error(
                `Local operation child exited ${result.exitCode ?? result.signal}; completion uncertain`,
              ),
            ),
      ),
    );
    return {
      completed: completion.pipe(Effect.raceFirst(exited)),
      pending,
      journal: Effect.sync(() => current),
    };
  });

const operationJournal = (
  result: Pick<LocalOperationResult, "effect" | "commits" | "confirmation">,
): LocalOperationJournal => ({
  effect:
    result.effect === "not_started"
      ? "not_sent"
      : result.effect === "may_have_dispatched"
        ? "possible"
        : "verified",
  commits: result.commits,
  ...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
});
const operationOutput = (
  result: LocalOperationResult,
  output: LocalProcessResult,
): LocalOperationOutput => {
  return {
    output: result.output,
    schemas: { input: result.inputSchema, output: result.outputSchema },
    stdout: output.stdout,
    stderr: output.stderr,
    ...operationJournal(result),
    ...(result.write === undefined ? {} : { write: result.write }),
    ...(result.inputDecodes === undefined ? {} : { inputDecodes: result.inputDecodes }),
  };
};

/** Executes one immutable reviewed snapshot through the original operation runtime, without replay. */
export const runLocalOperation = (
  options: LocalOperationOptions,
): Effect.Effect<LocalOperationOutput, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const timeoutMs = options.timeoutMs ?? 20 * 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(new Error("Local operation timeout must be positive and finite"));
      const deadline = Deadline.after(timeoutMs);
      const staged = yield* stageSources(options);
      const process = yield* createLocalProcess({
        command: globalThis.process.execPath,
        args: [
          fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "./local-operation-child.ts"
                : "./local-operation-child.js",
              import.meta.url,
            ),
          ),
        ],
        cwd: staged.directory,
        environment: options.workspace.environment,
        ipc: true,
      });
      const response = yield* receiveOperation(process, options, deadline);
      yield* sendToChild(process, {
        kind: "start",
        entrypoint: staged.entrypoint,
        input: options.input,
        ...(options.retainedOutput === undefined ? {} : { retainedOutput: options.retainedOutput }),
        sessionId: options.browser?.sessionId ?? "offline",
        timeoutMs,
        mode: options.mode ?? "run",
        ...(options.validateInput === undefined ? {} : { validateInput: options.validateInput }),
        ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
        ...(options.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
      });
      const result = yield* response.completed.pipe(
        Effect.raceFirst(
          deadline.awaitExpiry.pipe(
            Effect.zipRight(
              Effect.fail(
                new Error("Local operation deadline expired; execution was not replayed"),
              ),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const failure =
              error instanceof LocalOperationFailure
                ? error
                : new LocalOperationFailure(
                    error.message,
                    yield* response.journal,
                    failureCode(error),
                  );
            yield* process.close;
            const channels = yield* process.result.pipe(Effect.either);
            return yield* Effect.fail(
              Object.assign(
                failure,
                channels._tag === "Right"
                  ? { stdout: channels.right.stdout, stderr: channels.right.stderr }
                  : { cause: channels.left },
              ),
            );
          }),
        ),
      );
      yield* process.close;
      const output = yield* process.result.pipe(
        Effect.raceFirst(
          deadline.awaitExpiry.pipe(
            Effect.zipRight(
              Effect.fail(new Error("Local operation child did not exit after result")),
            ),
          ),
        ),
      );
      return operationOutput(result, output);
    }),
  );
