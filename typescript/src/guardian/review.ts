import { makeGuardianSession } from "./session.js";
import type { GuardianSession, GuardianSessionOptions } from "./session.js";
import { QuestionDecision } from "./question.js";
import type { AnsweredQuestion, PendingQuestion } from "./question.js";
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
export type { PublicationFileBlock } from "./review-contracts.js";

export interface GuardianDiagnostics {
  readonly emit: (
    name: string,
    details: unknown,
    correlation?: {
      readonly reviewId?: string;
      readonly reviewKind?: "execution" | "publication" | "question";
      readonly modelTiming?: ModelDiagnosticTiming;
      readonly required?: boolean;
    },
  ) => Effect.Effect<void, Error>;
  readonly retainModelTranscript: GuardianDiagnostics["emit"];
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, Error>;
  readonly retainScreenedSource: (args: {
    readonly reviewId: string;
    readonly observation: string;
  }) => Effect.Effect<void, Error>;
}
export interface GuardianReviewOptions {
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
    | "TurnLimitExceeded";
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

export interface PendingExecution {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly entrypoint: string;
  // Intent and input have already crossed the trusted privacy broker. Observations carry the
  // published login URL raw, exactly as stored.
  readonly screenedIntent: string;
  /**
   * Mints only: the screened intent as the owner submitted it, without the approved write
   * upgrade's question that `screenedIntent` may carry, whose wording is the minting model's.
   */
  readonly requestedIntent?: string;
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
  readonly stepResults?: readonly { readonly executionId: string; readonly result: string }[];
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
       * caller's. intent_derived: a read's example whose caller sent empty input runs the agent's
       * reading of the intent and the owner's answered questions as its submitted input.
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
      readonly authentication?: {
        readonly state: "authenticated" | "failed";
        readonly effect: "possible" | "verified";
      };
    }[];
  };
}

export interface ReviewTurn {
  readonly reviewId: string;
  readonly session?: GuardianSession;
  readonly pending: PendingExecution;
  readonly readSource: (path: string, offset: number) => Effect.Effect<string, ReviewFailure>;
  readonly reportDiagnostic?: (
    value: unknown,
    timing?: ModelDiagnosticTiming,
  ) => Effect.Effect<void, ReviewFailure>;
  /** Required traced original model/tool record; a failure ends the review unavailable. */
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, ReviewFailure>;
}

/** The retention failure's own detail (operation, underlying error) beneath the review's. */
const retentionDetail = (error: unknown, operation: string) =>
  failureDetail("guardian_dependency_failed", { operation, error, helperFrames: 1 });

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
    kind: "execution" | "publication" | "question" | "recovery",
    attempt: Effect.Effect<A, ReviewFailure>,
  ): Effect.Effect<A, ReviewFailure> => {
    const retry = reviewer.retry;
    if (retry === undefined) return attempt;
    const budgetMs = Duration.toMillis(retry.budget);
    return Effect.gen(function* () {
      const startedMs = yield* Clock.currentTimeMillis;
      for (let retries = 0; ; retries++) {
        const outcome = yield* Effect.either(attempt);
        if (outcome._tag === "Right") return outcome.right;
        const failure = outcome.left;
        const waitMs = Duration.toMillis(
          retry.delays[Math.min(retries, retry.delays.length - 1)] ?? retry.delays[0],
        );
        const outageMs = (yield* Clock.currentTimeMillis) - startedMs;
        if (!retriableOutage(failure) || outageMs + waitMs > budgetMs) return yield* failure;
        yield* bestEffort(
          diagnostics?.emit("guardian.review_retried", {
            kind,
            retry: retries + 1,
            code: failure.code,
            ...(failure.reviewPhase === undefined ? {} : { reviewPhase: failure.reviewPhase }),
            ...failureDetailMetadata(failure),
            waitMs,
            outageMs,
          }) ?? Effect.void,
          "guardian.review_retried",
        );
        yield* Effect.sleep(Duration.millis(waitMs));
      }
    });
  };
  const withOutageRetry = <A>(
    kind: "execution" | "publication" | "question" | "recovery",
    attempt: Effect.Effect<A, ReviewFailure>,
  ) => {
    const work = retryReview(kind, attempt);
    return session ? session.exclusive(work) : work;
  };
  const review = <Decision extends GuardianDecision | QuestionDecision>(
    pending: PendingExecution,
    readSource: ReviewTurn["readSource"],
    decode: (raw: unknown) => Effect.Effect<Decision, ReviewFailure>,
    /**
     * An execution's allow needs its entrypoint read. A proposed question has no submitted script,
     * and a publication review reads what it needs, so neither requires one.
     */
    requireEntrypoint = true,
  ): Effect.Effect<{ reviewId: string; decision: Decision }, ReviewFailure> =>
    Effect.gen(function* () {
      const reviewId = randomUUID();
      const reviewKind =
        pending.publication !== undefined
          ? ("publication" as const)
          : pending.questionCandidate !== undefined
            ? ("question" as const)
            : ("execution" as const);
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
      yield* emit(
        "guardian.started",
        pending.publication === undefined
          ? pending
          : {
              mode: "publication",
              ...pending,
              manifestFiles: pending.publication.files.length,
              manifestBytes: pending.publication.files.reduce(
                (total, file) => total + file.byteLength,
                0,
              ),
            },
      );
      return yield* Effect.gen(function* () {
        let inspectedEntrypoint = false;
        const publication = pending.publication;
        const unavailableSources = new Map<string, ReviewFailure>();
        const raw = yield* reviewer.run({
          reviewId,
          ...(session ? { session } : {}),
          pending,
          ...(retainRuntimeRecord === undefined ? {} : { retainRuntimeRecord }),
          reportDiagnostic: (value, timing) => emit("guardian.model", value, timing),
          readSource: (path, offset) =>
            readSource(path, offset).pipe(
              // A publication review's reads are its source_read diagnostics below instead.
              Effect.tap((observation) =>
                publication !== undefined
                  ? Effect.void
                  : (
                      diagnostics?.retainScreenedSource({ reviewId, observation }) ?? Effect.void
                    ).pipe(
                      Effect.mapError(
                        (error) =>
                          options.diagnosticFailure?.(error, "diagnostics.retainScreenedSource") ??
                          new ReviewFailure({
                            code: "Unavailable",
                            reviewPhase: "diagnostic_retention",
                            failureDetail: retentionDetail(
                              error,
                              "diagnostics.retainScreenedSource",
                            ),
                          }),
                      ),
                    ),
              ),
              Effect.tapError((error) =>
                emit("guardian.source_failed", {
                  ...(publication === undefined
                    ? { path, offset }
                    : {
                        path,
                        manifestIndex: pending.publication?.files.findIndex(
                          (file) => file.path === path,
                        ),
                        offset,
                      }),
                  code: error.code,
                  ...(error.publicationBlock === undefined
                    ? {}
                    : { publicationBlock: error.publicationBlock }),
                  ...(error.diagnosticRetentionReason === undefined
                    ? {}
                    : {
                        diagnosticRetentionReason: error.diagnosticRetentionReason,
                      }),
                  ...(error.diagnosticScreeningReason === undefined
                    ? {}
                    : { diagnosticScreeningReason: error.diagnosticScreeningReason }),
                  // Why the read failed, with its whole detail.
                  ...failureDetailOf(error),
                }),
              ),
              Effect.tap((observation) =>
                publication === undefined
                  ? Effect.void
                  : emit("guardian.source_read", {
                      path,
                      manifestIndex: pending.publication?.files.findIndex(
                        (file) => file.path === path,
                      ),
                      offset,
                      observation,
                    }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  // Tool adapters can return source failures as model-visible text.
                  // Preserve required evidence failures even if the model then denies.
                  if (
                    (requireEntrypoint && path === pending.entrypoint && offset === 0) ||
                    error.diagnosticRetentionReason !== undefined
                  )
                    unavailableSources.set(JSON.stringify([path, offset]), error);
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  unavailableSources.delete(JSON.stringify([path, offset]));
                  if (path === pending.entrypoint && offset === 0) inspectedEntrypoint = true;
                }),
              ),
            ),
        });
        const unavailableSource = unavailableSources.values().next().value;
        if (unavailableSource !== undefined) return yield* unavailableSource;
        const decision = yield* decode(raw);
        if (requireEntrypoint && decision.outcome === "allow" && !inspectedEntrypoint)
          return yield* new ReviewFailure({ code: "SourceUnavailable" });
        yield* emit(
          "guardian.completed",
          publication === undefined ? decision : { mode: "publication", ...decision },
        );
        yield* completeSession(session);
        return { reviewId, decision };
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? emit("guardian.failed", {
                state: "failed",
                ...(pending.publication === undefined ? {} : { mode: "publication" }),
                cause: Cause.map(exit.cause, withoutDetail),
                ...failureDetailMetadata(Option.getOrUndefined(Cause.failureOption(exit.cause))),
              }).pipe((emitted) => bestEffort(emitted, "guardian.review_diagnostic"))
            : Effect.void,
        ),
      );
    });
  return {
    session,
    review: (pending: PendingExecution, readSource: ReviewTurn["readSource"]) =>
      Effect.suspend(() => {
        if (pending.questionCandidate !== undefined || pending.recoveryCandidate !== undefined)
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry(
          pending.publication === undefined ? "execution" : "publication",
          review(
            pending,
            readSource,
            (raw) => {
              const scope = pending.publication;
              return scope === undefined
                ? Schema.decodeUnknown(GuardianDecision)(boundedRationale(raw)).pipe(
                    Effect.mapError(
                      (error) =>
                        new ReviewFailure({
                          failureDetail: failureDetail("guardian_dependency_failed", {
                            error,
                            phase: "decision_validation",
                          }),
                          code: "InvalidDecision",
                        }),
                    ),
                  )
                : (options.decodePublication?.(scope, boundedRationale(raw)) ??
                    Effect.fail(new ReviewFailure({ code: "InvalidDecision" })));
            },
            pending.publication === undefined,
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
          pending.recoveryCandidate !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry(
          "recovery",
          review(
            { ...pending, recoveryCandidate: { rationale } },
            readSource,
            (raw) =>
              Schema.decodeUnknown(GuardianDecision)(boundedRationale(raw)).pipe(
                Effect.mapError(
                  (error) =>
                    new ReviewFailure({
                      failureDetail: failureDetail("guardian_dependency_failed", {
                        error,
                        phase: "decision_validation",
                      }),
                      code: "InvalidDecision",
                    }),
                ),
              ),
            false,
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
        if (pending.publication !== undefined || pending.questionCandidate !== undefined)
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry(
          "question",
          review(
            { ...pending, questionCandidate: question },
            readSource,
            (raw) =>
              Schema.decodeUnknown(QuestionDecision)(raw, { onExcessProperty: "error" }).pipe(
                Effect.mapError(
                  (error) =>
                    new ReviewFailure({
                      failureDetail: failureDetail("guardian_dependency_failed", {
                        error,
                        phase: "decision_validation",
                      }),
                      code: "InvalidDecision",
                    }),
                ),
              ),
            false,
          ),
        );
      }),
  };
};
