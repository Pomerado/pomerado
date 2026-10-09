import { Effect, Option, Schema } from "effect";
import { CredentialRejectedField } from "./authentication.js";
import type { SessionLoss } from "./authentication.js";
import { ChallengeFailure } from "./challenge.js";
import { CommitAlreadySent, WriteConfirmationRefused } from "./errors.js";
import type { Dispatch } from "./errors.js";
import type { BrowserActionTimeout } from "./browser-action-timeout.js";
import { DialogFailure } from "./dialogs.js";
import { ScriptInputFailure } from "./script-input.js";

/** Kernel's `stderr` for a failed call: the JavaScript stack of the call's own code. */
class KernelCallStack extends Error {
  override readonly name = "KernelCallStack";
  constructor(stderr: string) {
    super("Kernel call failed");
    this.stack = stderr.slice(0, 16_384);
  }
}

/**
 * What a site's answer was when code could not use it: the destination's own status or a body
 * that did not parse. `readText` and `readJson` attach it, so the agent's result says whether the
 * site answered and how, apart from a relay or provider failure.
 */
export interface HttpAnswerFailure {
  readonly class: "destination_status" | "parsing";
  readonly request: { readonly method: string; readonly url: string };
  readonly status: number;
  readonly contentType: string;
  readonly transport: string;
  readonly bytes: number;
}

/** The most choices a refusal lists, and the longest each may be. */
export const maximumRefusalChoices = 100;
export const maximumRefusalChoiceLength = 200;

/**
 * Which input a refusal names and every choice the page offers for it, exactly as shown. A host
 * tells the caller the choices, so the caller can pick one; a host that repairs has nothing to
 * check when the page listed them.
 */
export interface InputRefusalDetail {
  readonly field?: string;
  readonly available?: readonly string[];
}

/** The detail as a host may carry it: a bounded field name and up to the most choices, each bounded. */
export const boundedRefusalDetail = (detail: unknown): InputRefusalDetail => {
  if (typeof detail !== "object" || detail === null) return {};
  const field: unknown = Reflect.get(detail, "field");
  const available: unknown = Reflect.get(detail, "available");
  const choices = Array.isArray(available)
    ? available
        .filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
        .slice(0, maximumRefusalChoices)
        .map((choice) => choice.slice(0, maximumRefusalChoiceLength))
    : [];
  return {
    ...(typeof field === "string" && field.trim() !== ""
      ? { field: field.slice(0, maximumRefusalChoiceLength) }
      : {}),
    ...(choices.length > 0 ? { available: choices } : {}),
  };
};

/**
 * The site refused a caller's value, such as a past date or an unknown airport code. It is the
 * caller's to correct, so the run fails as `InvalidInput`. Scripts throw it as
 * `errors.InvalidInput`, never for a page or control that changed. When the value is not among
 * the choices the page offers, the script names the input and lists them:
 * `new errors.InvalidInput(message, { field: "size", available: ["One Size"] })`. The caller then
 * picks one of them, so nothing asks it for a replacement. Only a refusal without choices, of a
 * free-form value the page lists no options for, may be checked by a host that repairs, which
 * may ask the caller whether the value is invalid.
 */
class InputRejected extends Error {
  override readonly name = "InvalidInput";
  readonly _tag = "InvalidInput";
  readonly field?: string;
  readonly available?: readonly string[];
  constructor(message: string, detail?: InputRefusalDetail) {
    super(message.slice(0, 4096));
    const bounded = boundedRefusalDetail(detail);
    if (bounded.field !== undefined) this.field = bounded.field;
    if (bounded.available !== undefined) this.available = bounded.available;
  }
}

/** A site refused a sign-in value; its field kind contains no credential or page text. */
export class CredentialsRejected extends Error {
  override readonly name = "CredentialsRejected";
  readonly _tag = "CredentialsRejected";
  constructor(readonly field: CredentialRejectedField) {
    super("Sign-in credential rejected");
    if (Option.isNone(Schema.decodeUnknownOption(CredentialRejectedField)(field)))
      throw new TypeError("Unknown sign-in field");
  }
}

/**
 * A Kernel script's own failure: a call returned `success: false`, or the page was not in the
 * state the script needs. `dispatch` says whether a website write may have gone out. A failed
 * call's `stderr` becomes the cause, so its stack reaches the failure detail. `sessionLoss` is set
 * by the runtime when the host could not sign the page in again (`ensureSignedIn`).
 */
export class OperationFailure extends Error {
  override readonly name = "OperationFailure";
  readonly _tag = "OperationFailure";
  readonly dispatch: Dispatch;
  readonly http?: HttpAnswerFailure;
  readonly sessionLoss?: SessionLoss;
  constructor(
    message: string,
    options: {
      readonly dispatch?: Dispatch;
      readonly cause?: unknown;
      readonly stderr?: string | undefined;
      readonly http?: HttpAnswerFailure;
      readonly sessionLoss?: SessionLoss;
    } = {},
  ) {
    const cause =
      options.cause ?? (options.stderr ? new KernelCallStack(options.stderr) : undefined);
    super(message.slice(0, 4096), cause === undefined ? {} : { cause });
    this.dispatch = options.dispatch ?? "unknown";
    if (options.http !== undefined) this.http = options.http;
    if (options.sessionLoss !== undefined) this.sessionLoss = options.sessionLoss;
  }
}

/** Preserve the cause and dispatch when a script fails outside its declared errors. */
const unexpectedScriptFailure = (error: unknown, dispatch: Dispatch) =>
  new OperationFailure(
    Effect.isEffect(error)
      ? "This browser script returned an Effect instead of its output, so the Effect never ran"
      : error instanceof Error
        ? error.message
        : String(error),
    { cause: error, dispatch },
  );

/** Typed failures a Kernel script's run may end with, as the runner reports them. */
export type ScriptFailure =
  | OperationFailure
  | InputRejected
  | CredentialsRejected
  | BrowserActionTimeout
  | ChallengeFailure
  | DialogFailure
  | ScriptInputFailure
  | WriteConfirmationRefused
  | CommitAlreadySent;

const passThrough = (error: unknown): error is ScriptFailure =>
  error instanceof OperationFailure ||
  error instanceof InputRejected ||
  error instanceof CredentialsRejected ||
  error instanceof ChallengeFailure ||
  error instanceof DialogFailure ||
  error instanceof ScriptInputFailure ||
  error instanceof WriteConfirmationRefused ||
  error instanceof CommitAlreadySent;

/** A throw that is not one of the script's typed errors becomes an `OperationFailure`. */
export const scriptFailure = (
  error: unknown,
  diagnose?: (error: unknown, dispatch: Dispatch) => OperationFailure,
  dispatch: Dispatch = "unknown",
): ScriptFailure =>
  passThrough(error)
    ? error
    : diagnose !== undefined
      ? diagnose(error, dispatch)
      : unexpectedScriptFailure(error, dispatch);

/**
 * The typed errors a Kernel script may throw, its context's `errors`. Each is a class, so construct
 * it with `new`: `throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr })`.
 * `ChallengeFailure` comes only from `waitPastChallenge`.
 */
export const operationErrors = {
  OperationFailure,
  ChallengeFailure,
  InvalidInput: InputRejected,
  CredentialsRejected,
} as const;
