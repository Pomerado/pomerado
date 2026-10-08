import { makeGuardianSession } from "./session.js";
import type { GuardianSession, GuardianSessionOptions } from "./session.js";
import { QuestionDecision } from "./question.js";
import { decodePublicationDecision } from "./publication.js";
import type { AnsweredQuestion, PendingQuestion } from "./question.js";
import { TaskUpdateDecision } from "./task-update.js";
import type { PendingTaskUpdate, ReviewedTaskUpdate } from "./task-update.js";
import {
  failureDetail,
  failureDetailMetadata,
  failureDetailOf,
} from "../runtime/failure-detail.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import { randomUUID } from "node:crypto";
import { Cause, Clock, Data, Duration, Effect, Option, Schema } from "effect";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import { PublicationFinding, PublicationReason } from "./review-contracts.js";
import type { PublicationScope, PublicationFileBlock } from "./review-contracts.js";
import {
  decisionForKind,
  reviewKindOf,
  sourceChunkOf,
  sourceLedger,
  sourcePath,
  unchangedSources,
} from "./review-layout.js";
import type { GuardianOutcome, ReviewKind } from "./review-layout.js";
export type { PublicationFileBlock } from "./review-contracts.js";
export type { GuardianOutcome, ReviewKind } from "./review-layout.js";

export interface GuardianDiagnostics {
  readonly emit: (
    name: string,
    details: unknown,
    correlation?: {
      readonly reviewId?: string;
      readonly reviewKind?: "execution" | "publication" | "question" | "update" | "host";
      readonly modelTiming?: ModelDiagnosticTiming;
      readonly required?: boolean;
    },
  ) => Effect.Effect<void, Error>;
  readonly retainModelTranscript: GuardianDiagnostics["emit"];
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, Error>;
  /**
   * Finite model and tool timing of a review whose model transcript is not retained, such as a
   * private host kind's. A review that retains its transcript carries the timing there instead,
   * so no model call is reported twice. Must not fail.
   */
  readonly observeModelTrace?: (
    name: "guardian.model",
    timing: ModelDiagnosticTiming,
    correlation?: {
      readonly reviewId?: string;
      readonly reviewKind?: "execution" | "publication" | "question" | "update" | "host";
    },
  ) => Effect.Effect<void>;
  readonly retainScreenedSource: (args: {
    readonly reviewId: string;
    readonly observation: string;
  }) => Effect.Effect<void, Error>;
}
export interface GuardianReviewOptions {
  /**
   * Decodes a publication decision in place of `decodePublicationDecision`, for a host that runs
   * its own publication review.
   */
  readonly decodePublication?: (
    scope: PublicationScope,
    raw: unknown,
  ) => Effect.Effect<GuardianDecision, ReviewFailure>;
  readonly diagnosticFailure?: (error: unknown, operation: string) => ReviewFailure;
  readonly bestEffort?: <A, E>(
    effect: Effect.Effect<A, E>,
    operation: string,
  ) => Effect.Effect<void>;
}

const rationaleLimit = 4000;
/**
 * A decision whose rationale is longer than the 4,000 characters it may hold keeps its first
 * 3,999 and an ellipsis, rather than failing as InvalidDecision and losing the decision: a denial
 * names every problem the source has, so its rationale can outgrow the limit the model is told.
 */
const boundedRationale = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const rationale: unknown = Reflect.get(raw, "rationale");
  if (typeof rationale !== "string" || rationale.length <= rationaleLimit) return raw;
  // Never keep half of a surrogate pair.
  const high = rationale.charCodeAt(rationaleLimit - 2);
  const end = high >= 0xd800 && high <= 0xdbff ? rationaleLimit - 2 : rationaleLimit - 1;
  return { ...raw, rationale: `${rationale.slice(0, end)}…` };
};

export const GuardianDecision = Schema.Struct({
  outcome: Schema.Literal("allow", "deny", "escalate"),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
  /** A publication review's finite reason; execution reviews have none. */
  reason: Schema.optional(Schema.suspend(() => PublicationReason)),
  findings: Schema.optional(Schema.Array(Schema.suspend(() => PublicationFinding))),
});
export type GuardianDecision = typeof GuardianDecision.Type;
export class ReviewFailure extends Data.TaggedError("ReviewFailure")<{
  readonly code:
    | "Unavailable"
    | "InvalidDecision"
    | "SourceUnavailable"
    | "PublicationBlocked"
    | "TurnLimitExceeded"
    /**
     * An execution review allowed without reading the submitted entrypoint, still after the
     * in-review rounds that asked for it. A verdict on unread source, not an outage: no retry.
     */
    | "EntrypointNotRead";
  readonly reviewPhase?: "review_computation" | "review_deadline" | "diagnostic_retention";
  /**
   * The model provider refused the review's call because the account's quota is spent. Reviewing
   * again cannot help, and the attempt ends as the `model_quota_exhausted` host failure.
   */
  readonly modelQuotaExhausted?: true;
  /** Sub-cause, operation, underlying error, stack and context; see ERROR-LOGGING-STANDARD.md. */
  readonly failureDetail?: FailureDetail;
  readonly publicationBlock?: PublicationFileBlock;
  readonly diagnosticRetentionReason?: "screening" | "serialization" | "storage" | "unclassified";
  readonly diagnosticScreeningReason?:
    "detector_unavailable" | "invalid_detection" | "invalid_text" | "closed_scope" | undefined;
  readonly diagnosticStorageFailure?:
    | "credentials"
    | "denied"
    | "conflict"
    | "transport"
    | "timeout"
    | "service"
    | "verification"
    | "cancelled"
    | "unavailable"
    | undefined;
}> {}

/** A copy for a serialized cause; its `failureDetail` is projected separately. */
const withoutDetail = (failure: ReviewFailure): ReviewFailure =>
  failure.failureDetail === undefined
    ? failure
    : new ReviewFailure({
        code: failure.code,
        ...(failure.publicationBlock === undefined
          ? {}
          : { publicationBlock: failure.publicationBlock }),
        ...(failure.reviewPhase === undefined ? {} : { reviewPhase: failure.reviewPhase }),
        ...(failure.modelQuotaExhausted === true ? { modelQuotaExhausted: true } : {}),
        ...(failure.diagnosticRetentionReason === undefined
          ? {}
          : { diagnosticRetentionReason: failure.diagnosticRetentionReason }),
        ...(failure.diagnosticScreeningReason === undefined
          ? {}
          : { diagnosticScreeningReason: failure.diagnosticScreeningReason }),
        ...(failure.diagnosticStorageFailure === undefined
          ? {}
          : { diagnosticStorageFailure: failure.diagnosticStorageFailure }),
      });

/**
 * One review of a kind the host defines, run on the same Guardian conversation with the same
 * instructions, tool and output format as every built-in kind, so the cached prefix holds.
 */
export interface HostReview {
  /** The host's name for the kind, sent as trusted_review.kind. */
  readonly kind: string;
  /** The host's policy for the kind, sent as trusted_review.policy. */
  readonly policy: string;
  /** What the kind judges, sent as host_review. Untrusted unless the policy says otherwise. */
  readonly evidence: unknown;
  /** The outcomes, from the shared vocabulary, that this kind may return. */
  readonly outcomes: readonly [GuardianOutcome, ...GuardianOutcome[]];
  /**
   * The finite codes the decision's label may take, which the policy names. Absent, the kind
   * returns no label.
   */
  readonly labels?: readonly [string, ...string[]];
  /**
   * Private review context: no readable diagnostic keeps the evidence, the transcript or the
   * rationale, and later reviews' readable records show the exchange only as a placeholder.
   */
  readonly private?: boolean;
}

/** A host-defined kind's decision: one of its outcomes, a rationale and any label. */
export interface HostReviewDecision {
  readonly outcome: GuardianOutcome;
  readonly rationale: string;
  readonly label?: string;
}

export interface PendingExecution {
  readonly invocationId: string;
  readonly attemptId: string;
  /**
   * The agent's own submitted file, never a host wrapper around it. An execution review includes
   * its first chunk in the request and allows only once Guardian has it in view.
   */
  readonly entrypoint: string;
  /**
   * The host's own trusted wrapper that loads the entrypoint, when it runs one: its path and
   * what it does. Guardian may read it but need not; the host wrote it, not the agent.
   */
  readonly hostWrapper?: {
    readonly path: string;
    readonly description: string;
  };
  // Intent and input have already crossed the trusted privacy broker. Observations carry the
  // published login URL raw, exactly as stored.
  readonly screenedIntent: string;
  /** Mints only: the screened intent as the owner submitted it. */
  readonly requestedIntent?: string;
  /**
   * Mints only: the caller-confirmed updates to the task that the host accepted, oldest first.
   * The effective task is `screenedIntent` with each applied in order. Every review after an
   * update reads them, and `allowedOrigins` is already rebound to a changed site.
   */
  readonly taskUpdates?: readonly ReviewedTaskUpdate[];
  readonly screenedInput: string;
  readonly screenedObservations: string;
  readonly accountScope: string;
  readonly allowedOrigins: readonly string[];
  /** A proposed input request; set only by `reviewQuestion`. */
  readonly questionCandidate?: PendingQuestion;
  /**
   * The minting agent's request for a new browser, with its screened reason; set only by
   * `reviewRecovery`. It runs no code, so no entrypoint read is required.
   */
  readonly recoveryCandidate?: { readonly rationale: string };
  /** A host-defined review kind's request; set only by `reviewHostKind`. */
  readonly hostReview?: HostReview;
  /** The minting agent's proposed task update; set only by `reviewTaskUpdate`. */
  readonly updateCandidate?: PendingTaskUpdate;
  readonly allowedEffects: readonly string[];
  /**
   * The questions the owner answered in this job through the host's question flow, each with its
   * screened answer, in the order answered; a prompt asked again keeps only its latest answer.
   * Protected answers (secrets and logins) and a read-or-write choice are left out.
   */
  readonly answeredQuestions?: readonly AnsweredQuestion[];
  /**
   * Execution reviews only: the screened results of this attempt's last six steps, oldest first,
   * as the agent received them, each capped at 4 KiB. Untrusted website evidence, never authority.
   */
  readonly stepResults?: readonly {
    readonly executionId: string;
    readonly result: string;
  }[];
  /** Publication-only privacy scope selected by the host, never by the reviewer. */
  readonly publication?: PublicationScope;
  /** Host-selected mechanics and recorded chronology, not website claims or added authority. */
  readonly mintContext?: {
    /** Host authorization mechanics only; does not establish the source's read semantics. */
    readonly repeatableRead: boolean;
    /** Exact host-bound operation namespace available through readSource. */
    readonly operationSources: readonly string[];
    /**
     * Execution reviews of source only: the host's static import closure of the submitted
     * entrypoint, a lower bound on the operation files it loads. A module that could load a file
     * its imports do not name keeps every candidate file in it.
     */
    readonly executedSources?: readonly string[];
    /**
     * Execution reviews of source only: the screened JSON input schema the host last read, the
     * registered tool's in maintenance, else the one this attempt's latest example or contract
     * extraction declared. Absent before either; the source may have changed since.
     */
    readonly inputSchema?: string;
    /** Host-selected mechanics, not evidence of website state or additional authority. */
    readonly currentExecution?: {
      readonly purpose:
        | "command"
        | "explore"
        | "authenticate"
        | "test"
        | "example"
        | "act"
        | "inspect"
        | "residual"
        | "validate"
        | "contract";
      readonly target: "pureFiles" | "savedHTTP" | "savedDOM" | "liveBrowser";
      /**
       * agent_chosen: a read's live test on an input the minting agent chose instead of the
       * caller's. intent_derived: a read's example or a write's act step whose caller sent empty
       * input runs the agent's reading of the intent and the owner's answered questions as its
       * submitted input.
       */
      readonly input?: "agent_chosen" | "intent_derived";
      /**
       * Host facts about an offline command's sandbox. The submitted entrypoint is the command
       * text itself; the host runs it through its own shell wrapper, which is not reviewed.
       */
      readonly commandSandbox?: {
        readonly cwd: string;
        readonly timeoutSeconds: number;
        readonly maxOutputBytes: number;
      };
    };
    readonly browser: "not_opened" | "active" | "closed" | "unavailable";
    /**
     * Host fact, present only while no sign-in in this attempt is verified: the `{{secret.<id>}}`
     * handles answering a one-time or authenticator code question the agent asked after an
     * authenticate step of this attempt and before any verified sign-in, the code the site sent
     * as part of that sign-in. A code asked any other time is never listed.
     */
    readonly signInCodes?: readonly string[];
    readonly captureIndex?: string;
    /**
     * The host's own notice, present once it replaced the attempt's browser (a proxy, mode or
     * loss recovery, or the agent's reviewed request): it directed the agent to navigate on from
     * the new browser's current page. Host-written, never agent text.
     */
    readonly browserReplacement?: { readonly notice: string };
    /**
     * Where the host last observed the active browser's page: the origin and path from its
     * latest capture checkpoint, and that checkpoint's readable capture. Host-verified, not a
     * website claim. Absent before an observation, and after a new browser or a page reset
     * until the next one.
     */
    readonly currentPage?: {
      readonly origin: string;
      readonly path: string;
      readonly capture: string;
    };
    readonly executions: readonly {
      readonly executionId: string;
      readonly attempt: "current" | "previous";
      readonly purpose: string;
      readonly target?: string;
      readonly status: "running" | "completed" | "failed" | "unsupported" | "needs_input";
      readonly effect: "not_sent" | "possible" | "verified";
      /** True only after the host confirms cleanup of this execution's sandbox. */
      readonly executorStopped?: boolean;
      /** The live test ran an input the minting agent chose; the attempt's count of them. */
      readonly input?: "agent_chosen";
      /**
       * The task revision the execution ran under, once an update applied: 0 for the original
       * request, else the `taskUpdates` revision then in force. What it did is judged against that
       * revision, never a later one.
       */
      readonly taskRevision?: number;
      readonly authentication?: {
        readonly state: "authenticated" | "failed";
        readonly effect: "possible" | "verified";
      };
    }[];
  };
}

/** Token counts of one review's model calls, summed over its calls. */
export interface GuardianUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** What the host puts in view before the reviewer runs. */
export interface ReviewSources {
  /** The entrypoint's first chunk, read by the host; absent when that read failed. */
  readonly entrypoint?: unknown;
  /** Executed sources byte-identical to a read already in this conversation's view. */
  readonly unchangedSources?: readonly string[];
}

export interface ReviewTurn {
  readonly reviewId: string;
  readonly session?: GuardianSession;
  readonly pending: PendingExecution;
  readonly sources?: ReviewSources;
  readonly readSource: (path: string, offset: number) => Effect.Effect<string, ReviewFailure>;
  /**
   * The follow-up the reviewer sends, in the same review, when its output still needs a read it
   * did not do; undefined when the output stands. The host allows at most two such rounds.
   */
  readonly missingRead?: (raw: unknown) => string | undefined;
  readonly reportUsage?: (usage: GuardianUsage) => Effect.Effect<void>;
  readonly reportDiagnostic?: (
    value: unknown,
    timing?: ModelDiagnosticTiming,
  ) => Effect.Effect<void, ReviewFailure>;
  /** Required traced original model/tool record; a failure ends the review unavailable. */
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, ReviewFailure>;
  /** Finite timing only, for a review whose transcript is not retained (no `reportDiagnostic`). */
  readonly observeTiming?: (timing: ModelDiagnosticTiming) => Effect.Effect<void>;
}

/** The retention failure's own detail (operation, underlying error) beneath the review's. */
const retentionDetail = (error: unknown, operation: string) =>
  failureDetail("guardian_dependency_failed", {
    operation,
    error,
    helperFrames: 1,
  });

/** Maps a traced-record failure to the existing diagnostic-retention review outcome. */
const guardianRuntimeRecords = (
  diagnostics: GuardianDiagnostics | undefined,
  options: GuardianReviewOptions,
) => {
  const retain = diagnostics?.retainRuntimeRecord;
  return retain === undefined
    ? undefined
    : (record: RuntimeRecordInput) =>
        retain(record).pipe(
          Effect.mapError(
            (error) =>
              options.diagnosticFailure?.(error, "diagnostics.retainRuntimeRecord") ??
              new ReviewFailure({
                code: "Unavailable",
                reviewPhase: "diagnostic_retention",
                failureDetail: retentionDetail(error, "diagnostics.retainRuntimeRecord"),
              }),
          ),
        );
};

/**
 * How the host retries a review that did not complete. Waits run between attempts, the last
 * one repeating; a run of consecutive outages retries only within `budget`, then its failure is
 * returned as before.
 */
export interface ReviewRetry {
  readonly delays: readonly [Duration.DurationInput, ...Duration.DurationInput[]];
  readonly budget: Duration.DurationInput;
}

/** Production retry for Guardian outages: provider errors, timeouts, turn limits, a decision
 * that does not decode and a required source read that failed. */
export const guardianOutageRetry: ReviewRetry = {
  delays: ["2 seconds", "5 seconds", "15 seconds", "30 seconds", "60 seconds"],
  budget: "5 minutes",
};

/**
 * An outage the same review can get past by running again. Diagnostic retention keeps its own
 * handling, a spent model quota stays spent, and a refusal is a verdict, not an outage.
 */
const retriableOutage = (failure: ReviewFailure): boolean =>
  failure.modelQuotaExhausted !== true &&
  failure.reviewPhase !== "diagnostic_retention" &&
  failure.diagnosticRetentionReason === undefined &&
  (failure.code === "Unavailable" ||
    failure.code === "TurnLimitExceeded" ||
    failure.code === "InvalidDecision" ||
    failure.code === "SourceUnavailable");

export interface Reviewer {
  readonly run: (turn: ReviewTurn) => Effect.Effect<unknown, ReviewFailure>;
  /** Host retry for outages. Absent, a failed review returns at once. */
  readonly retry?: ReviewRetry;
}

/**
 * One run of a review inside the outage retry loop. Offsets are `performance.now()` readings.
 * Each attempt is a fresh review with its own ID and its own `guardian.started` record, closed
 * by one `guardian.completed` or `guardian.failed`. The follow-up rounds an execution review
 * gets for a skipped entrypoint read stay inside its attempt, under the same review ID, and its
 * closing record counts them as `followUpRounds`.
 */
interface ReviewAttempt {
  /** 1-based, counting outage retries only. */
  readonly ordinal: number;
  /** This attempt's own wait for the session permit, when it ran under one. */
  readonly permitWait?: {
    readonly startOffsetMs: number;
    readonly endOffsetMs: number;
  };
  readonly started: (correlation: {
    readonly reviewId: string;
    readonly reviewKind: "execution" | "publication" | "question" | "update" | "host";
  }) => void;
}

const completeSession = (session?: GuardianSession) =>
  session
    ? session.complete().pipe(
        Effect.mapError(
          (error) =>
            new ReviewFailure({
              code: "Unavailable",
              reviewPhase: "diagnostic_retention",
              failureDetail: retentionDetail(error, "guardian.session.complete"),
            }),
        ),
      )
    : Effect.void;

/** The most follow-up rounds one review gets for a required read it skipped. */
export const requiredReadRounds = 2;

const decisionFailure = (error: unknown) =>
  new ReviewFailure({
    failureDetail: failureDetail("guardian_dependency_failed", {
      error,
      phase: "decision_validation",
    }),
    code: "InvalidDecision",
  });

const decodeExecution = (raw: unknown) =>
  Schema.decodeUnknown(GuardianDecision)(boundedRationale(raw)).pipe(
    Effect.mapError(decisionFailure),
  );

const decodeHost = (request: HostReview) => {
  const shape = Schema.Struct({
    outcome: Schema.Literal(...request.outcomes),
    rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(rationaleLimit)),
    ...(request.labels === undefined ? {} : { label: Schema.Literal(...request.labels) }),
  });
  return (raw: unknown): Effect.Effect<HostReviewDecision, ReviewFailure> =>
    Schema.decodeUnknown(shape)(boundedRationale(raw), { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) =>
        decisionFailure(request.private === true ? privateDecisionError(request, raw) : error),
      ),
    );
};

/**
 * A private kind's invalid decision, described by a fixed reason only: the parse error would
 * echo the rejected value and the kind's labels into every readable record of the failure.
 */
const privateDecisionError = (request: HostReview, raw: unknown) => {
  const label = typeof raw === "object" && raw !== null ? Reflect.get(raw, "label") : undefined;
  return new Error(
    label !== undefined && !(request.labels ?? []).some((allowed) => allowed === label)
      ? "The label is not one of the kind's labels"
      : "The decision does not match the kind's format",
  );
};

export const makeGuardian = (
  reviewer: Reviewer,
  diagnostics?: GuardianDiagnostics,
  continuity?: GuardianSessionOptions,
  options: GuardianReviewOptions = {},
) => {
  const bestEffort =
    options.bestEffort ??
    (<A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        // error-reporting-allow: typed-recovery only retry/failure notifications are optional; required source retention and the review failure propagate separately
        Effect.catchAllCause(() => Effect.void),
        Effect.asVoid,
      ));
  const session = continuity === undefined ? undefined : makeGuardianSession(continuity);
  /**
   * Runs one review again after an outage, each time as a fresh review with its own ID, until
   * it completes or the outage outlasts the retry budget.
   */
  const retryReview = <A>(
    kind: ReviewKind,
    attempt: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ): Effect.Effect<A, ReviewFailure> => {
    const retry = reviewer.retry;
    if (retry === undefined) return attempt({ ordinal: 1, started: () => undefined });
    const budgetMs = Duration.toMillis(retry.budget);
    return Effect.gen(function* () {
      const startedMs = yield* Clock.currentTimeMillis;
      for (let retries = 0; ; retries++) {
        // The failed attempt's review, so its retry interval is tied to it.
        let correlation: Parameters<ReviewAttempt["started"]>[0] | undefined;
        const outcome = yield* Effect.either(
          attempt({
            ordinal: retries + 1,
            started: (started) => {
              correlation = started;
            },
          }),
        );
        if (outcome._tag === "Right") return outcome.right;
        const failure = outcome.left;
        const waitMs = Duration.toMillis(
          retry.delays[Math.min(retries, retry.delays.length - 1)] ?? retry.delays[0],
        );
        const outageMs = (yield* Clock.currentTimeMillis) - startedMs;
        if (!retriableOutage(failure) || outageMs + waitMs > budgetMs) return yield* failure;
        const startOffsetMs = performance.now();
        yield* bestEffort(
          diagnostics?.emit(
            "guardian.review_retried",
            {
              kind,
              retry: retries + 1,
              attempt: retries + 1,
              code: failure.code,
              ...(failure.reviewPhase === undefined ? {} : { reviewPhase: failure.reviewPhase }),
              ...failureDetailMetadata(failure),
              waitMs,
              outageMs,
              startOffsetMs,
              endOffsetMs: startOffsetMs + waitMs,
            },
            correlation,
          ) ?? Effect.void,
          "guardian.review_retried",
        );
        yield* Effect.sleep(Duration.millis(waitMs));
      }
    });
  };
  /**
   * One review attempt holds the session alone. The wait for it is reported as an interval, and
   * the waits between retries run outside it, so another review can use the session meanwhile.
   */
  const exclusive = <A>(
    kind: ReviewKind,
    run: ReviewAttempt,
    work: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ) =>
    session === undefined
      ? work(run)
      : Effect.gen(function* () {
          const requestedMs = yield* Clock.currentTimeMillis;
          const startOffsetMs = performance.now();
          return yield* session.exclusive(
            Effect.gen(function* () {
              const acquiredMs = yield* Clock.currentTimeMillis;
              const endOffsetMs = performance.now();
              yield* bestEffort(
                diagnostics?.emit("guardian.session_wait", {
                  kind,
                  attempt: run.ordinal,
                  startedAtUtc: new Date(requestedMs).toISOString(),
                  endedAtUtc: new Date(acquiredMs).toISOString(),
                  waitMs: acquiredMs - requestedMs,
                }) ?? Effect.void,
                "guardian.session_wait",
              );
              return yield* work({ ...run, permitWait: { startOffsetMs, endOffsetMs } });
            }),
          );
        });
  const withOutageRetry = <A>(
    kind: ReviewKind,
    attempt: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ) => retryReview(kind, (run) => exclusive(kind, run, attempt));
  const review = <Decision extends { readonly outcome: string }>(
    run: ReviewAttempt,
    pending: PendingExecution,
    readSource: ReviewTurn["readSource"],
    decode: (raw: unknown) => Effect.Effect<Decision, ReviewFailure>,
  ): Effect.Effect<{ reviewId: string; decision: Decision }, ReviewFailure> =>
    Effect.gen(function* () {
      const reviewId = randomUUID();
      const kind = reviewKindOf(pending);
      const reviewKind = kind === "recovery" ? "execution" : kind;
      // A private host kind's request is private review context: no readable copy of it, its
      // transcript or its rationale is kept.
      const privateKind = pending.hostReview?.private === true;
      const hostKind =
        pending.hostReview === undefined ? {} : { hostKind: pending.hostReview.kind };
      const retainRuntimeRecord = guardianRuntimeRecords(diagnostics, options);
      const emit = (name: string, details: unknown, timing?: ModelDiagnosticTiming) =>
        (
          diagnostics?.[
            name === "guardian.model" && timing !== undefined && pending.publication === undefined
              ? "retainModelTranscript"
              : "emit"
          ](
            name,
            { reviewId, details },
            {
              reviewId,
              reviewKind,
              ...(timing === undefined ? {} : { modelTiming: timing }),
              // Guardian's readable copies are never dropped for ordinary diagnostics.
              required: true,
            },
          ) ?? Effect.void
        ).pipe(
          Effect.mapError(
            (error) =>
              options.diagnosticFailure?.(error, "diagnostics.emit") ??
              new ReviewFailure({
                code: "Unavailable",
                reviewPhase: "diagnostic_retention",
                failureDetail: retentionDetail(error, "diagnostics.emit"),
              }),
          ),
        );
      run.started({ reviewId, reviewKind });
      const observeModelTrace = diagnostics?.observeModelTrace;
      // Follow-up rounds for a skipped entrypoint read, sent within this attempt.
      let followUpRounds = 0;
      const startOffsetMs = performance.now();
      const timing = {
        attempt: run.ordinal,
        startOffsetMs,
        ...(run.permitWait === undefined
          ? {}
          : {
              permitWaitStartOffsetMs: run.permitWait.startOffsetMs,
              permitWaitEndOffsetMs: run.permitWait.endOffsetMs,
            }),
      };
      const endTiming = () => {
        const endOffsetMs = performance.now();
        return {
          attempt: run.ordinal,
          startOffsetMs,
          endOffsetMs,
          elapsedMs: endOffsetMs - startOffsetMs,
          ...(followUpRounds === 0 ? {} : { followUpRounds }),
        };
      };
      yield* emit(
        "guardian.started",
        privateKind
          ? {
              mode: "private",
              ...hostKind,
              invocationId: pending.invocationId,
              attemptId: pending.attemptId,
              timing,
            }
          : pending.publication === undefined
            ? { ...pending, timing }
            : {
                mode: "publication",
                ...pending,
                manifestFiles: pending.publication.files.length,
                manifestBytes: pending.publication.files.reduce(
                  (total, file) => total + file.byteLength,
                  0,
                ),
                timing,
              },
      );
      return yield* Effect.gen(function* () {
        // Only an execution runs the agent's code, so only its allow needs the entrypoint read.
        const requireEntrypoint = kind === "execution";
        const entrypoint = sourcePath(pending.entrypoint);
        // A compaction replaces what Guardian sees, so a read counts only until the next one.
        const epoch = () => session?.compactions() ?? 0;
        let entrypointReadAt: number | undefined;
        const publication = pending.publication;
        const unavailableSources = new Map<string, ReviewFailure>();
        // A publication review's reads are its source_read diagnostics below instead.
        const retain = (observation: string) =>
          publication !== undefined
            ? Effect.void
            : (diagnostics?.retainScreenedSource({ reviewId, observation }) ?? Effect.void).pipe(
                Effect.mapError(
                  (error) =>
                    options.diagnosticFailure?.(error, "diagnostics.retainScreenedSource") ??
                    new ReviewFailure({
                      code: "Unavailable",
                      reviewPhase: "diagnostic_retention",
                      failureDetail: retentionDetail(error, "diagnostics.retainScreenedSource"),
                    }),
                ),
              );
        /**
         * One read of the host's reader, with its interval as `performance.now()` offsets for the
         * read's failure record. A retention failure after the read carries the read's interval.
         */
        const timedRead = (path: string, offset: number) => {
          let startOffsetMs = 0;
          let endOffsetMs = 0;
          return {
            effect: Effect.suspend(() => {
              startOffsetMs = performance.now();
              return readSource(path, offset);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  endOffsetMs = performance.now();
                }),
              ),
            ),
            interval: () => ({
              elapsedMs: endOffsetMs - startOffsetMs,
              startOffsetMs,
              endOffsetMs,
            }),
          };
        };
        const sourceFailed = (path: string, offset: number, error: ReviewFailure) => ({
          ...(publication === undefined
            ? { path, offset }
            : {
                path,
                manifestIndex: publication.files.findIndex((file) => file.path === path),
                offset,
              }),
          code: error.code,
          ...(error.publicationBlock === undefined
            ? {}
            : { publicationBlock: error.publicationBlock }),
          ...(error.diagnosticRetentionReason === undefined
            ? {}
            : { diagnosticRetentionReason: error.diagnosticRetentionReason }),
          ...(error.diagnosticScreeningReason === undefined
            ? {}
            : { diagnosticScreeningReason: error.diagnosticScreeningReason }),
          // Why the read failed, with its whole detail.
          ...failureDetailOf(error),
        });
        /** Guardian's own reads, through its tool: tracked for required evidence. */
        const read: ReviewTurn["readSource"] = (requested, offset) => {
          const path = sourcePath(requested);
          const timed = timedRead(path, offset);
          return timed.effect.pipe(
            Effect.tap(retain),
            Effect.tapError((error) =>
              emit("guardian.source_failed", {
                ...sourceFailed(path, offset, error),
                ...timed.interval(),
              }),
            ),
            Effect.tap((observation) =>
              publication === undefined
                ? Effect.void
                : emit("guardian.source_read", {
                    path,
                    manifestIndex: publication.files.findIndex((file) => file.path === path),
                    offset,
                    observation,
                  }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                // Tool adapters can return source failures as model-visible text.
                // Preserve required evidence failures even if the model then denies.
                if (
                  (requireEntrypoint && path === entrypoint && offset === 0) ||
                  error.diagnosticRetentionReason !== undefined
                )
                  unavailableSources.set(JSON.stringify([path, offset]), error);
              }),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                unavailableSources.delete(JSON.stringify([path, offset]));
                if (path === entrypoint && offset === 0) entrypointReadAt = epoch();
              }),
            ),
          );
        };
        let sources: ReviewSources | undefined;
        if (requireEntrypoint) {
          // The entrypoint goes into the request itself, so a typical review needs one call. This
          // is the host's read, kept apart from Guardian's: when it fails the source is left out
          // and Guardian reads it itself, and when only retaining the screened copy fails, the
          // source stays in view and the gap is recorded.
          const hostRead = timedRead(entrypoint, 0);
          const included = yield* Effect.either(hostRead.effect);
          const gap = (error: ReviewFailure) =>
            bestEffort(
              emit("guardian.source_failed", {
                ...sourceFailed(entrypoint, 0, error),
                ...hostRead.interval(),
                automatic: true,
              }),
              "guardian.source_failed",
            );
          if (included._tag === "Left") yield* gap(included.left);
          else {
            entrypointReadAt = epoch();
            const retained = yield* Effect.either(retain(included.right));
            if (retained._tag === "Left") yield* gap(retained.left);
          }
          const unchanged =
            session === undefined
              ? []
              : yield* unchangedSources(
                  sourceLedger(session.history()),
                  (pending.mintContext?.executedSources ?? []).filter(
                    (path) => sourcePath(path) !== entrypoint,
                  ),
                  (path, offset) => readSource(sourcePath(path), offset),
                );
          sources = {
            ...(included._tag === "Right"
              ? {
                  entrypoint: sourceChunkOf(included.right)?.value ?? included.right,
                }
              : {}),
            ...(unchanged.length === 0 ? {} : { unchangedSources: unchanged }),
          };
        }
        const unread = (raw: unknown) =>
          requireEntrypoint &&
          typeof raw === "object" &&
          raw !== null &&
          Reflect.get(raw, "outcome") === "allow" &&
          entrypointReadAt !== epoch();
        const raw = yield* reviewer.run({
          reviewId,
          ...(session ? { session } : {}),
          pending,
          ...(sources === undefined ? {} : { sources }),
          ...(retainRuntimeRecord === undefined ? {} : { retainRuntimeRecord }),
          // A private kind's transcript is never kept, so only its finite timing is reported.
          ...(privateKind
            ? observeModelTrace === undefined
              ? {}
              : {
                  observeTiming: (modelTiming: ModelDiagnosticTiming) =>
                    observeModelTrace("guardian.model", modelTiming, { reviewId, reviewKind }),
                }
            : {
                reportDiagnostic: (value: unknown, modelTiming?: ModelDiagnosticTiming) =>
                  emit("guardian.model", value, modelTiming),
              }),
          reportUsage: (usage) =>
            bestEffort(
              diagnostics?.emit(
                "guardian.usage",
                { reviewId, details: usage },
                { reviewId, reviewKind },
              ) ?? Effect.void,
              "guardian.usage",
            ),
          missingRead: (output) => {
            if (!unread(output)) return undefined;
            followUpRounds++;
            return `The host did not accept this allow: an allow needs the submitted entrypoint ${entrypoint} in view in this review, and it is not, because the host could not include it or the conversation was compacted since. Read ${entrypoint} from offset 0 with read_source, then decide again.`;
          },
          readSource: read,
        });
        const unavailableSource = unavailableSources.values().next().value;
        if (unavailableSource !== undefined) return yield* unavailableSource;
        const projected = decisionForKind(pending, raw);
        if (projected === undefined)
          return yield* decisionFailure(
            new Error(`The outcome is not one a ${kind} review returns`),
          );
        const decision = yield* decode(projected);
        if (requireEntrypoint && decision.outcome === "allow" && entrypointReadAt !== epoch())
          return yield* new ReviewFailure({ code: "EntrypointNotRead" });
        yield* emit(
          "guardian.completed",
          privateKind
            ? { mode: "private", ...hostKind, outcome: decision.outcome, timing: endTiming() }
            : publication === undefined
              ? { ...decision, timing: endTiming() }
              : { mode: "publication", ...decision, timing: endTiming() },
        );
        yield* completeSession(session);
        return { reviewId, decision };
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? emit("guardian.failed", {
                state: "failed",
                ...(pending.publication === undefined ? {} : { mode: "publication" }),
                ...(privateKind ? { mode: "private", ...hostKind } : {}),
                cause: Cause.map(exit.cause, withoutDetail),
                ...failureDetailMetadata(Option.getOrUndefined(Cause.failureOption(exit.cause))),
                timing: endTiming(),
              }).pipe((emitted) => bestEffort(emitted, "guardian.review_diagnostic"))
            : Effect.void,
        ),
      );
    });
  return {
    session,
    review: (pending: PendingExecution, readSource: ReviewTurn["readSource"]) =>
      Effect.suspend(() => {
        if (
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        const scope = pending.publication;
        return withOutageRetry(scope === undefined ? "execution" : "publication", (run) =>
          review(run, pending, readSource, (raw) =>
            scope === undefined
              ? decodeExecution(raw)
              : (options.decodePublication ?? decodePublicationDecision)(
                  scope,
                  boundedRationale(raw),
                ),
          ),
        );
      }),
    /**
     * Reviews the minting agent's request for a new browser as an ordinary execution review of
     * its reason, with the same context and evidence tool. It runs no code, so no
     * entrypoint read is required.
     */
    reviewRecovery: (
      pending: PendingExecution,
      rationale: string,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: GuardianDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("recovery", (run) =>
          review(
            run,
            { ...pending, recoveryCandidate: { rationale } },
            readSource,
            decodeExecution,
          ),
        );
      }),
    /**
     * Reviews one proposed input request through the same path, context and evidence tool as an
     * execution. A reword is never capped: each one is the agent's to act on.
     */
    reviewQuestion: (
      pending: PendingExecution,
      question: PendingQuestion,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: QuestionDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("question", (run) =>
          review(run, { ...pending, questionCandidate: question }, readSource, (raw) =>
            Schema.decodeUnknown(QuestionDecision)(raw, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(decisionFailure)),
          ),
        );
      }),
    /**
     * Reviews the minting agent's proposed task update (`mint_update`) against the effective task
     * the pending review carries, through the same path, context and evidence tool as a question.
     * It runs no code, so no entrypoint read is required.
     */
    reviewTaskUpdate: (
      pending: PendingExecution,
      update: PendingTaskUpdate,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: TaskUpdateDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.updateCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("update", (run) =>
          review(run, { ...pending, updateCandidate: update }, readSource, (raw) =>
            Schema.decodeUnknown(TaskUpdateDecision)(raw, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(decisionFailure)),
          ),
        );
      }),
    /**
     * Runs one review of a host-defined kind as one more turn of the same conversation, under
     * the host's policy for it, and returns one of its outcomes. Without a reader, a source read
     * fails and Guardian judges the evidence it was given.
     */
    reviewHostKind: (
      pending: PendingExecution,
      request: HostReview,
      readSource: ReviewTurn["readSource"] = () =>
        Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
    ): Effect.Effect<{ reviewId: string; decision: HostReviewDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("host", (run) =>
          review(run, { ...pending, hostReview: request }, readSource, decodeHost(request)),
        );
      }),
  };
};
