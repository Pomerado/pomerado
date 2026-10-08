import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Schema } from "effect";

// Source-mode entry follows the existing lease/screening workers; compiled packages need no hook.
if (import.meta.url.endsWith(".ts"))
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (context.parentURL?.startsWith("file:") && /^\.\.?\/.*\.js$/.test(specifier)) {
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
const { LocalOperationStart, LocalOperationReply } = await import("./local-operation-protocol.js");
const { localError, localOutputLimit } = await import("./local-path.js");
const { isKernelOperation } = await import("../runtime/kernel-operation.js");
const { executeKernelOperation } = await import("../runtime/kernel-operation-run.js");
const { decodeKernelOperationInput } = await import("../runtime/kernel-operation-validation.js");
const { contractJsonSchema } = await import("../runtime/operation.js");
const { ExecutionContext, makeEffectJournal } = await import("../runtime/context.js");
const { Deadline } = await import("../runtime/deadline.js");
const { makeKernelCompatibility } = await import("../runtime/kernel-compatibility.js");
const { InvalidInput, InvalidOutput } = await import("../runtime/errors.js");
const { BrowserExecuteResponse } = await import("../runtime/browser-execution.js");
const { makeScriptInput, ScriptInput, ScriptInputFailure } =
  await import("../runtime/script-input.js");
const { InputAnswers } = await import("../runtime/input-request.js");
const { DialogChoice, DialogFailure } = await import("../runtime/dialogs.js");
const { SessionSignInAnswer } = await import("../runtime/session-sign-in.js");
const { FileOutput, FileRefusalReason, FileRefused, PlacedFile } = await import("../runtime/files.js");
const replies = new Map<string, (result: Effect.Effect<unknown, Error>) => void>();
const send = (message: unknown) =>
  Effect.try({
    try: () => {
      if (process.send === undefined || !process.connected)
        throw new Error("Local operation IPC unavailable");
      if (serialize(message).byteLength > localOutputLimit)
        throw new Error("Local operation IPC exceeds output limit");
      if (typeof message !== "object" || message === null)
        throw new Error("Local IPC message must be an object");
      process.send(message);
    },
    catch: localError,
  });
const call = (payload: object) =>
  Effect.async<unknown, Error>((resume) => {
    const id = randomUUID();
    replies.set(id, resume);
    Effect.runCallback(send({ id, ...payload }), {
      onExit: (exit) => {
        if (Exit.isFailure(exit)) {
          replies.delete(id);
          resume(Effect.fail(localError(Cause.squash(exit.cause))));
        }
      },
    });
    return Effect.sync(() => {
      replies.delete(id);
    }).pipe(Effect.zipRight(send({ kind: "cancel", id })), Effect.orDie);
  });
const start = await Effect.runPromise(
  Effect.async<typeof LocalOperationStart.Type, Error>((resume) => {
    process.on("message", (message: unknown) => {
      const initial = Schema.decodeUnknownEither(LocalOperationStart)(message);
      if (initial._tag === "Right") {
        resume(Effect.succeed(initial.right));
        return;
      }
      const reply = Schema.decodeUnknownEither(LocalOperationReply)(message);
      if (reply._tag === "Left") {
        resume(Effect.fail(new Error("Malformed local IPC message")));
        return;
      }
      const complete = replies.get(reply.right.id);
      replies.delete(reply.right.id);
      if (reply.right.kind === "reply") complete?.(Effect.succeed(reply.right.value));
      else
        complete?.(
          Effect.fail(Object.assign(new Error(reply.right.error), { code: reply.right.code })),
        );
    });
    process.on("disconnect", () => {
      const failure = new Error("Local operation host disconnected; completion uncertain");
      for (const resumeReply of replies.values()) resumeReply(Effect.fail(failure));
      replies.clear();
    });
  }),
);
const baseJournal = await Effect.runPromise(makeEffectJournal);
const journalState = Effect.gen(function* () {
  const confirmation = yield* baseJournal.confirmation;
  return {
    effect: yield* baseJournal.state,
    commits: yield* baseJournal.commits,
    ...(confirmation === undefined ? {} : { confirmation }),
  };
});
const publishJournal = journalState.pipe(
  Effect.flatMap((metadata) => send({ kind: "journal", ...metadata })),
  Effect.orDie,
);
const journal: typeof baseJournal = {
  ...baseJournal,
  enteringDispatch: baseJournal.enteringDispatch.pipe(Effect.tap(() => publishJournal)),
  enteringCommit: (name) => baseJournal.enteringCommit(name).pipe(Effect.tap(() => publishJournal)),
  confirmed: (confirmation) =>
    baseJournal.confirmed(confirmation).pipe(Effect.tap(() => publishJournal)),
  verified: baseJournal.verified.pipe(Effect.tap(() => publishJournal)),
  declareCommits: (names) =>
    baseJournal.declareCommits(names).pipe(Effect.tap(() => publishJournal)),
};
/**
 * One run of the script through the runtime's runner: each execute call goes to the host, which
 * owns the browser, once it is marked as a possible dispatch. The runner marks a live run from its
 * start. A mint step is marked only here, at each browser call, so one that stopped before any call
 * reads not sent. Capture and events are the host's, so the child's are empty.
 */
const executeLocally = (operation: Parameters<typeof executeKernelOperation>[0]) =>
  Effect.gen(function* () {
    const deadline = Deadline.after(start.timeoutMs);
    // A run with no browser never marks, whatever its script tries.
    const atFirstCall = start.dispatchAtFirstCall === true && start.offline !== true;
    const kernel = makeKernelCompatibility(start.sessionId, (code, timeoutSec) =>
      (atFirstCall ? journal.enteringDispatch : Effect.void).pipe(
        Effect.zipRight(
          call({
            kind: "execute",
            sessionId: start.sessionId,
            body: { code, timeout_sec: timeoutSec ?? 60 },
          }),
        ),
        Effect.flatMap((value) => Schema.decodeUnknown(BrowserExecuteResponse)(value)),
        Effect.mapError(localError),
      ),
    );
    const scriptInput = makeScriptInput(
      operation.questions,
      (request) =>
        call({ kind: "ask", request }).pipe(
          Effect.flatMap((value) => Schema.decodeUnknown(InputAnswers)(value)),
          Effect.mapError(
            (error) =>
              new ScriptInputFailure({
                code: "code" in error && error.code === "NoResponse" ? "NoResponse" : "Unavailable",
              }),
          ),
        ),
      deadline,
    );
    // The host refuses a file with a `FileRefused:<reason>` code; anything else is unavailable.
    const fileRefusal = (error: Error) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : "";
      const [, named, sent] = code.split(":");
      const reason = Schema.decodeUnknownOption(FileRefusalReason)(named);
      return new FileRefused({
        reason: reason._tag === "Some" ? reason.value : "unavailable",
        // Only a refusal the host says came before setting the input sent nothing.
        ...(reason._tag === "Some" && sent !== "dispatched" ? {} : { dispatched: true }),
      });
    };
    return yield* executeKernelOperation(operation, start.input, {
      kernel,
      ...(start.files === true && start.offline !== true
        ? {
            files: {
              // A build's step counts as possibly sent once a placement set, or may have set,
              // the input; a refusal before that reached no page.
              place: (request) =>
                call({ kind: "file_place", ...request }).pipe(
                  Effect.flatMap((value) => Schema.decodeUnknown(PlacedFile)(value)),
                  Effect.mapError((error) => fileRefusal(localError(error))),
                  Effect.tapBoth({
                    onSuccess: () => (atFirstCall ? journal.enteringDispatch : Effect.void),
                    onFailure: (refused) =>
                      atFirstCall && refused.dispatched === true
                        ? journal.enteringDispatch
                        : Effect.void,
                  }),
                ),
              arm: () =>
                call({ kind: "file_arm" }).pipe(
                  Effect.flatMap((value) => Schema.decodeUnknown(Schema.String)(value)),
                  Effect.mapError((error) => fileRefusal(localError(error))),
                ),
              collect: (request) =>
                call({ kind: "file_collect", ...request }).pipe(
                  Effect.flatMap((value) => Schema.decodeUnknown(FileOutput)(value)),
                  Effect.mapError((error) => fileRefusal(localError(error))),
                ),
            },
          }
        : {}),
      sessionId: start.sessionId,
      ...(start.siteOrigin === undefined ? {} : { siteOrigin: start.siteOrigin }),
      ...(start.siteDomain === undefined ? {} : { siteDomain: start.siteDomain }),
      ...(start.offline === true ? { offline: true } : {}),
      dialogs: (report) =>
        call({ kind: "dialog", report }).pipe(
          Effect.flatMap((value) => Schema.decodeUnknown(DialogChoice)(value)),
          Effect.mapError(() => new DialogFailure({ reason: "unavailable" })),
        ),
      // The host checks the page and signs it in again; a refusal fails the script, which the
      // runtime reports as a session the site did not keep.
      ...(start.signIn === true
        ? {
            signIn: () =>
              Effect.runPromise(
                call({ kind: "sign_in" }).pipe(
                  Effect.flatMap((value) => Schema.decodeUnknown(SessionSignInAnswer)(value)),
                  Effect.flatMap((answer) =>
                    answer.outcome === "signed_in"
                      ? Effect.succeed({ signedInAgain: answer.signedInAgain })
                      : Effect.fail(new Error(`The host did not sign in again: ${answer.cause}`)),
                  ),
                ),
              ),
          }
        : {}),
    }).pipe(
      Effect.provideService(ExecutionContext, {
        deadline,
        journal: atFirstCall ? { ...journal, enteringDispatch: Effect.void } : journal,
        events: { emit: () => Effect.void },
        capture: { start: Effect.void, finish: Effect.void },
      }),
      Effect.provideService(ScriptInput, scriptInput),
      Effect.scoped,
    );
  });
const extractCurrentContract = (
  operation: Parameters<typeof executeKernelOperation>[0],
  schemas: { inputSchema: unknown; outputSchema: unknown },
) =>
  Effect.gen(function* () {
    if (start.validateInput === true || start.retainedOutput !== undefined)
      yield* decodeKernelOperationInput(operation, start.input);
    if (start.retainedOutput !== undefined) {
      yield* Schema.decodeUnknown(operation.output)(start.retainedOutput.value).pipe(
        Effect.mapError(
          (cause) =>
            new InvalidOutput({
              operation: operation.name,
              cause,
              output: start.retainedOutput?.value,
            }),
        ),
      );
    }
    yield* send({
      kind: "result",
      ...schemas,
      effect: "not_started",
      commits: [],
      ...(operation.write === undefined ? {} : { write: operation.write }),
      ...(operation.questions === undefined ? {} : { questions: operation.questions }),
      ...(start.validateInput === true || start.retainedOutput !== undefined
        ? { inputDecodes: true }
        : {}),
    });
  });

await Effect.runPromise(
  Effect.gen(function* () {
    const imported: unknown = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(start.entrypoint).href),
      catch: localError,
    });
    const operation: unknown =
      typeof imported === "object" && imported !== null
        ? Reflect.get(imported, "default")
        : undefined;
    if (!isKernelOperation(operation))
      return yield* Effect.fail(
        new Error("Local execution requires an original defineOperation Kernel script"),
      );
    const schemas = {
      inputSchema: contractJsonSchema(operation.input),
      outputSchema: contractJsonSchema(operation.output),
    };
    if (start.mode === "contract") return yield* extractCurrentContract(operation, schemas);
    const output = yield* executeLocally(operation);
    const confirmation = yield* journal.confirmation;
    yield* send({
      kind: "result",
      output,
      ...schemas,
      ...(operation.write === undefined ? {} : { write: operation.write }),
      inputDecodes: true,
      effect: yield* journal.state,
      commits: yield* journal.commits,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
  }).pipe(
    Effect.catchAll((error) =>
      journalState.pipe(
        Effect.flatMap((metadata) =>
          send({
            kind: "error",
            error: error.message || error.name,
            ...metadata,
            ...("_tag" in error && typeof error._tag === "string" ? { tag: error._tag } : {}),
            ...("sessionLoss" in error && error.sessionLoss === "session_not_kept"
              ? { sessionLoss: "session_not_kept" }
              : {}),
            ...(error instanceof InvalidInput && error.issues !== undefined
              ? { inputIssues: error.issues }
              : {}),
            ...("code" in error && typeof error.code === "string"
              ? { code: error.code }
              : "_tag" in error && typeof error._tag === "string"
                ? { code: error._tag }
                : {}),
          }),
        ),
      ),
    ),
  ),
);
process.disconnect?.();
