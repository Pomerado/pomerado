import { Option, Schema } from "effect";
import type { CommitMark } from "./context.js";
import { commitMarkMaxLength, commitMarkPattern } from "./operation.js";

/*
 * What a finished or failed run did to the website, and what its caller is told. These functions
 * are pure and shared by every host: the local host classifies its runs with them, and another
 * host may classify its own job records with them and word the result in its own way through a
 * `FailureRenderer`.
 */

/**
 * A runner's report of a write's commit marks. Only authored mark names pass: a name is a short
 * hyphenated word list, so it can never carry a caller's value into host records.
 */
const CommitReport = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      name: Schema.String.pipe(
        Schema.maxLength(commitMarkMaxLength),
        Schema.pattern(commitMarkPattern),
      ),
      state: Schema.Literal("not_sent", "sent", "confirmed"),
    }),
  ),
});

/**
 * What a write's runner reported about its commit marks. `not_entered`: the script declared its
 * commit steps and entered none. `entered`: a commit step was about to dispatch or did.
 * `undeclared`: the script declared no marks, so a commit the ledger cannot see (a GET) stays
 * possible. `unreported`: no readable report, so nothing is known. Only `not_entered` ever lets a
 * write count as having sent nothing.
 */
export type CommitEvidence = "not_entered" | "entered" | "undeclared" | "unreported";

/** The evidence of a runner's own report of its commit marks, once that report was read. */
export const commitEvidenceOf = (marks: readonly CommitMark[]) =>
  marks.length === 0
    ? ("undeclared" as const)
    : marks.some((mark) => mark.state !== "not_sent")
      ? ("entered" as const)
      : ("not_entered" as const);

export interface CommitReportOutcome {
  readonly evidence: CommitEvidence;
  /** The marks as reported; absent when the report was missing or unreadable. */
  readonly marks?: readonly CommitMark[];
}

/**
 * What an execution's runner result proves about its commit steps. A missing or malformed report
 * proves nothing, and a script without declared marks leaves a commit the ledger cannot see (a
 * GET) possible, so only `not_entered` ever lets a write count as having sent nothing.
 */
export const commitReportOf = (resultJson: unknown): CommitReportOutcome => {
  const decoded = Schema.decodeUnknownOption(CommitReport)(resultJson);
  if (Option.isNone(decoded)) return { evidence: "unreported" };
  const marks = decoded.value.commits;
  return { evidence: commitEvidenceOf(marks), marks };
};

/** The tool revision fields the outcome functions read: its effect and declared confirmation. */
export interface OutcomeRevision {
  readonly effect: "read" | "write";
  /** A write's declared confirmation; absent on reads and on writes published before it existed. */
  readonly writeConfirmation?: "message" | "readback" | "unverifiable" | undefined;
}

/**
 * Whether the runner's evidence verifies the run. A write published with a declared confirmation
 * is verified only by the confirmation it recorded (a script's `verified()` with its kind, an
 * HTTP implementation's `journal.confirmed`); an HTTP implementation's bare `journal.verified` is
 * not enough. A legacy write, published before the declaration existed, keeps its journal's
 * verified effect.
 */
export const runnerVerified = (
  revision: OutcomeRevision | undefined,
  runnerEffect: "not_started" | "may_have_dispatched" | "verified",
  confirmation: "message" | "readback" | undefined,
) =>
  runnerEffect === "verified" &&
  (revision?.effect !== "write" ||
    revision.writeConfirmation === undefined ||
    confirmation !== undefined);

/**
 * What a write run that returned a validated result still needs. `confirmation_missing`: the
 * script finished but never recorded its confirmation, so the run failed and whether the write
 * took effect is unknown. `unverifiable`: the site offers no confirmation, so the result is
 * possibly completed. Reads and verified writes need nothing.
 */
export const validatedWriteNeeds = (
  revision: OutcomeRevision | undefined,
  websiteEffect: string,
): "nothing" | "confirmation_missing" | "unverifiable" =>
  revision?.effect !== "write" || websiteEffect === "verified"
    ? "nothing"
    : revision.writeConfirmation === "unverifiable"
      ? "unverifiable"
      : "confirmation_missing";

/**
 * Why a write may not run again on its own, from its commit evidence alone. Only a write whose
 * declared commit steps were never entered may.
 */
export const commitRetryRefusal = (evidence: CommitEvidence) =>
  evidence === "not_entered" ? undefined : (`commit_${evidence}` as const);

/**
 * What a run's record says, as the classifier reads it. `status` is how the run ended
 * (`completed`, `cleanup_pending`, `outcome_unknown`, `cancelled`), `effect` what it did to the
 * website (`not_started`, `may_have_dispatched`, `verified`, `rejected`, `unknown`, `partial`),
 * `output` whether its result matched the tool's schema (`valid`, `invalid`, `failed`).
 */
export interface RunEvidence {
  readonly status: string;
  readonly effect: string;
  readonly output: string;
  /** The output did not match the schema, but the run reported it. */
  readonly output_drift?: boolean | undefined;
  /** The tool revision's own effect, when known. */
  readonly tool_effect?: "read" | "write" | undefined;
  /** Why the run stopped, when a known reason stopped it. */
  readonly failure_reason?: string | undefined;
  /** The run's own judgement that a step may have changed the website. */
  readonly possible_commit?: boolean | undefined;
  /** The tool's or the site's own words, for a refused input. */
  readonly refusal_reason?: string | undefined;
  /** The input a refusal named, when the tool named it. */
  readonly refusal_field?: string | undefined;
  /** Every choice the page offers for the refused input, when the tool read them. */
  readonly refusal_available?: readonly string[] | undefined;
  /** The login field the website rejected. */
  readonly rejected_field?: string | undefined;
}

/**
 * How a caller may repeat a run that failed with a code. `never`: check the outcome first and
 * do not repeat it as is. `fix_input`: correct the input or the login, then run it again.
 * `same_key`: the same request may be repeated as is. `new_key`: a repeat is a new run, after
 * checking the website when a step may have changed it.
 */
export type RunRetryClass = "never" | "fix_input" | "same_key" | "new_key";

/** Every code the classifier returns. A host's renderer words each one. */
export const runOutcomeCodes = [
  "no_response",
  "credentials_rejected",
  "input_rejected",
  "login_identity_conflict",
  "website_sign_in_unavailable",
  "worker_lost",
  "outcome_unknown",
  "invalid_output",
  "execution_failed",
] as const;
export type RunOutcomeCode = (typeof runOutcomeCodes)[number];

/** Each code's retry class. */
export const runOutcomeRetry: { readonly [Code in RunOutcomeCode]: RunRetryClass } = {
  no_response: "new_key",
  credentials_rejected: "fix_input",
  input_rejected: "fix_input",
  login_identity_conflict: "fix_input",
  website_sign_in_unavailable: "same_key",
  worker_lost: "same_key",
  outcome_unknown: "never",
  invalid_output: "never",
  execution_failed: "never",
};

/** A failed run's code and its details, which a host may answer as JSON. */
export interface RunFailure {
  readonly code: RunOutcomeCode;
  readonly details: Readonly<Record<string, unknown>>;
}
const failure = (code: RunOutcomeCode, details?: Readonly<Record<string, unknown>>): RunFailure => ({
  code,
  details: details ?? {},
});

/** A run whose website effect may have changed the site without a confirmed outcome. */
export const unsettledEffect = (view: RunEvidence) =>
  view.status === "outcome_unknown" ||
  view.effect === "unknown" ||
  view.effect === "partial" ||
  view.effect === "may_have_dispatched";
export const confirmedRun = (view: RunEvidence) =>
  (view.output === "valid" || view.output_drift === true) &&
  (view.status === "completed" || view.status === "cleanup_pending") &&
  (view.effect === "verified" || view.effect === "not_started");

/** Whether a step may already have changed the website: the job says so, or its effect is unsettled. */
export const possibleCommit = (view: RunEvidence) =>
  view.possible_commit === true || unsettledEffect(view);

/** A rejected login's details: whether a step may have committed, and the field it named. */
export const rejectedDetails = (view: RunEvidence, committed: boolean) => ({
  possible_commit: committed,
  ...(view.rejected_field === undefined ? {} : { field: view.rejected_field }),
});

/** Starting over is safe only for a read or an untouched site. */
const lostWorker = (view: RunEvidence): RunFailure =>
  view.tool_effect === "read" || view.effect === "not_started"
    ? failure("worker_lost")
    : failure("outcome_unknown");

/** Why a settled run failed. */
export const runError = (view: RunEvidence): RunFailure => {
  switch (view.failure_reason) {
    case "no_response":
      return failure("no_response", { possible_commit: possibleCommit(view) });
    case "credentials_rejected":
      return failure("credentials_rejected", rejectedDetails(view, possibleCommit(view)));
    case "invalid_input":
      return failure("input_rejected", {
        possible_commit: possibleCommit(view),
        ...(view.refusal_reason === undefined ? {} : { reason: view.refusal_reason }),
        ...(view.refusal_field === undefined ? {} : { field: view.refusal_field }),
        ...(view.refusal_available === undefined || view.refusal_available.length === 0
          ? {}
          : { available: view.refusal_available }),
      });
    case "login_identity_conflict":
      return failure("login_identity_conflict", {});
    case "login_check_unavailable":
      return failure("website_sign_in_unavailable");
    case "worker_lost":
      return lostWorker(view);
    case undefined:
      break;
  }
  if (unsettledEffect(view)) return failure("outcome_unknown");
  return failure(view.output === "invalid" ? "invalid_output" : "execution_failed");
};

/** What a write did to the website; null for a read or a tool whose effect is unknown. */
export type WriteStatus = "not_attempted" | "may_have_applied" | "applied" | "not_applied";
export const writeStatusOf = (view: RunEvidence): WriteStatus | null => {
  if (view.tool_effect !== "write") return null;
  if (view.status === "outcome_unknown" || unsettledEffect(view)) return "may_have_applied";
  if (view.effect === "verified") return "applied";
  if (view.effect === "rejected") return "not_applied";
  return "not_attempted";
};

/** A failed write that may have changed the site keeps the result its script returned, unconfirmed. */
export const unconfirmedWrite = (view: RunEvidence) =>
  view.tool_effect === "write" &&
  (unsettledEffect(view) || view.failure_reason === "worker_lost") &&
  (view.output === "valid" || view.output_drift === true);

/**
 * A run that did not end in a confirmed result: its code, write status and retry class.
 * `possibleCommit` follows the code and `writeStatus` follows the evidence, so they can differ:
 * a code that carries no possible commit can still describe a write that `may_have_applied`.
 * Either one means the website may have changed.
 */
export interface RunOutcome extends RunFailure {
  readonly writeStatus: WriteStatus | null;
  /** True: the code says a step may already have changed the website. */
  readonly possibleCommit: boolean;
  readonly retry: RunRetryClass;
}

/**
 * Whether an outcome tells its caller that a step may have committed. A code that carries
 * `possible_commit` says so in its details, `outcome_unknown` always may have, and every other
 * code means nothing reached the website or the website's effect is settled.
 */
const outcomeMayHaveCommitted = (failed: RunFailure) => {
  const stated = failed.details["possible_commit"];
  return typeof stated === "boolean" ? stated : failed.code === "outcome_unknown";
};

/** A settled run's outcome when it did not end in a confirmed result. */
export const failedRunOutcome = (view: RunEvidence): RunOutcome => {
  const failed = runError(view);
  return {
    ...failed,
    writeStatus: writeStatusOf(view),
    possibleCommit: outcomeMayHaveCommitted(failed),
    retry: runOutcomeRetry[failed.code],
  };
};

/** A settled run's outcome; undefined when it ended in a confirmed result. */
export const classifyRun = (view: RunEvidence): RunOutcome | undefined =>
  confirmedRun(view) ? undefined : failedRunOutcome(view);

/** A run outcome in one host's words. */
export interface RenderedFailure {
  /** What happened. */
  readonly message: string;
  /** What to do next. */
  readonly remediation: string;
  /** The retry class the words carry, which is the outcome's own. */
  readonly retry: string;
  /** The HTTP status, for a host that answers over HTTP. */
  readonly status?: number;
}

/**
 * The failure renderer hook: turns a run outcome into one host's words. A host words every code
 * in `runOutcomeCodes`; `failureRendererIssues` checks that it does, and that every possible
 * commit tells the caller to read the website back before any retry.
 */
export interface FailureRenderer {
  /** The codes this renderer words; equal to `runOutcomeCodes`. */
  readonly codes: readonly RunOutcomeCode[];
  /** How this host's words tell a caller to read the website back before any retry. */
  readonly readBackAdvice: string | RegExp;
  readonly render: (outcome: RunOutcome) => RenderedFailure;
}
