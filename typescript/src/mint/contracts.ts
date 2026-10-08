import type { MintDiagnostics, MintReporting } from "./diagnostics.js";
import type { MintProjection } from "./projection.js";
import { CredentialRejectedField } from "../runtime/authentication.js";
import type { SessionLoss } from "../runtime/authentication.js";
import type { BrowserRecoverySummary } from "../runtime/provider-metadata.js";
import type { CapabilityReview } from "../capabilities/review-contracts.js";
import { IntakeReasonCode } from "../capabilities/intake-contracts.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import type { InputIssue } from "../runtime/errors.js";
import type { DestinationPrivateCandidateReason } from "../destinations/private-candidate.js";
import type { SignedInMarkerCheck } from "../destinations/signed-in-marker.js";
import type { DestinationReason } from "./destination-reason.js";
import type { AuthorityCheckReason, AuthorityCheckStage } from "../auth/authority-metadata.js";
import type {
  OriginalPolicyFailureCode,
  PolicyFailureCheck,
  PolicyFailureReason,
  PolicyFailureContext,
  PolicyFailureSource,
  PolicyFailureUrlCategory,
} from "../runtime/policy-metadata.js";
import { Context, Data, Schema, type Effect } from "effect";
import type { SiteAccessDiagnostic } from "./site-access-contracts.js";
import {
  AutofillPopup,
  AutofillApproval,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
} from "../destinations/autofill-contracts.js";
import type { SandboxSession, SkillDescriptor } from "@openai/agents/sandbox";
import type { AgentInputItem } from "@openai/agents";
import type { Deadline } from "../runtime/deadline.js";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import type {
  MintAgentRecovery,
  MintAgentSnapshot,
  RecoveryToolCall,
} from "./recovery-contracts.js";

import type { CurrentInvocation } from "./invocation.js";
import { SiteNaming } from "../registry/site-naming.js";
import { SupportedOperationVariant } from "../registry/operation-variants.js";
import type { RegistryIssue } from "../registry/issues.js";
import type { ExecutionBoundaryError } from "../execution/boundary.js";
import type { SignInDiagnostic } from "../execution/sign-in-diagnostics.js";
import type { QuestionDecision } from "../guardian/question.js";
import {
  ConfirmQuestion,
  ProposedChoiceQuestion,
  ProposedMultiChoiceQuestion,
  SecretQuestion,
  TextQuestion,
} from "../runtime/input-request.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type { PublicationFileBlock, ReviewFailure } from "../guardian/review.js";
import type { RunnerFailure } from "./runner-failure.js";
import type { HostAnomalySummary, MintAttemptOutcome } from "./incident-contracts.js";
import type {
  InputFeedbackFallback,
  InputFeedbackReview,
  PublishedBuild,
  MintArtifact,
  MintCompletion,
  MintReviewFeedback,
} from "./input-feedback.js";
import { PublicationFinding, PublicationReason } from "../guardian/review-contracts.js";
import { CaptureScreeningDiagnostic } from "../runtime/capture-diagnostic.js";
import type {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../models/model-diagnostic-failure.js";

/** A runner's stdout, stderr and events, already screened with the job's broker for the agent. */
export interface RunnerChannels {
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly events: unknown;
}

/**
 * What spent an attempt's sign-ins: its one sign-in again on the same browser, the sign-ins it
 * allows on a recovery's new profile, or the host's identical refusals in a row while typing into
 * a sign-in screen (`maximumHostRefusals`), which no correction of the step got past.
 */
export type SpentSignIn =
  "relogin_spent" | "fresh_profile_sign_ins_spent" | "host_refusals_repeated";

export type { SessionLoss };

export class MintFailure extends Data.TaggedError("MintFailure")<{
  readonly rejectedCredential?: typeof CredentialRejectedField.Type;
  /** Sub-cause, operation, underlying error, stack and context; see ERROR-LOGGING-STANDARD.md. */
  readonly failureDetail?: FailureDetail;
  /**
   * A job sandbox workspace call that did not complete: which operation, which workspace path,
   * why and how long it took. The paths are the agent's own workspace files and captures.
   */
  readonly workspace?: {
    readonly operation: string;
    readonly path?: string;
    readonly fileCount?: number;
    readonly reason?: string;
    readonly elapsedMs?: number;
  };
  readonly authorityStage?: AuthorityCheckStage;
  readonly authorityReason?: AuthorityCheckReason;
  readonly originalAuthorityFailureCode?: "AuthorityChanged";
  readonly originalPolicyFailureCode?: OriginalPolicyFailureCode;
  readonly policyFailureSource?: PolicyFailureSource;
  readonly policyFailureCheck?: PolicyFailureCheck;
  readonly policyFailureReason?: PolicyFailureReason;
  readonly policyFailureContext?: PolicyFailureContext;
  readonly policyFailureUrlCategory?: PolicyFailureUrlCategory;
  readonly destinationReason?: DestinationReason;
  readonly destinationPrivateCandidateReason?: DestinationPrivateCandidateReason;
  readonly publicationDiagnostics?: readonly PublicationDiagnosticGap[];
  /**
   * What the model provider did to end the attempt: `unavailable` when it stayed unavailable
   * through the host's retries (or the run's own record could not be stored), `quota_exhausted`
   * when it refused the call because the account's quota is spent, which no retry gets past. Only
   * this marks a model failure as a host failure; spent model calls, the SDK turn ceiling or an
   * expired deadline end the attempt as the agent's own outcome.
   */
  readonly modelOutage?: "unavailable" | "quota_exhausted";
  /** The session's `decideDialog` step names a `confirm_action_unmatched` refusal names. */
  readonly confirmActionIds?: readonly string[];
  /** Where the input schema rejected the input a `contract_input_mismatch` refusal names. */
  readonly inputIssues?: readonly InputIssue[];
  /** Which host-recorded route evidence a `destination_validation` refusal lacked. */
  readonly destinationEvidenceGap?:
    | "no_route_evidence"
    | "sign_in_route_evidence"
    | "inconsistent_route_evidence"
    | "receipt_mismatch";
  readonly authentication?: SignInDiagnostic;
  /**
   * Why no further sign-in may run in this attempt, set by the host on a sign-in that failed, or
   * was refused, once the attempt's sign-ins are spent: the build ends `sign_in_unavailable`.
   */
  readonly spentSignIn?: SpentSignIn;
  /**
   * Set by the host when the site lost its signed-in session, as on a page load, and the host
   * could not sign in again: the build ends `sign_in_unavailable` with this cause.
   */
  readonly sessionLoss?: SessionLoss;
  /** The build's owner left a request unanswered; the build ends as `no_response`. */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * What a takeover was still waiting on when its recovery wait ran out, such as
   * `sandbox_attachment_unconfirmed`: the build ends with `hostFailure: recovery_timeout`.
   */
  readonly recoveryTimeout?: string;
  /**
   * What a takeover could not confirm about its predecessor's last step, such as
   * `remote_execution_unconfirmed`. No later try can confirm it, so the build ends at once with
   * `hostFailure: recovery_unconfirmed`.
   */
  readonly recoveryUnconfirmed?: string;
  readonly diagnosticRetentionReason?: ReturnType<typeof diagnosticRetentionReason>;
  readonly diagnosticScreeningReason?: ReturnType<typeof diagnosticScreeningReason>;
  readonly diagnosticStorageFailure?: ReturnType<typeof diagnosticStorageFailure>;
  readonly reviewFailure?: ReviewFailure["code"];
  readonly reviewPhase?: ReviewFailure["reviewPhase"];
  /** Proves this submission stopped before execution; says nothing about prior effects. */
  readonly reviewDispatch?: "not_sent";
  /**
   * Why a maintenance recovery gate refused: its reason, what it expected and what it got, and
   * the earliest time a retry can pass it, so the agent fixes or waits instead of guessing.
   */
  readonly recoveryGate?: {
    readonly reason: string;
    readonly expected?: string;
    readonly got?: string;
    /** ISO time; absent when no wait alone can pass the gate. */
    readonly retryAfter?: string;
  };
  readonly reconciliationStage?:
    | "execution_receipt"
    | "observation_schema"
    | "lookup_origin"
    | "account_scope"
    | "intent_input"
    | "resource_binding"
    /** Maintenance recovery stopped and asked its caller. */
    | "inspection_contradicted"
    | "residual_cap";
  /**
   * What the caller answered when maintenance asked them at a `RecoveryEscalation` stage. The
   * caller's own words: context for the agent, never an approval to redo a write.
   */
  readonly callerGuidance?: string;
  readonly code:
    | "InvalidRequest"
    | "Unavailable"
    | "ScopeDenied"
    | "ReviewDenied"
    | "ReviewUnavailable"
    | "AlreadyExecuted"
    | "ReconciliationRequired"
    | "PublicationUnavailable"
    | "CaptureUnavailable"
    | "CredentialsRejected";
  /** Finite host metadata only; never provider messages, bodies, paths or credentials. */
  readonly execution?: Pick<
    ExecutionBoundaryError,
    | "phase"
    | "reason"
    | "dispatch"
    | "stage"
    | "elapsedMs"
    | "providerStatus"
    | "providerCode"
    | "workspace"
    | "runnerResult"
  >;
  /** Closed, host-derived facts from a runner that already finished before capture failed. */
  readonly runnerFailure?: RunnerFailure;
  /** A capture step that failed, so the host returns no capture view for this execution. */
  readonly captureGap?: "secret_discovery" | "capture_publication";
  /** The runner's stdout, stderr and events when there is no capture view to carry them. */
  readonly runnerChannels?: RunnerChannels;
  readonly reason?:
    | "executor_unavailable"
    | "missing_execution_receipt"
    | "result_reference_mismatch"
    | "entrypoint_mismatch"
    | "source_read"
    | "missing_current_entrypoint"
    | "source_validation"
    | "source_screening"
    | "path_screening"
    | "schema_screening"
    | "metadata_decode"
    | "metadata_validation"
    | "destination_validation"
    | "destination_variants"
    /** A Kernel-script tool declares `supportedVariants`, which only Effect runs dispatch; fixable. */
    | "variants_unsupported"
    /** A write repair's bundle is the registered revision's, so it has nothing to publish. */
    | "repair_unchanged"
    /** The saved login to sign in with stayed held by another job through the host's wait. */
    | "login_in_use"
    /** A shared browser sign-in repair cannot publish without a verified replacement recipe. */
    | "autofill_recipe_not_verified"
    | "source_storage"
    | "registry_publication"
    /** The registry refused the definition; `registryIssue` names the check, often fixable. */
    | "registry_invalid_definition"
    /** The tool or catalog moved underneath the publication, and it was not committed over it. */
    | "registry_conflict"
    /** The registry stayed unavailable through the host's retries; publishing may be tried again. */
    | "registry_unavailable"
    | "example_output_unavailable"
    /** A read's HTTP implementation never passed a live test; the minter is asked once. */
    | "http_implementation_untested"
    /** A read's HTTP implementation changed since its passing live test; asked once too. */
    | "http_implementation_stale"
    /** A write session's composed script declares no `write.confirmation`. */
    | "confirmation_undeclared"
    /** A write session's composed script names none of its commit steps in `write.commits`. */
    | "commit_marks_undeclared"
    /** The composed script declares a commit step no act step of the session ever entered. */
    | "commit_marks_unentered"
    /** The session step named for publication did not record the confirmation the script declares. */
    | "confirmation_unrecorded"
    /** The composed script's input schema rejects the caller's own values. */
    | "contract_input_mismatch"
    /** A read's current output schema rejects the output its example returned. */
    | "contract_output_mismatch"
    /** The composed script does not run a confirm popup's action under the session's action id. */
    | "confirm_action_unmatched"
    /** The session did not demonstrate the requested write. */
    | "write_not_submitted"
    /** Authored source holds a literal session token from the token view; recoverable. */
    | "session_token_literal"
    /** Authored source holds the placeholder a withheld history shows instead of a token. */
    | "session_token_placeholder"
    /** Source to publish holds a `{{secret.…}}` handle, which only the build's own executions fill. */
    | "secret_handle"
    /** The live page URL the sign-in used carries one-time authorization values; asked once. */
    | "login_url_one_time"
    /** The login URL to publish carries a registered credential; refused every time. */
    | "login_url_contains_credential"
    /** The name, description, site name or summary to publish carries a registered credential. */
    | "metadata_contains_credential"
    /** The site's integration has no name yet, and the metadata names no `siteName` and `siteSummary`. */
    | "site_metadata_required"
    /** Another enabled tool in the integration this would join has the same tool name. */
    | "tool_name_taken"
    /** The definition to publish quotes the build's account reference; refused every time. */
    | "definition_login_reference"
    /** The publication gate refused a file Guardian's review reads; `publicationBlock` names it. */
    | "evidence_screening"
    /** A `read_source` of a capture the workspace does not hold: it is not saved yet. */
    | "capture_not_saved";
  /** What login URL and metadata feedback names: parts, parameter names and credential kinds, never values. */
  readonly publicationFeedback?: {
    readonly oneTimeParameters?: readonly string[];
    readonly parts?: readonly {
      readonly part: "loginUrl" | "name" | "description" | "siteName" | "siteSummary";
      readonly credentialKinds: readonly string[];
    }[];
  };
  /**
   * What the publication gate refused and where, for `source_screening`, `schema_screening`
   * and `evidence_screening`; never the refused value.
   */
  readonly publicationBlock?: PublicationFileBlock;
  /** For `entrypoint_mismatch`, the entrypoint the named execution's receipt ran. */
  readonly expectedEntrypoint?: string;
  /** For a registry refusal, the check that refused the publication. */
  readonly registryIssue?: RegistryIssue;
  /** For a refused login URL, why no sign-in can start from it; never the URL itself. */
  readonly registryProblem?: string;
  readonly screening?: {
    readonly category: "authored_source" | "entrypoint_wrapper" | "schema";
    /** Included only after the source path passes publication privacy screening. */
    readonly path?: string;
    /** The host-built definition field that needs correction, when one is known. */
    readonly section?: string;
    readonly replacements: number;
  };
  /** Screened by the trusted host; never a raw provider error. */
  readonly review?: {
    readonly outcome: "deny" | "escalate";
    /** A publication review's reason; `input_feedback` is the one that never blocks for good. */
    readonly reason?: PublicationReason;
    /** The Guardian review that returned this publication decision. */
    readonly reviewId?: string;
    readonly rationale: string;
    readonly findings?: readonly PublicationFinding[];
  };
}> {}

export const MintRequest = Schema.Struct({
  mode: Schema.Literal("mint", "maintenance"),
  intent: Schema.String.pipe(Schema.minLength(1)),
  businessInput: Schema.Unknown,
  observations: Schema.Unknown,
  siteOrigin: Schema.optional(Schema.String.pipe(Schema.maxLength(2048))),
  /** `ask` means the owner has not answered yet. Nothing executes or publishes until they do. */
  effect: Schema.optionalWith(Schema.Literal("read", "write", "ask"), {
    default: () => "read" as const,
  }),
});
export type MintRequest = typeof MintRequest.Type;

const SignInSelector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
const SignedInUrlPath = Schema.String.pipe(Schema.pattern(/^\/[^?#]{0,1999}$/));
const SignedInOpenPath = Schema.String.pipe(Schema.pattern(/^\/[^#]{0,1999}$/));
/**
 * A signed-in marker the minting agent asks the host to test before it sends it
 * (`check_signed_in_marker`): its selector, with the path and account page `signedIn` takes.
 */
export const SignedInMarkerCheckRequest = Schema.Struct({
  selector: SignInSelector,
  urlPath: Schema.optional(SignedInUrlPath),
  openPath: Schema.optional(SignedInOpenPath),
});
export type SignedInMarkerCheckRequest = typeof SignedInMarkerCheckRequest.Type;
/**
 * One sign-in screen for host autofill (autofill enabled): the
 * fields the host fills from the held login, each with the kind of value it takes, and the control
 * that submits them, which the host clicks. A screen without a button (a password field that
 * appears once the identifier is filled) names no submit; a method choice names only a submit.
 * `signedIn` names what shows the site signed in, which the host checks on the page itself.
 */
export const SignInStep = Schema.Union(
  Schema.Struct({
    popup: Schema.optional(AutofillPopup),
    rejectedMarkers: Schema.optional(
      Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
    ),
    fields: Schema.Array(
      Schema.Union(
        // An identifier field lists every kind it accepts; the host picks what it sends.
        Schema.Struct({
          selector: SignInSelector,
          accepts: Schema.Array(IdentifierKinds).pipe(
            Schema.minItems(1),
            Schema.filter((kinds) => new Set(kinds).size === kinds.length, {
              message: () => "list each accepted kind once",
            }),
          ),
        }),
        // A date of birth names how the field takes it, or the one part a dropdown takes.
        Schema.Struct({
          selector: SignInSelector,
          slot: SecretSlots,
          format: Schema.optional(DateOfBirthFormat),
          questionSelector: Schema.optional(SignInSelector),
        }).pipe(
          Schema.filter(
            (field) => field.questionSelector === undefined || field.slot === "private_answer",
            { message: () => "only a private answer names a question selector" },
          ),
        ),
      ),
    ).pipe(Schema.maxItems(maximumStepFields)),
    submit: Schema.optional(SignInSelector),
    /**
     * A two-factor method choice: every method the screen offers, each with the control that
     * picks it, and `submit` the one to pick now. Runs pick again from these.
     */
    methods: Schema.optional(
      Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: SignInSelector })).pipe(
        Schema.minItems(1),
        Schema.maxItems(8),
      ),
    ),
  }).pipe(
    Schema.filter((step) => step.fields.length > 0 || step.submit !== undefined, {
      message: () => "a sign-in step fills a field or clicks a control",
    }),
    Schema.filter(
      (step) =>
        step.methods === undefined ||
        (step.fields.length === 0 &&
          step.methods.some((option) => option.selector === step.submit)),
      {
        message: () =>
          "a method choice fills no field, and its submit is the selector of one of its methods",
      },
    ),
  ),
  Schema.Struct({ approval: AutofillApproval, popup: Schema.optional(AutofillPopup) }),
  // The site showed that the login's password or code was wrong: the host asks the owner
  // for a correction in place and never sends the rejected value again.
  Schema.Struct({ rejected: Schema.Struct({ slot: CredentialRejectedField }) }),
  Schema.Struct({
    signedIn: Schema.Struct({
      selector: Schema.optional(SignInSelector),
      urlPath: Schema.optional(SignedInUrlPath),
      /**
       * An account page on the site the host opens first, when the page the sign-in lands on
       * shows no marker itself; the selector or path is checked there.
       */
      openPath: Schema.optional(SignedInOpenPath),
    }).pipe(
      Schema.filter(
        (signedIn) => signedIn.selector !== undefined || signedIn.urlPath !== undefined,
        {
          message: () => "name a selector or a URL path that shows the site signed in",
        },
      ),
    ),
  }),
);
export type SignInStep = typeof SignInStep.Type;

export const ExecutionRequest = Schema.Struct({
  /** `act` is a step of a write build's one live write session; see the writes skill. */
  purpose: Schema.Literal(
    "explore",
    "authenticate",
    "test",
    "example",
    "act",
    "inspect",
    "residual",
  ),
  target: Schema.Literal("pureFiles", "savedHTTP", "savedDOM", "liveBrowser"),
  loginUrl: Schema.optional(Schema.String),
  entrypoint: Schema.String,
  fixtureRefs: Schema.Array(Schema.String),
  caseFilter: Schema.Array(Schema.String),
  maxWorkers: Schema.Number.pipe(Schema.int(), Schema.between(1, 16)),
  timeoutSeconds: Schema.Number.pipe(Schema.int(), Schema.between(1, 1200)),
  /** JSON text, since the model's strict tool schema cannot express an arbitrary object. */
  testInput: Schema.optional(
    Schema.String.pipe(Schema.minLength(2), Schema.maxLength(16_384)).annotations({
      description:
        "Only with purpose test and target liveBrowser on a read build: the tool's input you chose, as JSON text, to show the tool works for values other than the caller's, such as another route or passenger count. Public values only. At most 2 per attempt. Omit it to run the caller's input.",
    }),
  ),
  /** Only on authenticate, and only where the host offers autofill sign-in. */
  signInStep: Schema.optional(SignInStep),
  /**
   * Only when the caller's input is empty (`{}`), on a read build's example or a write build's
   * act step: the tool's input as JSON text, which the agent writes from the request and the
   * owner's answers. The example, or each act step that passes it, runs it. In a write session,
   * the first act step that passes it fixes it, whichever step that is: its later act steps
   * repeat it unchanged, or omit it where the host keeps the session's input and runs it on them.
   */
  exampleInput: Schema.optional(Schema.String),
});
export type ExecutionRequest = typeof ExecutionRequest.Type;
/** The execute tool's input where the site signs in through Kernel Managed Auth. */
export const ManagedSignInExecutionRequest = ExecutionRequest.omit("signInStep");

export const CaptureRequest = Schema.Struct({
  kind: Schema.Literal("full", "response"),
  requestId: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/))),
});
export type CaptureRequest = typeof CaptureRequest.Type;

/**
 * Why a script's question reached nobody, as the agent is told. `reword` and `authentication` are
 * Guardian's corrections, with its rationale, which the agent answers by revising the script's
 * declared question. `invalid` is a request the host could not accept, and `unavailable` a review
 * or delivery the host could not finish. An unanswered question is `noResponse` instead. The originating cause stays in the
 * host's failure report.
 */
export type ScriptQuestionOutcome =
  | {
      readonly requestId: string;
      readonly outcome: "reword" | "authentication";
      readonly reviewId?: string;
      readonly rationale: string;
    }
  | {
      readonly requestId: string;
      readonly outcome: "invalid" | "unavailable";
    };

export interface ExecutionEvidence {
  readonly review?: MintReviewFeedback;
  readonly authentication?: {
    readonly state: "authenticated" | "failed";
    readonly effect: "possible" | "verified";
  };
  readonly executionId: string;
  readonly status: "completed" | "failed" | "unsupported" | "needs_input";
  readonly effect: "not_sent" | "possible" | "verified";
  /** The confirmation a write session step recorded; it closes the session. */
  readonly confirmation?: "message" | "readback";
  /**
   * The confirmation a write session step read when the host did not accept its result, such as
   * one that returned a credential. It leaves the session open, so a later step that only reads
   * the confirmation back can confirm it. The step publishes only when publication says no
   * read-back is possible (`readBackUnavailable`). The write went out, so a host that sets it
   * must treat the commit marks this step entered as settled for every later act step (pass them
   * as `settledCommits` to `makeEffectJournalWith`), so entering one again fails with
   * `CommitAlreadySent`. Ignored when `confirmation` is set.
   */
  readonly withheldConfirmation?: "message" | "readback";
  /** Screened, finite supporting observation; never a replacement execution failure. */
  readonly siteAccess?: SiteAccessDiagnostic;
  /** Trusted host marker from a failed live runner result after cleanup and retention. */
  readonly terminalFailure?: "ChallengeFailure";
  /** Trusted host marker: the example asked the build's owner, who did not answer in time. */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * Trusted host marker: why the question this execution's script asked reached nobody. Only the
   * agent's result carries it; the execution ledger and checkpoints never hold it.
   */
  readonly scriptQuestion?: ScriptQuestionOutcome;
  /** Emitted only by the harness when capability preflight rejects before a claim. */
  readonly preflight?: "rejected_before_claim";
  readonly resultRef?: string;
  /** Private output is screened before returning to the agent. */
  readonly observations: unknown;
  readonly checks?: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly unsupported: number;
    readonly liveSiteTouched: boolean;
  };
}

/** Private recovery codec; observations remain opaque protected values. */
export const ExecutionEvidence: Schema.Schema<ExecutionEvidence> = Schema.Struct({
  review: Schema.optionalWith(
    Schema.Struct({
      reviewId: Schema.String,
      outcome: Schema.Literal("allow", "deny", "escalate"),
      rationale: Schema.String,
    }),
    { exact: true },
  ),
  authentication: Schema.optionalWith(
    Schema.Struct({
      state: Schema.Literal("authenticated", "failed"),
      effect: Schema.Literal("possible", "verified"),
    }),
    { exact: true },
  ),
  executionId: Schema.String,
  status: Schema.Literal("completed", "failed", "unsupported", "needs_input"),
  effect: Schema.Literal("not_sent", "possible", "verified"),
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
  withheldConfirmation: Schema.optionalWith(Schema.Literal("message", "readback"), {
    exact: true,
  }),
  siteAccess: Schema.optionalWith(
    Schema.Union(
      Schema.Struct({
        code: Schema.Literal("site_bot_challenge"),
        evidence: Schema.Literal("screened_page_and_response_headers"),
      }),
      Schema.Struct({
        code: Schema.Literal("site_rate_limited"),
        evidence: Schema.Literal("response_headers"),
      }),
    ),
    { exact: true },
  ),
  terminalFailure: Schema.optionalWith(Schema.Literal("ChallengeFailure"), { exact: true }),
  noResponse: Schema.optionalWith(Schema.Struct({ possibleCommit: Schema.Boolean }), {
    exact: true,
  }),
  scriptQuestion: Schema.optionalWith(
    Schema.Union(
      Schema.Struct({
        requestId: Schema.String,
        outcome: Schema.Literal("reword", "authentication"),
        reviewId: Schema.optionalWith(Schema.String, { exact: true }),
        rationale: Schema.String,
      }),
      Schema.Struct({
        requestId: Schema.String,
        outcome: Schema.Literal("invalid", "unavailable"),
      }),
    ),
    { exact: true },
  ),
  preflight: Schema.optionalWith(Schema.Literal("rejected_before_claim"), { exact: true }),
  resultRef: Schema.optionalWith(Schema.String, { exact: true }),
  observations: Schema.Unknown,
  checks: Schema.optionalWith(
    Schema.Struct({
      passed: Schema.NonNegativeInt,
      failed: Schema.NonNegativeInt,
      skipped: Schema.NonNegativeInt,
      unsupported: Schema.NonNegativeInt,
      liveSiteTouched: Schema.Boolean,
    }),
    { exact: true },
  ),
});

export const PublicationRequest = Schema.Struct({
  entrypoint: Schema.String,
  executionId: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    /** Required only while the site's integration has no name yet; a later one is ignored. */
    siteName: Schema.optional(
      SiteNaming.fields.name.annotations({
        description: "The site's everyday name, as people say it, such as Example Flights",
      }),
    ),
    siteSummary: Schema.optional(
      SiteNaming.fields.summary.annotations({
        description: "One sentence on what the site is, not what this tool does",
      }),
    ),
    supportedVariants: Schema.optional(
      Schema.Array(SupportedOperationVariant).pipe(Schema.minItems(1), Schema.maxItems(32)),
    ),
  }),
  coverage: Schema.String,
  /**
   * Why no step can read a write's confirmation back, when the step named here read it but the
   * host did not accept its result. Only then does that step publish, with no output kept.
   */
  readBackUnavailable: Schema.optional(
    Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(500)).annotations({
      description:
        "Only for a write step whose result the host did not accept after it read the confirmation: why no act step can read that confirmation or the saved state back, such as the site showing neither again",
    }),
  ),
  /**
   * Site defaults the build took instead of asking: only non-credential, non-write, reversible
   * choices. The host keeps each one that passes privacy screening unchanged.
   */
  assumptions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
        choice: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
      }),
    ).pipe(Schema.maxItems(8)),
  ),
});
export type PublicationRequest = typeof PublicationRequest.Type;

/**
 * How the minter ends a build its task makes impossible as asked:
 * `site_lacks_capability`, the site does not offer what the task needs; `policy`, a Guardian or
 * owner constraint refuses it and nothing within authority gets past it. A target on another
 * registrable domain is never a reason by itself: Guardian reviews such work.
 */
export const blockedExplanationLimit = 500;
export const BuildBlocked = Schema.Struct({
  reason: Schema.Literal("site_lacks_capability", "policy"),
  explanation: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(blockedExplanationLimit)),
});
/**
 * A blocked build as recorded and shown: its reason, and its screened explanation only when
 * Guardian's question review allowed the caller to read it.
 */
const BuildBlockedOutcome = Schema.Struct({
  reason: BuildBlocked.fields.reason,
  explanation: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
});
type BuildBlockedOutcome = typeof BuildBlockedOutcome.Type;
/**
 * A build the intake capability screen refused before any work: it needs a
 * capability Pomerado does not have yet. Only the worker sets it; the minter cannot report it.
 * `explanation` is Pomerado's fixed sentence for the reason; `suggestion` is the screen's checked
 * suggestion, absent when it had none that passed.
 */
const NotSupportedYet = Schema.Struct({
  reason: Schema.Literal("not_supported_yet"),
  reason_code: IntakeReasonCode,
  explanation: BuildBlocked.fields.explanation,
  suggestion: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
});
/** A blocked build as its job records and shows it: the minter's ending or the intake refusal. */
export const JobBuildBlocked = Schema.Union(BuildBlockedOutcome, NotSupportedYet);
export type JobBuildBlocked = typeof JobBuildBlocked.Type;

/**
 * Infrastructure outcomes that end a build incomplete through no choice of the agent. Maintenance
 * requeues such a repair within bounds, except a final one; an agent's own conclusion never
 * carries one.
 */
const mintHostFailures = [
  "host_unavailable",
  "publication_unavailable",
  "review_unavailable",
  "capture_unavailable",
  "diagnostic_retention",
  "model_unavailable",
  "model_quota_exhausted",
  // A takeover that could not rejoin its job's resources within the recovery wait.
  "recovery_timeout",
  // A takeover that could not confirm how its predecessor's last step ended.
  "recovery_unconfirmed",
] as const;
type MintHostFailure = (typeof mintHostFailures)[number];

/** Guardian's finite reason for denying a publication, as a build's result carries it. */
export const PublicationDenial = Schema.Struct({
  reason: Schema.optionalWith(PublicationReason, { exact: true }),
  category: Schema.optionalWith(PublicationFinding.fields.category, { exact: true }),
});
export type PublicationDenial = typeof PublicationDenial.Type;

export type MintOutcome = {
  readonly rejectedCredential?: typeof CredentialRejectedField.Type;
  readonly capability_review?: CapabilityReview;
  readonly build: "published" | "incomplete";
  /** Set by the harness only when infrastructure, not the agent, ended the build. */
  readonly hostFailure?: MintHostFailure;
  /**
   * Set by the trusted worker or harness, never by model diagnostics. `sign_in_unavailable`: a
   * sign-in failed or was refused once no further sign-in could run in the attempt.
   */
  readonly recoveryReason?:
    | "reauthentication_required"
    | "login_identity_conflict"
    | "login_check_unavailable"
    | "sign_in_unavailable";
  /**
   * Set by the harness when the minter ended the build blocked: its task is impossible as asked,
   * for a typed reason, with the screened explanation when Guardian allowed its caller to read
   * it; or by the worker when the intake screen refused it as not supported yet. Not a failure.
   */
  readonly blocked?: JobBuildBlocked;
  /**
   * Set by the harness when the example's question went unanswered: the build ends as
   * `no_response`, saying whether a step may already have changed the site.
   */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * Set by the worker on an unpublished build one of whose live write steps committed or may
   * have, so its caller is told to check the website before trying again.
   */
  readonly possibleCommit?: true;
  readonly publicationRef?: string;
  readonly artifact?: MintArtifact;
  /**
   * Set by the harness when an unpublished build's last publication was a Guardian denial:
   * Guardian's finite reason and its first finding's category, never its rationale.
   */
  readonly publicationDenial?: PublicationDenial;
  /** Site defaults the build took instead of asking, as screened entries without private data. */
  readonly assumptions?: readonly BuildAssumption[];
  /** Host-only references: preserve first execution independently of build success. */
  readonly example?: ExecutionEvidence;
  readonly currentInvocation?: CurrentInvocation;
  readonly executions: readonly ExecutionEvidence[];
  readonly summary: string;
  readonly diagnostics: readonly string[];
};

/** One site default a build took instead of asking. */
export interface BuildAssumption {
  readonly kind: "site_default";
  readonly subject: string;
  readonly choice: string;
}

/**
 * What the agent may ask with request_input: typed questions of every kind but a login, which
 * only the host raises. The request's own checks (unique ids, bounds) run when the host asks it.
 * The caller may answer any choice in their own words, so the agent never decides it
 * (`withOwnWords`).
 */
export const AgentRequest = Schema.Struct({
  questions: Schema.Array(
    Schema.Union(
      ProposedChoiceQuestion,
      ProposedMultiChoiceQuestion,
      TextQuestion,
      ConfirmQuestion,
      SecretQuestion,
    ),
  ).pipe(Schema.minItems(1), Schema.maxItems(8)),
  notice: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384))),
  /**
   * Asks the owner to turn this read build into a write build: one choice question with the
   * options `read` and `write`, reviewed by Guardian first. A `write` answer switches the job to
   * write authority and write build rules in place.
   */
  writeUpgrade: Schema.optional(
    Schema.Literal(true).annotations({
      description:
        "Only on a read build whose requested task needs a website change a read may not make (filling in or advancing a form that saves data on the site, saving, submitting): ask the owner to make this a write build, as one choice question with the option ids read and write whose prompt says what would change. Guardian reviews it first; a write answer switches the build in place.",
    }),
  ),
});

/** What the agent asks: the request without the host's id and source. */
export type AgentInputRequest = Pick<InputRequest, "notice" | "questions">;

/**
 * A question as the host asks it for the minting agent: the caller may answer every choice and
 * multiple choice in their own words, with their own text instead of an option (or beside a
 * multiple choice's picks) or a note beside the options they pick, whatever the agent proposed.
 */
export const withOwnWords = <Q extends { readonly type: string }>(question: Q): Q =>
  question.type === "choice" || question.type === "multi_choice"
    ? { ...question, allowOther: true, allowNote: true }
    : question;

/**
 * One choice question whose only options are `read` and `write`, with no notice: the shape of
 * the effect question and of a write upgrade.
 */
export const isReadOrWriteChoice = (submitted: AgentInputRequest): boolean => {
  const [only] = submitted.questions;
  return (
    only?.type === "choice" &&
    submitted.questions.length === 1 &&
    submitted.notice === undefined &&
    only.options
      .map((option) => option.id)
      .sort()
      .join(",") === "read,write"
  );
};

export interface MintActions {
  readonly retainCapture?: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly readSource: (
    path: string,
    range?: { readonly offset?: number; readonly limit?: number },
  ) => Effect.Effect<string, MintFailure>;
  readonly execute: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly finish: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Asks the caller in place and returns their answers; the attempt continues. */
  readonly requestInput: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Ends the build blocked (`BuildBlocked`); absent on a question-only turn. */
  readonly reportBlocked?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Read-only CAPTCHA state for the host's current browser; absent when unsupported. */
  readonly captchaState?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** The agent's troubleshooting request for a new browser; absent where the host has none. */
  readonly requestBrowserRecovery?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Tests a signed-in marker; reports the check unavailable where the host has none. */
  readonly checkSignedInMarker?: (input: unknown) => Effect.Effect<string, MintFailure>;
}

/**
 * A host's descriptions of the optional tools it offers, such as which of its own skills to read
 * first. A tool the host describes gets that text instead of the generic description.
 */
export interface HostToolDescriptions {
  readonly captchaState?: string;
  readonly requestBrowserRecovery?: string;
  readonly checkSignedInMarker?: string;
}

export interface MintTurn {
  readonly recovery?: MintAgentRecovery;
  /** Attempt-scoped bridge for SDK Promise callbacks; closes and joins before returning an outcome. */
  readonly runTool: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly input: string;
  /** Host-enforced first turn of an unanswered Dashboard build: only request_input is offered. */
  readonly effectQuestion?: true;
  /** The site signs in by host autofill: `execute` offers `signInStep` on authenticate. */
  readonly autofillSignIn?: true;
  readonly deadline?: Deadline;
  readonly session: SandboxSession;
  /** The workspace AGENTS.md: the always-on context the model receives as its instructions. */
  readonly instructions: string;
  readonly skills: readonly SkillDescriptor[];
  readonly actions: MintActions;
  readonly hostToolDescriptions?: HostToolDescriptions;
  readonly screen: (value: unknown) => Effect.Effect<string, MintFailure>;
  readonly isComplete: () => boolean;
  readonly reportDiagnostic: (value: unknown) => Effect.Effect<void, MintFailure>;
  readonly reportTrace?: (
    value: unknown,
    timing?: ModelDiagnosticTiming,
  ) => Effect.Effect<void, MintFailure>;
  /** Required traced original model/tool record. Resolves only once its archive
   * reference is usable; failure must stop further provider or tool dispatch. */
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, MintFailure>;
  /** Finite lifecycle timing for telemetry. Never blocks or fails the model loop. */
  readonly observeTrace?: (timing: ModelDiagnosticTiming) => void;
  /**
   * Screened guidance for a final answer with no tool call while something the agent can get past
   * is unresolved, such as a failed sign-in, or undefined. The harness gives it once per failure,
   * so the loop returns it before the repeated-final guard can end the attempt. A sign-in the build cannot get past records its outcome here instead, which
   * `isComplete` then reports, so the loop ends without another prompt.
   */
  readonly unresolvedGuidance?: () => Effect.Effect<string | undefined, MintFailure>;
}

export interface MintModel {
  readonly run: (turn: MintTurn) => Effect.Effect<
    {
      readonly history: readonly AgentInputItem[];
      /** The model kept giving final answers with no tool call, so the loop stopped. */
      readonly stopReason?: "repeated_final_without_tool";
    },
    MintFailure
  >;
}

type MintExecutionAvailability = "open" | "host_unavailable";

/** Fixed keys with literal, boolean or numeric values only. */
export type FiniteDiagnostic = Readonly<Record<string, string | number | boolean>>;
/** Host-owned entry navigation state for a fresh attempt; never generated by the model. */
export type MintEntryNavigation =
  | {
      readonly state: "opened";
      readonly outcome: "ready" | "http_error";
      readonly requestedUrl: string;
      readonly resolvedUrl: string;
      readonly redirects: readonly { readonly url: string; readonly status: number | null }[];
      readonly status: number | null;
      /** Kernel's egress proxy, not the site, answered the entry at least once. A retry that
       * fails keeps the proxy response, so an unopened entry never carries this. */
      readonly egressProxy?: {
        readonly responder: string;
        readonly error: string;
        readonly retries: number;
        readonly outcome: "recovered" | "persisted" | "not_retried";
        readonly reason?: string;
        readonly retryInterrupted?: true;
        readonly notice: string;
      };
      readonly instruction?: string;
    }
  | {
      readonly state: "not_opened";
      readonly outcome: "failed" | "timeout" | "skipped";
      /** `prior_effect`: the host skipped the entry because an earlier attempt of this job already ran on the website. */
      readonly reason?: "prior_effect";
      readonly requestedUrl: string;
      readonly resolvedUrl?: string;
      readonly redirects?: readonly { readonly url: string; readonly status: number | null }[];
    }
  /**
   * The browser was replaced: by managed authentication (`sign_in`), where `page` is the page the
   * agent was on, when it was on the site and loaded, else the login page; or by a recovery
   * (`recovery`), where `page` is the page a read's replacement reopened: the last page the site
   * served the browser it replaced. A host may give its own reason and explain it in
   * `instruction`.
   */
  | {
      readonly state: "replaced";
      readonly reason: "sign_in" | "recovery" | (string & {});
      readonly requestedUrl?: string;
      readonly page?: string;
      /** Host-authored explanation of the browser replacement. */
      readonly instruction?: string;
    };

/** The durable journal of one logical example execution. */
export interface ExampleJournal {
  readonly record: (evidence: ExecutionEvidence) => Effect.Effect<void, MintFailure>;
  readonly stopped: Effect.Effect<void, MintFailure>;
}

export interface MintHarnessSnapshot {
  readonly executions: readonly ExecutionEvidence[];
  readonly purposes: readonly {
    readonly executionId: string;
    readonly purpose: ExecutionRequest["purpose"] | "command";
  }[];
  readonly diagnostics: readonly string[];
  readonly exampleId?: string;
  readonly exampleClaimed: boolean;
  readonly writeSession: "none" | "open" | "closed";
  readonly unavailableOutputRefusals: number;
  readonly terminal?: Pick<
    MintOutcome,
    | "build"
    | "publicationRef"
    | "artifact"
    | "assumptions"
    | "summary"
    | "recoveryReason"
    | "hostFailure"
    | "rejectedCredential"
  > & {
    /** Only the minter's blocked ending; the intake refusal ends a build before any harness. */
    readonly blocked?: BuildBlockedOutcome;
  };
  readonly noResponse?: { readonly possibleCommit: boolean };
  readonly unavailableCauseRecorded: boolean;
  readonly reviewUnavailableRetries: {
    readonly execution: number;
    readonly publication: number;
    readonly question: number;
  };
  /** When the current run of review outages began, in epoch milliseconds. */
  readonly reviewOutageStartedAt?: number;
  /**
   * The current review outage is a blocked explanation's, which `report_blocked` resubmits.
   * Optional, so an older worker ignores it and a newer one restores an older checkpoint.
   */
  readonly blockedReviewUnavailable?: true;
  readonly destinationEvidenceRefusals: number;
  readonly inputFeedbackRounds: number;
  readonly inputFeedbackPublicTool: boolean;
  readonly inputFeedbackCoverage: string;
  readonly providerUnavailableRetries: number;
  /** When the current run of execution-provider outages began, in epoch milliseconds. */
  readonly providerOutageStartedAt?: number;
  /**
   * Deprecated: nothing reads it. The harness always writes 0 only so an older worker, whose
   * schema requires it, can restore a newer checkpoint across a release. Remove it once no older
   * release runs.
   */
  readonly diagnosticRetentionRetries?: number;
  readonly executionClosed: boolean;
  readonly captchaChecks: number;
  /**
   * The owner kept this read build read-only when asked to make it a write. Optional beside the
   * fields every worker version reads, so a rollout's old and new workers each restore the
   * other's checkpoint; an older checkpoint has none.
   */
  readonly writeUpgradeDeclined?: true;
  /**
   * Sign-in is unavailable in this build and its outcome waits while a retained receipt may still
   * publish: the answer a later authenticate gets again, and that outcome. Optional, so a
   * rollout's old and new workers each restore the other's checkpoint.
   */
  readonly signInUnavailable?: {
    readonly answer: string;
    readonly outcome: NonNullable<MintHarnessSnapshot["terminal"]>;
  };
  /** The attempt's last publication was a Guardian denial; optional for the same reason. */
  readonly publicationDenial?: PublicationDenial;
  /**
   * The last completed publication review returned input feedback: its categories and screened
   * rationale, kept only for a build with no fallback, which ends with them. Optional for the
   * same reason.
   */
  readonly inputFeedbackReview?: InputFeedbackReview;
}

/** How a build ended, as a harness checkpoint keeps it. */
const HarnessTerminal = Schema.Struct({
  rejectedCredential: Schema.optionalWith(CredentialRejectedField, { exact: true }),
  build: Schema.Literal("published", "incomplete"),
  summary: Schema.String,
  publicationRef: Schema.optionalWith(Schema.String, { exact: true }),
  artifact: Schema.optionalWith(
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
      entrypoint: Schema.String,
      inputSchema: Schema.Unknown,
      outputSchema: Schema.Unknown,
    }),
    { exact: true },
  ),
  assumptions: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literal("site_default"),
        subject: Schema.String,
        choice: Schema.String,
      }),
    ),
    { exact: true },
  ),
  recoveryReason: Schema.optionalWith(
    Schema.Literal(
      "reauthentication_required",
      "login_identity_conflict",
      "login_check_unavailable",
      "sign_in_unavailable",
    ),
    { exact: true },
  ),
  hostFailure: Schema.optionalWith(Schema.Literal(...mintHostFailures), { exact: true }),
  // Optional, and dropped as an excess field by an older worker's decode, so a rollout's old and
  // new workers each restore the other's checkpoint.
  blocked: Schema.optionalWith(BuildBlockedOutcome, { exact: true }),
});

export const MintHarnessSnapshot: Schema.Schema<MintHarnessSnapshot> = Schema.Struct({
  executions: Schema.Array(ExecutionEvidence),
  purposes: Schema.Array(
    Schema.Struct({
      executionId: Schema.String,
      purpose: Schema.Union(ExecutionRequest.fields.purpose, Schema.Literal("command")),
    }),
  ),
  diagnostics: Schema.Array(Schema.String),
  exampleId: Schema.optionalWith(Schema.String, { exact: true }),
  exampleClaimed: Schema.Boolean,
  writeSession: Schema.Literal("none", "open", "closed"),
  unavailableOutputRefusals: Schema.NonNegativeInt,
  terminal: Schema.optionalWith(HarnessTerminal, { exact: true }),
  noResponse: Schema.optionalWith(Schema.Struct({ possibleCommit: Schema.Boolean }), {
    exact: true,
  }),
  unavailableCauseRecorded: Schema.Boolean,
  reviewUnavailableRetries: Schema.Struct({
    execution: Schema.NonNegativeInt,
    publication: Schema.NonNegativeInt,
    question: Schema.NonNegativeInt,
  }),
  reviewOutageStartedAt: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  blockedReviewUnavailable: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  destinationEvidenceRefusals: Schema.NonNegativeInt,
  inputFeedbackRounds: Schema.NonNegativeInt,
  inputFeedbackPublicTool: Schema.Boolean,
  inputFeedbackCoverage: Schema.String,
  providerUnavailableRetries: Schema.NonNegativeInt,
  providerOutageStartedAt: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  // Deprecated, written as 0 for older workers and ignored on read; see the interface.
  diagnosticRetentionRetries: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  executionClosed: Schema.Boolean,
  captchaChecks: Schema.NonNegativeInt,
  writeUpgradeDeclined: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  signInUnavailable: Schema.optionalWith(
    Schema.Struct({ answer: Schema.String, outcome: HarnessTerminal }),
    { exact: true },
  ),
  publicationDenial: Schema.optionalWith(PublicationDenial, { exact: true }),
  inputFeedbackReview: Schema.optionalWith(
    Schema.Struct({
      categories: Schema.Array(PublicationFinding.fields.category),
      rationale: Schema.String,
    }),
    { exact: true },
  ),
});

/**
 * How the minter can go on after a publication decision:
 * - `none`: it published.
 * - `retry`: a publication dependency stayed unavailable; call `finish_build` again.
 * - `correct_source`: fix the source, contract or metadata, then call again without running the
 *   write or example again.
 * - `new_observation`: run a read or a live test first, never a completed write again.
 * - `guardian_feedback`: act on Guardian's rationale and findings.
 * - `write_completion`: the requested write was not demonstrated; continue the remaining
 *   authorized work or ask about revising incompatible inputs.
 * - `ended`: the decision ended the build.
 */
export type PublicationRecovery =
  | "none"
  | "retry"
  | "correct_source"
  | "new_observation"
  | "guardian_feedback"
  | "write_completion"
  | "ended";

/**
 * One publication decision, a refusal or a publication, as typed host evidence. The harness
 * writes it, never the agent, so a review reads what the host decided instead of the agent's
 * account of it. Every field is finite host metadata: no source, output or rationale text.
 */
export interface PublicationDecision {
  /** The harness's reference for this decision, unique in the build; tool results carry it. */
  readonly decisionId: string;
  readonly outcome: "published" | "refused";
  /** `Published`, or the refusal's `MintFailure` code. */
  readonly code: MintFailure["code"] | "Published";
  /**
   * The refusal's finite reason: a `MintFailure` reason such as `write_not_submitted`, Guardian's
   * publication reason, or one of the harness's own, such as `missing_receipt`.
   */
  readonly reason?: string;
  /** The retained execution the publication named, when the build holds it. */
  readonly executionId?: string;
  /** The Guardian publication review that decided it, when one did. */
  readonly reviewId?: string;
  /** When the harness decided, in epoch milliseconds. */
  readonly decidedAt: number;
  /**
   * The finite checks that refused it: the reason, a registry issue, the publication gate's check,
   * a route evidence gap and Guardian's finding categories. Empty for a publication.
   */
  readonly failedChecks: readonly string[];
  readonly recovery: PublicationRecovery;
}

/**
 * Where a host keeps publication decisions as indexed evidence. The harness records each decision
 * as it makes it, and lists them for the reviews of a blocked explanation and of a question.
 */
export interface PublicationDecisionLog {
  /** Keeps one decision, indexed by `decisionId`. A failure is a recorded gap; the build goes on. */
  readonly record: (decision: PublicationDecision) => Effect.Effect<void, MintFailure>;
  /** This build's decisions so far, oldest first, a takeover's predecessor's included. */
  readonly list: Effect.Effect<readonly PublicationDecision[], MintFailure>;
}

export interface MintDependencies {
  readonly agentRecovery?: {
    readonly initial?: { readonly agent: MintAgentSnapshot; readonly harness: MintHarnessSnapshot };
    readonly bindHarness?: (capture: () => MintHarnessSnapshot) => Effect.Effect<void, MintFailure>;
    readonly recoverTool?: (call: RecoveryToolCall) => Effect.Effect<
      | {
          readonly execution?: {
            readonly purpose: ExecutionRequest["purpose"] | "command";
            readonly evidence: ExecutionEvidence;
          };
          readonly publication?: {
            readonly published: PublishedBuild;
            readonly coverage: string;
            readonly assumptions?: PublicationRequest["assumptions"];
          };
          readonly input?: { readonly request: AgentInputRequest; readonly answers: ValidAnswers };
          readonly result?: unknown;
        }
      | undefined,
      MintFailure
    >;
    readonly save: (
      agent: MintAgentSnapshot,
      harness: MintHarnessSnapshot,
    ) => Effect.Effect<void, MintFailure>;
  };
  /** Attempt-local lifecycle capacity, never execution authority. */
  readonly executionAvailability?: () => MintExecutionAvailability;
  /** Trusted worker fence after this exact attempt's lease is lost; never model input. */
  readonly attemptRevoked?: () => boolean;
  /**
   * Why the host first stopped offering live work, a finite cause such as
   * `browser_loss_unrecoverable`; undefined while it still offers it.
   */
  readonly hostUnavailableCause?: () => string | undefined;
  /** Finite host records, oldest first, behind a host_unavailable stop that no tool call observed. */
  readonly unavailableHostCause?: () =>
    | {
        readonly reason?: NonNullable<DestinationReason> | PolicyFailureReason;
        readonly diagnostics: readonly FiniteDiagnostic[];
      }
    | undefined;
  /**
   * Fresh-attempt entry page state for the request context, not the agent
   * instructions. Absent without an entry URL or after possible effects.
   */
  readonly entryNavigation?: () => MintEntryNavigation | undefined;
  /**
   * Screened host incidents queued before the first tool call (the entry window). Draining
   * hands them to the first model request instead of the first tool result.
   */
  readonly drainStartIncidents?: () => Effect.Effect<object | undefined>;
  /**
   * Host-authored notices about browser state that changed after a tool call returned, such as a
   * challenge Kernel's solver cleared. Draining hands them to the next tool result.
   */
  readonly drainHostNotices?: () => readonly object[] | undefined;
  /** Suspected Pomerado bugs this attempt continued past: a count and the first eight. */
  readonly hostAnomalies?: () => HostAnomalySummary;
  /** Records how the attempt ended, once, for its closed anomaly record. */
  readonly attemptFinished?: (outcome: MintAttemptOutcome) => Effect.Effect<void>;
  /** Host-enforced intake question; no execution or publication tool is available this turn. */
  readonly capabilityQuestion?: string;
  /** Host-resolved availability only. Credentials never enter the model request. */
  readonly websiteCredentialsAvailable?: boolean;
  /** See `MintTurn.autofillSignIn`. */
  readonly autofillSignIn?: true;
  /**
   * Proposed screened request only; missing reviewer fails closed. Never receives an answer.
   * `requestId` is the id the request is asked under if allowed, so its lifecycle events join.
   */
  readonly reviewQuestion?: (
    request: AgentInputRequest,
    options?: {
      readonly writeUpgrade?: true;
      /** The agent's `report_blocked` explanation, reviewed before its caller reads it. */
      readonly blockedOutcome?: true;
      readonly requestId?: string;
      /**
       * The build's latest publication refusals, from `publicationDecisions`, so the review reads
       * what the host refused instead of the agent's account of it. Absent when there are none.
       */
      readonly publicationDecisions?: readonly PublicationDecision[];
    },
  ) => Effect.Effect<QuestionDecision & { readonly reviewId?: string }, MintFailure>;
  /**
   * Asks the caller in place (source `agent`) while the attempt keeps its browser and lease.
   * A `secret` answer's value is the host's handle (`{{secret.sN}}`), never the secret: the host
   * fills it into a live execution's source after review. An unanswered request fails with
   * `noResponse`. `reviewId` names the Guardian review that allowed it and `requestId` the id it
   * was reviewed under (a fresh one when absent), for its lifecycle events.
   */
  readonly askInput?: (
    request: AgentInputRequest,
    ids?: { readonly reviewId?: string; readonly requestId?: string },
  ) => Effect.Effect<ValidAnswers, MintFailure>;
  /**
   * Removes host-private values, such as the build's account reference, from text the agent
   * writes for its caller: each request's notice, prompts and option labels, and its blocked
   * explanation. Applied before review; the agent's own transcript keeps what it wrote. Absent,
   * the text is shown as written.
   */
  readonly redactCallerText?: (text: string) => string;
  /**
   * Raises the system login request Guardian routed a question to. `held` means the host already
   * has a login; `unavailable` means this job may not ask for one. The model never sees values.
   */
  readonly requestLogin?: () => Effect.Effect<
    "supplied" | "held" | "unavailable" | "in_use" | "inspect",
    MintFailure
  >;
  /** Records the owner's answer to the effect question on the build, once. */
  readonly recordBuildEffect?: (effect: "read" | "write") => Effect.Effect<void, MintFailure>;
  /**
   * Switches this read build to a write build after its owner approved `change`, the reviewed
   * question prompt, and records the build's effect as `write` on the job. From then on every
   * execution is reviewed under write authority and the write build rules.
   */
  readonly upgradeToWrite?: (change: string) => Effect.Effect<void, MintFailure>;
  /** Receives the owner's answer to the host's capability question. */
  readonly capabilityAnswered?: (answer: string) => Effect.Effect<void, MintFailure>;
  readonly diagnostics?: MintDiagnostics;
  readonly reporting?: MintReporting;
  /** The hosted job and attempt, for failure reports; absent outside a hosted job. */
  readonly reportCorrelation?: { readonly jobId: string; readonly attemptId: string };
  readonly deadline?: Deadline;
  /** How long reviews may stay unavailable before the attempt ends; 15 minutes by default. */
  readonly reviewOutageBudgetMs?: number;
  readonly exampleClaimed?: boolean;
  /** Host-bound accepted/registered read authority; source still requires Guardian approval. */
  readonly repeatableRead?: boolean;
  /** Trusted registered invocation receipt, loaded from its durable recovery record. */
  readonly initialExample?: ExecutionEvidence;
  readonly priorReadExecutions?: readonly ExecutionEvidence[];
  /** Host-owned state, independent of model prose and publication. */
  readonly currentInvocation?: () => CurrentInvocation | undefined;
  readonly canPublishRepair?: (executionId: string) => boolean;
  /** Host-created SDK workspace, no credentials, no external grants. Host owns cleanup. */
  readonly workspace: SandboxSession;
  /** Same-attempt artifacts already screened and published by the host collector.
   * Generated source cannot populate this read-only view. */
  readonly readPublishedCapture?: (path: string) => Effect.Effect<string | undefined, MintFailure>;
  /**
   * The host's transient token view, masked for explicit secrets only. Its cookie, CSRF and
   * authorization values are its content, so the model's source screen must not withhold them.
   */
  readonly readSessionTokens?: (path: string) => string | undefined;
  /** Host-selected original attempt evidence. Content is fetched only for a requested indexed path. */
  readonly readRetainedCapture?: (path: string) => Effect.Effect<string | undefined>;
  /** Host-only selection/retrieval; never refetches a historical website response. */
  readonly retainCapture?: (request: CaptureRequest) => Effect.Effect<string, MintFailure>;
  /** Host-bound, read-only CAPTCHA state for the current live browser. Never dispatches a
   * browser action, triggers a solve or extends a deadline. Absent when the host has no CAPTCHA
   * telemetry; then the minter tool is not offered. */
  readonly captchaState?: {
    readonly read: () => Effect.Effect<object, MintFailure>;
    readonly limit: number;
    readonly exhausted: object;
  };
  /**
   * The minting agent's troubleshooting request for a new browser, with its reason.
   * Guardian reviews the reason; on allow the host's recovery policy replaces the live browser.
   * It runs no code, repeats nothing and is never part of the published operation.
   */
  readonly requestBrowserRecovery?: (
    rationale: string,
  ) => Effect.Effect<MintBrowserRecoveryResult, MintFailure>;
  /**
   * Tests a signed-in marker before the agent sends it with `authenticate`: whether the
   * signed-out snapshot the host saved before the sign-in sent anything shows it
   * (`evaluateSignedInMarker` matches it), whether the live page shows it now, after the host
   * loads `openPath` (or the site's origin) again, and on another page the agent visited signed
   * in. It never signs in or sends a value. Absent, the tool reports the check unavailable.
   */
  readonly checkSignedInMarker?: (
    marker: SignedInMarkerCheckRequest,
  ) => Effect.Effect<SignedInMarkerCheck, MintFailure>;
  /** The host's own descriptions of its optional tools, in place of the generic ones. */
  readonly hostToolDescriptions?: HostToolDescriptions;
  readonly projection: MintProjection;
  /** The workspace AGENTS.md, installed at the workspace root and given as the instructions. */
  readonly instructions: string;
  readonly skills: readonly SkillDescriptor[];
  readonly model: MintModel;
  /** Validate available host facilities before reserving the one-use example claim. No execution. */
  readonly preflight: (
    request: ExecutionRequest,
  ) => Effect.Effect<
    { readonly supported: true } | { readonly supported: false; readonly reason: string },
    MintFailure
  >;
  /** Each call MUST perform fresh Guardian review, await beforeDispatch after approval,
   * and only then allocate execution resources/import authored code. Never swallow a
   * failed dispatch fence or invoke it before the initial review succeeds. */
  readonly reviewAndExecute: (
    request:
      | ExecutionRequest
      | {
          readonly purpose: "command";
          readonly target: "pureFiles";
          readonly command: string;
        },
    beforeDispatch?: Effect.Effect<void, MintFailure>,
    exampleJournal?: ExampleJournal,
  ) => Effect.Effect<ExecutionEvidence, MintFailure>;
  /** Persist before example/residual dispatch. Host binds input/account/authority, never tool args. */
  readonly claimExample: Effect.Effect<void, MintFailure>;
  readonly authorizeResidual: Effect.Effect<void, MintFailure>;
  /** Review current source and validate/screen public definition before atomic registry publication. */
  readonly publish: (
    request: PublicationRequest,
    evidence: ExecutionEvidence,
  ) => Effect.Effect<MintCompletion, MintFailure>;
  /** Absent when this host never publishes past unresolved input feedback. */
  readonly inputFeedbackFallback?: InputFeedbackFallback;
  /** Host evidence of each publication decision; absent, reviews get none. */
  readonly publicationDecisions?: PublicationDecisionLog;
}

/** What a browser recovery request did, as the agent reads it. */
export type MintBrowserRecoveryResult =
  | {
      /**
       * No replacement is possible now, and Guardian was not asked: no live browser, the
       * attempt's proxies and modes are spent, the policy pins a signed-in browser's egress, or
       * the latest evidence keeps the browser.
       */
      readonly outcome: "unavailable";
      readonly reason:
        | "no_browser"
        | "no_proxy_left"
        | "egress_pinned"
        | "site_refused"
        | "proxy_rate_limited"
        | "retained";
      readonly notice: string;
    }
  | {
      readonly outcome: "denied";
      readonly notice: string;
      readonly review: {
        readonly outcome: "deny" | "escalate";
        readonly reviewId: string;
        readonly rationale: string;
      };
    }
  | {
      /** `lost`: the switch failed part way, and the old browser and its page are gone. */
      readonly outcome: "replaced" | "kept" | "lost";
      readonly notice: string;
      readonly reviewId: string;
      readonly browserRecovery?: BrowserRecoverySummary;
    };

export const PublicationDiagnosticGap = Schema.Union(
  Schema.Struct({
    phase: Schema.Literal("publication_capture"),
    state: Schema.Literal("withheld"),
    reason: Schema.Literal(
      "screening_failed",
      "storage_failed",
      "capacity_exhausted",
      "byte_limit",
      "capture_unavailable",
    ),
    screening: Schema.optional(CaptureScreeningDiagnostic),
  }),
  Schema.Struct({
    phase: Schema.Literal("publication_capture"),
    state: Schema.Literal("pending"),
    reason: Schema.Literal("background_processing"),
  }),
);
export type PublicationDiagnosticGap = typeof PublicationDiagnosticGap.Type;

export class MintServices extends Context.Tag("@pomerado/MintServices")<
  MintServices,
  MintDependencies
>() {}
