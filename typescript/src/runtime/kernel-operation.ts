import { BrowserActionTimeout, nativeActionTimeout } from "./browser-action-timeout.js";
import { Effect, Either, Schema } from "effect";
import type { Context } from "effect";
import { DialogChoice, DialogFailure, DialogType } from "./dialogs.js";
import { ChallengeFailure, challengeSolverWaitMs } from "./challenge.js";
import { ScriptInput, ScriptInputFailure } from "./script-input.js";
import type {
  AskSpecOf,
  ScriptAnswer,
  ScriptAnswerOf,
  ScriptQuestionDeclarations,
} from "./script-input.js";
import type { EffectJournal, WriteConfirmation } from "./context.js";
import type { Deadline } from "./deadline.js";
import { WriteConfirmationRefused, type Dispatch } from "./errors.js";
import type { WriteDeclaration } from "./operation.js";
import { kernelTimeoutSec } from "./kernel-execute-client.js";
import type { KernelExecuteClient } from "./kernel-execute-client.js";
import { inspectSignInRejection } from "./sign-in-rejection.js";
import { FileRefused, type FileChannel, type ScriptFiles } from "./files.js";
import type { SignInRejectionMarker } from "./sign-in-rejection.js";
import {
  CredentialsRejected,
  OperationFailure,
  operationErrors,
  scriptFailure,
  type ScriptFailure,
} from "./operation-failure.js";

export { OperationFailure, operationErrors };

/** Longest dialog message the host is sent. */
export const dialogMessageLimit = 16_384;

/**
 * A native dialog a call left open on Kernel's page, as the script reports it to the host.
 * `step` is the script's name for the step that raised it, the same on every run, and `url` is
 * the page's URL when it showed.
 */
export const DialogReport = Schema.Struct({
  step: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/)),
  type: DialogType,
  message: Schema.String,
  url: Schema.String.pipe(Schema.maxLength(8_192)),
});
export type DialogReport = typeof DialogReport.Type;

/** The host's side of a dialog decision, over the sandbox channel. */
export type DialogDecider = (
  request: DialogReport & { readonly interactionId: string },
) => Effect.Effect<DialogChoice, DialogFailure>;

/** Runs a host exchange and throws its own typed failure, not Effect's wrapper. */
const settle = async <A, E extends Error>(effect: Effect.Effect<A, E>): Promise<A> => {
  const outcome = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(outcome)) throw outcome.left;
  return outcome.right;
};

export { kernelTimeoutSec } from "./kernel-execute-client.js";
export type { KernelExecuteClient } from "./kernel-execute-client.js";

/**
 * What a Kernel script receives. Its browser work is its own calls to
 * `kernel.browsers.playwright.execute(sessionId, { code, timeout_sec })`; each call's code is plain
 * Playwright code that Kernel runs on its own `page`, with outside values written into it.
 */
/**
 * The context's `ask`, typed by the contract's declared questions: `ask("id")` returns that
 * answer, `ask(["a", "b"])` and `ask({ seat: { options }, code: {} })` return one per id.
 */
export interface ScriptAsk<Questions extends ScriptQuestionDeclarations> {
  <Id extends keyof Questions & string>(id: Id): Promise<ScriptAnswerOf<Questions[Id]>>;
  <const Ids extends ReadonlyArray<keyof Questions & string>>(
    ids: Ids,
  ): Promise<{ readonly [Id in Ids[number]]: ScriptAnswerOf<Questions[Id]> }>;
  <Id extends keyof Questions & string>(questions: {
    readonly [Asked in Id]: AskSpecOf<Questions[Asked]>;
  }): Promise<{ readonly [Asked in Id]: ScriptAnswerOf<Questions[Asked]> }>;
}

export interface KernelOperationContext<
  Input,
  Questions extends ScriptQuestionDeclarations = ScriptQuestionDeclarations,
> {
  /** Kernel's SDK client, `new Kernel({ maxRetries: 0 })` with the sandbox's `KERNEL_API_KEY`. */
  readonly kernel: KernelExecuteClient;
  /** The job's own browser. Every call uses this session and no other. */
  readonly sessionId: string;
  /** The site's primary origin from the host's plan. Code never embeds the site hostname. */
  readonly siteOrigin: string | undefined;
  /**
   * The site's registrable domain, which the host computed from `siteOrigin` with the public
   * suffix list, private suffixes included: every https host equal to it or ending in "." plus it
   * is the site. Undefined when the site has none (an IP address, localhost, a bare suffix) or no
   * live browser; then only `siteOrigin` itself is the site. Never derive it from `siteOrigin`.
   */
  readonly siteDomain: string | undefined;
  readonly input: Input;
  /**
   * Asks the host to decide a native dialog a call left open. Kernel keeps a dialog open between
   * calls, and the deadline pauses while the host decides. The raising call keeps the dialog and
   * returns what it showed, without awaiting the action that raised it:
   *
   *     const shown = new Promise((resolve) => page.once("dialog", (dialog) => {
   *       globalThis.dialog = dialog;
   *       resolve({ type: dialog.type(), message: dialog.message(), url: page.url() });
   *     }));
   *     void page.click("#delete").catch(() => {});
   *     return await shown;
   *
   * The script passes that with its step name, and the next call applies the choice with
   * `await globalThis.dialog.accept(promptText)` or `await globalThis.dialog.dismiss()`.
   */
  readonly decideDialog: (report: DialogReport) => Promise<DialogChoice>;
  /**
   * Asks the job's caller between two calls: a choice only the page offers now (its options
   * passed here), a code the site just sent, or anything else only the caller knows. Each id is
   * declared with its type and prompt in the contract's `questions`. The browser stays open and
   * the deadline pauses while the caller decides; the next call gets the answers written into
   * its code. It throws `ScriptInputFailure` when no usable answer comes, such as `NoResponse`.
   */
  readonly ask: ScriptAsk<Questions>;
  /**
   * One runtime-written call that waits up to 30 s for Kernel's solver to clear a bot challenge,
   * polling `ready`, a code body that returns true once the page is usable. It throws
   * `ChallengeFailure` with the time waited when the challenge stays, so the host can climb.
   */
  readonly waitPastChallenge: (options: { readonly ready: string }) => Promise<void>;
  /**
   * Marks the run's write as landed, once a call has read it back from the site: the saved
   * record or the confirmation with its reference, tied to this submission. Call `verified()`
   * with no argument just before returning. A later execute call makes the effect possible again.
   * Never call it for a missing or generic confirmation. An offline run ignores it. The run
   * reports a read-back, and a write declared `unverifiable` throws `WriteConfirmationRefused`,
   * since its declaration says there is none. `{ confirmation: "message" }` stays accepted for
   * revisions published before writes stopped passing it.
   */
  readonly verified: (options?: { readonly confirmation?: WriteConfirmation }) => void;
  /**
   * Marks the write's named commit step, one of its contract's `write.commits`, as sent. Call it
   * right before the execute call whose code can send that step, such as the click on Place
   * order. The mark reads `sent` from then on, even if the call fails, because the site may
   * already have the request. An offline run ignores it. During maintenance, a step the original
   * confirmed, or sent without this run's read-back finding it missing, throws `CommitAlreadySent`
   * before its execute call.
   */
  readonly enteringCommit: (name: string) => void;
  /** Time left before the operation's deadline, for choosing `timeout_sec`. */
  readonly remainingMs: () => number;
  /** Inspect a value-free marker on the authorized page; throw only when it is visible. */
  readonly rejectedSignIn: (options: SignInRejectionMarker) => Promise<void>;
  /**
   * Asks the host to make sure the page is still signed in, after a full page load that may have
   * lost the session. The host checks its signed-in marker on the current page without moving it,
   * and signs in again only when the page is signed out: `signedInAgain` says it did, so the script
   * opens the page it was on again. The runtime already calls it once before the script runs. The
   * deadline pauses while the host works, and every other browser call the script makes meanwhile
   * waits until it is done; a call while one is under way joins it. A run with no sign-in, or an
   * offline run, gets `{ signedInAgain: false }`. When the host cannot sign in again it throws
   * `OperationFailure` with `sessionLoss: "session_not_kept"`; a value the site refused throws
   * `CredentialsRejected`. Never call it between a write's commit and its read-back.
   */
  readonly ensureSignedIn: () => Promise<{ readonly signedInAgain: boolean }>;
  /**
   * The run's files: `place` puts a caller's file into a file input on the site, `collect`
   * captures a download the page starts. The bytes stay with the host. A run without the host's
   * file service, such as an offline run, throws `OperationFailure` on either.
   */
  readonly files: ScriptFiles;
  readonly errors: typeof operationErrors;
}

export interface KernelOperation<Input, EncodedInput, Output, EncodedOutput> {
  readonly kind: "kernel";
  readonly name: string;
  readonly input: Schema.Schema<Input, EncodedInput>;
  readonly output: Schema.Schema<Output, EncodedOutput>;
  /** The questions `ask` may put to the caller during a run, by id. */
  readonly questions?: ScriptQuestionDeclarations;
  /** Present on every write script. */
  readonly write?: WriteDeclaration;
  readonly run: (context: KernelOperationContext<Input>) => Promise<Output>;
}

const WaitResult = Schema.Struct({ cleared: Schema.Boolean, waitedMs: Schema.Number });

/** The solver wait as one call on Kernel's page, polling the script's own readiness check. */
const waitPastChallengeCode = (ready: string, limitMs: number) =>
  `const started = Date.now();
const ready = async () => {
${ready}
};
while (true) {
  try { if (await ready()) return { cleared: true, waitedMs: Date.now() - started }; } catch {}
  if (Date.now() - started >= ${limitMs}) return { cleared: false, waitedMs: Date.now() - started };
  await new Promise((resolve) => setTimeout(resolve, 250));
}`;

type Declared = ScriptQuestionDeclarations[string];
/**
 * The context's `ask` over the runner's script input. The runtime checks every id and option
 * against the contract's declarations; the declared types only guide the script's author.
 */
const scriptAsk = (
  scriptInput: Context.Tag.Service<ScriptInput> | undefined,
): ScriptAsk<ScriptQuestionDeclarations> => {
  function ask(id: string): Promise<ScriptAnswerOf<Declared>>;
  function ask<const Ids extends ReadonlyArray<string>>(
    ids: Ids,
  ): Promise<{ readonly [Id in Ids[number]]: ScriptAnswerOf<Declared> }>;
  function ask<Id extends string>(questions: {
    readonly [Asked in Id]: AskSpecOf<Declared>;
  }): Promise<{ readonly [Asked in Id]: ScriptAnswerOf<Declared> }>;
  function ask(
    input: Parameters<Context.Tag.Service<ScriptInput>["ask"]>[0],
  ): Promise<ScriptAnswer | Readonly<Record<string, ScriptAnswer>>> {
    return settle(
      scriptInput === undefined
        ? Effect.fail(new ScriptInputFailure({ code: "Unavailable" }))
        : scriptInput.ask(input),
    );
  }
  return ask;
};

/** The job's browser a Kernel script runs on, as the runner binds it. */
interface ScriptBrowser {
  readonly kernel: KernelExecuteClient;
  readonly sessionId: string;
  readonly siteOrigin?: string;
  /** The host's registrable domain for `siteOrigin`; the sandbox has no public suffix list. */
  readonly siteDomain?: string;
  /** An offline run cannot reach a site, so it never signs in. */
  readonly offline?: boolean;
  readonly dialogs?: DialogDecider;
  /**
   * The host's sign-in for an operation that runs signed in, bound only then: it checks the
   * signed-in marker on the current page and, only when it is absent, signs in again. It rejects
   * when it cannot, such as when its sign-ins are spent or the sign-in did not verify.
   */
  readonly signIn?: () => Promise<{ readonly signedInAgain: boolean }>;
  /** Hosted HTTP authoring diagnostics; native browser scripts use the portable errors. */
  readonly scriptError?: (error: unknown, dispatch: Dispatch) => OperationFailure;
  /** The host's file service for this run, bound only when the host moves files. */
  readonly files?: FileChannel;
}

/** The default wait for a download to finish after its trigger. */
export const downloadWaitMs = 30_000;

/** A file refusal, or the host's file service failing, as the script's own failure. */
const fileFailure = (error: unknown, dispatch: Dispatch) =>
  new OperationFailure(error instanceof FileRefused ? error.message : "The host's file service failed", {
    cause: error,
    dispatch,
  });

/**
 * The context's `files` over the host's channel. Placing a file reaches the page, so a live run
 * marks a possible dispatch first, as an execute call does; collecting only reads what the
 * trigger's own calls made the page download.
 */
const scriptFiles = (
  options: ScriptBrowser & { readonly deadline: Deadline; readonly journal?: EffectJournal },
): ScriptFiles => {
  const channel = () => {
    if (options.files === undefined || options.offline === true)
      throw new OperationFailure("This run has no file service", { dispatch: "not_sent" });
    return options.files;
  };
  return {
    place: async (reference, { field, timeoutSec }) => {
      const files = channel();
      if (typeof reference !== "string" || typeof field !== "string")
        throw new OperationFailure("files.place takes a file reference and a field locator", {
          dispatch: "not_sent",
        });
      if (options.journal !== undefined) Effect.runSync(options.journal.enteringDispatch);
      try {
        return await settle(
          files.place({
            reference,
            field,
            timeoutSec: kernelTimeoutSec(
              Math.min((timeoutSec ?? 30) * 1000, options.deadline.remainingMs()),
            ),
          }),
        );
      } catch (error) {
        throw fileFailure(error, "unknown");
      }
    },
    collect: async (trigger, collectOptions) => {
      const files = channel();
      let slot: string;
      try {
        slot = await settle(files.arm());
      } catch (error) {
        throw fileFailure(error, "not_sent");
      }
      try {
        await trigger();
      } catch (error) {
        // The capture ends with the trigger, so nothing it armed outlives the failure.
        await Effect.runPromise(Effect.ignore(files.collect({ slot, timeoutMs: 0 })));
        throw error;
      }
      const timeoutMs = Math.min(
        collectOptions?.timeoutMs ?? downloadWaitMs,
        Math.max(0, options.deadline.remainingMs()),
      );
      try {
        return await settle(files.collect({ slot, timeoutMs }));
      } catch (error) {
        throw fileFailure(error, "unknown");
      }
    },
  };
};

/** Builds the context the runtime hands a Kernel script. */
const makeKernelOperationContext = <Input>(
  options: ScriptBrowser & {
    readonly input: Input;
    readonly deadline: Deadline;
    readonly ensureSignedIn: KernelOperationContext<Input>["ensureSignedIn"];
    /** The runner's caller questions; the login hooks get none, so they can never ask. */
    readonly scriptInput?: Context.Tag.Service<ScriptInput>;
    /** A live run's journal. An offline run has none, so its effect stays not started. */
    readonly journal?: EffectJournal;
    /** The script's write declaration; the login hooks get none. */
    readonly write?: WriteDeclaration;
  },
): KernelOperationContext<Input> => ({
  kernel: options.kernel,
  sessionId: options.sessionId,
  siteOrigin: options.siteOrigin,
  siteDomain: options.siteDomain,
  input: options.input,
  // Records how the run proved its effect, a read-back unless the site's message says so.
  verified: (proof) => {
    const kind = proof?.confirmation ?? "readback";
    if (options.write?.confirmation === "unverifiable")
      throw new WriteConfirmationRefused({ declared: "unverifiable", recorded: kind });
    if (options.journal !== undefined) Effect.runSync(options.journal.confirmed(kind));
  },
  // Marks a named commit step sent just before the execute call that dispatches it.
  enteringCommit: (name) => {
    if (options.journal === undefined) return;
    const entered = Effect.runSync(Effect.either(options.journal.enteringCommit(name)));
    if (entered._tag === "Left") throw entered.left;
  },
  remainingMs: () => options.deadline.remainingMs(),
  errors: operationErrors,
  rejectedSignIn: (request) => settle(inspectSignInRejection(options, request)),
  ensureSignedIn: options.ensureSignedIn,
  decideDialog: async (shown) => {
    const decide = options.dialogs;
    if (decide === undefined) throw new DialogFailure({ reason: "unavailable" });
    const report = Schema.decodeUnknownEither(DialogReport)(shown);
    if (Either.isLeft(report)) throw new DialogFailure({ reason: "invalid_request" });
    const resume = options.deadline.suspend();
    try {
      const choice = await settle(
        decide({
          interactionId: crypto.randomUUID(),
          ...report.right,
          message: report.right.message.slice(0, dialogMessageLimit),
        }),
      );
      return Schema.decodeUnknownSync(DialogChoice)(choice, { onExcessProperty: "error" });
    } finally {
      resume();
    }
  },
  // The runtime checks every id and option against the declarations; the types only guide.
  ask: scriptAsk(options.scriptInput),
  files: scriptFiles(options),
  waitPastChallenge: async ({ ready }) => {
    // The SDK accepts only a whole-millisecond request timeout.
    const limitMs = Math.floor(Math.min(challengeSolverWaitMs, options.deadline.remainingMs()));
    const answer = await options.kernel.browsers.playwright.execute(
      options.sessionId,
      {
        code: waitPastChallengeCode(ready, limitMs),
        timeout_sec: kernelTimeoutSec(Math.min(limitMs + 10_000, options.deadline.remainingMs())),
      },
      { maxRetries: 0, timeout: limitMs + 20_000 },
    );
    if (answer.success !== true)
      throw new OperationFailure(`waitPastChallenge failed: ${String(answer.error)}`, {
        stderr: answer.stderr,
      });
    const result = Schema.decodeUnknownSync(WaitResult)(answer.result);
    if (!result.cleared)
      throw new ChallengeFailure({
        code: "Unavailable",
        solverWaitMs: Math.max(0, Math.round(result.waitedMs)),
      });
  },
});

export const isKernelOperation = (
  value: unknown,
): value is KernelOperation<unknown, unknown, unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "kernel" &&
  typeof Reflect.get(value, "run") === "function";

/**
 * One run of a script's function against a Kernel client: Kernel's own, or the saved-DOM stand-in.
 * A throw that is not one of its typed errors becomes an `OperationFailure`.
 */
export const runKernelScript = <Input, EncodedInput, Output, EncodedOutput>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  input: Input,
  browser: ScriptBrowser & {
    readonly deadline: Deadline;
    readonly scriptInput?: Context.Tag.Service<ScriptInput>;
    readonly journal?: EffectJournal;
  },
): Effect.Effect<Output, ScriptFailure> =>
  Effect.suspend(() => {
    let actionTimeout: string | undefined;
    let calls = 0;
    // The host's sign-in under way. Every browser call the script starts meanwhile, from a timer
    // or an un-awaited promise too, waits for it and is only then sent, in order, so its own
    // timeout starts then. A failed sign-in releases them as well.
    let signingIn: Promise<{ readonly signedInAgain: boolean }> | undefined;
    const afterSignIn = <A>(call: () => Promise<A>): Promise<A> =>
      signingIn === undefined ? call() : signingIn.then(call, call);
    const kernel: KernelExecuteClient = {
      browsers: {
        playwright: {
          execute: (sessionId, body, options) => {
            // Counted when made: a held call goes out later, even after the script ends.
            calls += 1;
            return afterSignIn(() =>
              settle(
                Effect.sync(() => {
                  actionTimeout = undefined;
                }).pipe(
                  Effect.flatMap(() =>
                    Effect.tryPromise({
                      try: () =>
                        browser.kernel.browsers.playwright.execute(sessionId, body, options),
                      catch: (error) =>
                        error instanceof Error ? error : new Error(String(error), { cause: error }),
                    }),
                  ),
                  Effect.tap((answer) =>
                    Effect.sync(() => {
                      actionTimeout = nativeActionTimeout(answer);
                    }),
                  ),
                ),
              ),
            );
          },
        },
      },
    };
    // The host's sign-in, with the deadline paused. A refusal before the script's first call
    // sent nothing; after it, the script's own calls may have.
    const signInOnce = async (signIn: NonNullable<ScriptBrowser["signIn"]>) => {
      const resume = browser.deadline.suspend();
      try {
        const { signedInAgain } = await signIn();
        return { signedInAgain: signedInAgain === true };
      } catch (error) {
        if (error instanceof CredentialsRejected) throw error;
        throw new OperationFailure("The host could not sign the site in again", {
          cause: error,
          dispatch: calls === 0 ? "not_sent" : "unknown",
          sessionLoss: "session_not_kept",
        });
      } finally {
        resume();
      }
    };
    // A call while one is under way joins it rather than signing in again.
    const ensureSignedIn = async () => {
      const signIn = browser.signIn;
      if (signIn === undefined || browser.offline === true) return { signedInAgain: false };
      signingIn ??= signInOnce(signIn).finally(() => {
        signingIn = undefined;
      });
      return signingIn;
    };
    return Effect.tryPromise({
      try: async () => {
        // A page that lost its session since the host signed in is signed in again first.
        await ensureSignedIn();
        const context = makeKernelOperationContext({
          ...browser,
          kernel,
          input,
          ensureSignedIn,
          ...(operation.write === undefined ? {} : { write: operation.write }),
        });
        const output = await operation.run({
          ...context,
          decideDialog: (report) => afterSignIn(() => context.decideDialog(report)),
          // Placing a file is a browser call: it waits for a sign-in under way and counts as one.
          files: {
            ...context.files,
            place: (reference, options) => {
              calls += 1;
              return afterSignIn(() => context.files.place(reference, options));
            },
          },
        });
        // A returned Effect never ran, so only the script's own execute calls may have sent.
        if (Effect.isEffect(output))
          throw scriptFailure(output, browser.scriptError, calls === 0 ? "not_sent" : "unknown");
        return output;
      },
      catch: (error) => {
        const failure = scriptFailure(error, browser.scriptError);
        return failure instanceof OperationFailure &&
          actionTimeout !== undefined &&
          failure.message === actionTimeout.slice(0, 4096)
          ? new BrowserActionTimeout(failure)
          : failure;
      },
    });
  });
