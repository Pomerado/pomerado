import { stageSources } from "./local-operation-stage.js";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { DialogDecider } from "../runtime/kernel-operation.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import type { CommitMark } from "../runtime/context.js";
import type { InputIssue } from "../runtime/errors.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { asksAsDeclared } from "./declared-questions.js";
import {
  sessionSignInAnswerMs,
  sessionSignInFillMs,
  sessionSignInSettleMs,
  type SessionSignInAnswer,
  type SessionSignInHook,
} from "../runtime/session-sign-in.js";
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
  /**
   * A mint step: the run counts as possibly sent from its first browser call, so a step that
   * stopped before one reads `not_sent`. Without it, a live run counts from its start.
   */
  readonly dispatchAtFirstCall?: boolean;
  readonly ask?: InputAsker;
  /**
   * The questions the host read itself: a build step's literal declarations, or the ones
   * publication reviewed. The host puts a script's request to its caller only when every question
   * matches one of them (`asksAsDeclared`); otherwise the script's `ask` fails as `Undeclared` and
   * nobody is asked. Absent, no script question is asked.
   */
  readonly declaredQuestions?: ScriptQuestionDeclarations;
  readonly decideDialog?: DialogDecider;
  /**
   * The host's sign-in for a script's `ensureSignedIn`, on the same browser. Absent, the script's
   * `ensureSignedIn` answers that it did not sign in again.
   */
  readonly signIn?: SessionSignInHook;
}
export interface LocalOperationJournal {
  readonly effect: "not_sent" | "possible" | "verified";
  readonly confirmation?: "message" | "readback";
  readonly commits: readonly CommitMark[];
}
export class LocalOperationFailure extends Error {
  override readonly name = "LocalOperationFailure";
  /**
   * The child reported this failure with its final journal. False when the host lost the
   * result, as at a deadline or a child exit: the journal is then the last one the child
   * streamed as it ran.
   */
  readonly reported: boolean;
  /** The host could not sign the page in again while the script waited in `ensureSignedIn`. */
  readonly sessionLoss?: "session_not_kept";
  constructor(
    message: string,
    readonly journal: LocalOperationJournal,
    readonly code?: string,
    readonly tag?: string,
    /** Where the operation's input schema rejected its input, on an `InvalidInput`. */
    readonly inputIssues?: readonly InputIssue[],
    options: { readonly reported?: boolean; readonly sessionLoss?: "session_not_kept" } = {},
  ) {
    super(message);
    this.reported = options.reported ?? true;
    if (options.sessionLoss !== undefined) this.sessionLoss = options.sessionLoss;
  }
}
export interface LocalOperationOutput extends LocalOperationJournal {
  readonly output: unknown;
  /** The declared schemas, and in contract mode the declared questions. */
  readonly schemas: {
    readonly input: unknown;
    readonly output: unknown;
    readonly questions?: ScriptQuestionDeclarations;
  };
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
/**
 * One script's `ensureSignedIn`, answered within the sign-in's bounds: no step of the host's
 * sign-in starts after the filling bound, and past the answer bound the host stops it, waits for
 * its last step to end and refuses. An interrupted request (the script ended or the child exited)
 * stops the sign-in the same way.
 */
export const answerSessionSignIn = (
  signIn: SessionSignInHook,
  bounds: { readonly fillMs: number; readonly answerMs: number; readonly settleMs: number } = {
    fillMs: sessionSignInFillMs,
    answerMs: sessionSignInAnswerMs,
    settleMs: sessionSignInSettleMs,
  },
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stop = new AbortController();
    const signingIn = yield* Effect.forkDaemon(
      signIn({ untilMs: now + bounds.fillMs, stop: stop.signal }),
    );
    // Stop the sign-in at its next step and wait for it to end, so nothing after this shares the
    // browser with it.
    const settle = Effect.sync(() => stop.abort()).pipe(
      Effect.zipRight(Fiber.await(signingIn).pipe(Effect.timeoutOption(bounds.settleMs))),
      Effect.zipRight(Fiber.interrupt(signingIn)),
    );
    const raced = yield* Effect.raceFirst(
      Fiber.join(signingIn).pipe(Effect.map((answer) => ({ answer }))),
      Effect.sleep(bounds.answerMs).pipe(Effect.as({ expired: true as const })),
    ).pipe(Effect.onInterrupt(() => settle));
    if ("answer" in raced) return raced.answer;
    yield* settle;
    return { outcome: "refused", cause: "session_sign_in_failed" } satisfies SessionSignInAnswer;
  });
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
    if (message.kind === "sign_in")
      return options.signIn === undefined
        ? Effect.fail(new Error("Local operation sign-in is unavailable"))
        : suspended(deadline, answerSessionSignIn(options.signIn));
    if (message.kind === "ask") {
      if (options.ask === undefined)
        return Effect.fail(new Error("Local operation input is unavailable"));
      // The child runs minted code, so only the declarations the host read decide what is asked.
      if (!asksAsDeclared(message.request, options.declaredQuestions ?? {}))
        return Effect.fail(
          Object.assign(new Error("Local operation asked beyond its declared questions"), {
            code: "Undeclared",
          }),
        );
      return suspended(deadline, options.ask(message.request)).pipe(
        // ScriptInput validates raw answers in the child; the host has already typed them.
        Effect.map((answers) =>
          Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.value])),
        ),
      );
    }
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
          message.inputIssues,
          message.sessionLoss === undefined ? {} : { sessionLoss: message.sessionLoss },
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
    schemas: {
      input: result.inputSchema,
      output: result.outputSchema,
      ...(result.questions === undefined ? {} : { questions: result.questions }),
    },
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
        ...(options.target === "pureFiles" || options.browser === undefined
          ? { offline: true }
          : {}),
        ...(options.dispatchAtFirstCall === true ? { dispatchAtFirstCall: true } : {}),
        ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
        ...(options.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
        ...(options.signIn !== undefined &&
        options.browser !== undefined &&
        options.mode !== "contract" &&
        options.target !== "pureFiles"
          ? { signIn: true }
          : {}),
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
                    undefined,
                    undefined,
                    { reported: false },
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
