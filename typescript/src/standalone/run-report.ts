import { Data, Effect } from "effect";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../execution/local-operation.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import {
  classifyRun,
  commitReportOf,
  failedRunOutcome,
  runnerVerified,
  unconfirmedWrite,
  validatedWriteNeeds,
  type OutcomeRevision,
  type RunEvidence,
  type RunOutcome,
} from "../runtime/run-outcome.js";
import { SignInRunFailed } from "../runtime/sign-in-replay.js";
import { localFailureText } from "./failure-text.js";

/**
 * A run that did not end in a confirmed result. `outcome` says what it did to the website and how
 * to retry, and the message says the same in one sentence. A write that may have applied keeps
 * the output its script returned, unconfirmed.
 */
export class RunOutcomeFailure extends Data.TaggedError("RunOutcomeFailure")<{
  readonly outcome: RunOutcome;
  readonly text: string;
  readonly unconfirmed?: { readonly output: unknown };
}> {
  override get message() {
    return this.text;
  }
}

/** The effect a run's request declares, when it declares one. */
export type DeclaredEffect = "read" | "write" | undefined;

/** A write the script declares is a write, whatever the request says. */
const revisionOf = (
  declared: "read" | "write",
  write: WriteDeclaration | undefined,
): OutcomeRevision =>
  write === undefined
    ? { effect: declared }
    : { effect: "write", writeConfirmation: write.confirmation };

/** The website effect a write's journal shows. */
const journalEffect = (journal: LocalOperationJournal, revision: OutcomeRevision | undefined) =>
  journal.effect === "not_sent"
    ? "not_started"
    : journal.effect === "possible" || !runnerVerified(revision, "verified", journal.confirmation)
      ? "may_have_dispatched"
      : "verified";

const unconfirmedLead = {
  confirmation_missing:
    "The write returned without recording its confirmation, so it may have changed the website.",
  unverifiable:
    "This site offers no confirmation for the write, so it may have changed the website.",
} as const;

/**
 * A run whose operation returned: its output when it is a read or a confirmed write, else the
 * failure that says the write may have applied. A script that declares no write is a read unless
 * the request says it writes.
 */
export const returnedRun = (declared: DeclaredEffect, result: LocalOperationOutput) => {
  const revision = revisionOf(declared ?? "read", result.write);
  // A read holds no write authority, so its validated return completes it.
  const effect = revision.effect === "read" ? "verified" : journalEffect(result, revision);
  const evidence: RunEvidence = {
    status: "completed",
    effect,
    output: "valid",
    tool_effect: revision.effect,
  };
  const outcome = classifyRun(evidence);
  if (outcome === undefined) return Effect.succeed(result.output);
  const needs = validatedWriteNeeds(revision, effect);
  return Effect.fail(
    new RunOutcomeFailure({
      outcome,
      text: localFailureText(outcome, needs === "nothing" ? undefined : unconfirmedLead[needs]),
      ...(unconfirmedWrite(evidence) ? { unconfirmed: { output: result.output } } : {}),
    }),
  );
};

const operationReasons: Readonly<Record<string, string>> = {
  NoResponse: "no_response",
  InvalidInput: "invalid_input",
  CredentialsRejected: "credentials_rejected",
};

/**
 * What a failed operation's journal shows. Only declared commit marks that were never entered
 * prove a write sent nothing: a refusal then changed nothing, and any other failure left the
 * write unattempted. A failure with no journal may have dispatched anything.
 */
const operationEvidence = (declared: DeclaredEffect, error: unknown): RunEvidence => {
  if (!(error instanceof LocalOperationFailure))
    return {
      status: "completed",
      effect: declared === "read" ? "not_started" : "may_have_dispatched",
      output: "failed",
      tool_effect: declared,
    };
  const { journal } = error;
  const reason = operationReasons[error.code ?? ""];
  const tool = declared ?? (journal.commits.length > 0 ? "write" : undefined);
  const refused = reason === "invalid_input" || reason === "credentials_rejected";
  const effect =
    tool === "read" || journal.effect === "not_sent"
      ? "not_started"
      : commitReportOf(journal).evidence === "not_entered"
        ? refused
          ? "rejected"
          : "not_started"
        : journalEffect(journal, tool === undefined ? undefined : { effect: tool });
  return {
    status: "completed",
    effect,
    output: error.code === "InvalidOutput" ? "invalid" : "failed",
    tool_effect: tool,
    failure_reason: reason,
    // The tool's own InvalidInput names the refused value's rule; a schema refusal names nothing.
    ...(reason === "invalid_input" && error.message !== "InvalidInput"
      ? { refusal_reason: error.message }
      : {}),
  };
};

/** What a failure before the operation shows: nothing reached the website through the tool. */
const beforeOperationEvidence = (declared: DeclaredEffect, error: unknown): RunEvidence => ({
  status: "completed",
  effect: "not_started",
  output: "failed",
  tool_effect: declared,
  ...(error instanceof InputRequestFailure && error.code === "NoResponse"
    ? { failure_reason: "no_response" }
    : {}),
});

/**
 * The failure a run reports for `error`, raised before its operation started (site checks,
 * sign-in questions, the start page) or during it. An outcome already classified passes through
 * unchanged.
 */
export const runOutcomeFailure =
  (declared: DeclaredEffect, stage: "before_operation" | "operation") =>
  (error: unknown): RunOutcomeFailure => {
    if (error instanceof RunOutcomeFailure) return error;
    const outcome = failedRunOutcome(
      stage === "operation"
        ? operationEvidence(declared, error)
        : beforeOperationEvidence(declared, error),
    );
    return new RunOutcomeFailure({ outcome, text: localFailureText(outcome) });
  };

/**
 * The failure a run reports for `error` raised before its operation started. A sign-in failure
 * stays the typed `SignInRunFailed` a caller may catch: it names the field or step and what to
 * do, and nothing reached the website through the tool.
 */
export const beforeOperationFailure =
  (declared: DeclaredEffect) =>
  (error: unknown): RunOutcomeFailure | SignInRunFailed =>
    error instanceof SignInRunFailed ? error : runOutcomeFailure(declared, "before_operation")(error);
