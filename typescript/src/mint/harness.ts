import type { MintReportContext } from "./diagnostics.js";
import type { RunnerResultDefect } from "../execution/boundary.js";
import { destinationPrivateCandidateMetadata } from "../destinations/private-candidate.js";
import { policyFailureMetadata } from "../runtime/policy-metadata.js";
import {
  failureDetail,
  failureDetailMetadata,
  failureRootCause,
} from "../runtime/failure-detail.js";
import {
  signInAnswer,
  signInFailureFeedback,
  signInFeedbackOf,
  signInRootCode,
  signInUnavailableSummary,
  unresolvedSignInGuidance,
} from "./sign-in-failure.js";
import type { SignInDiagnostic } from "../execution/sign-in-diagnostics.js";
import { authorityCheckMetadata } from "../auth/authority-metadata.js";
import {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../models/model-diagnostic-failure.js";
import { randomUUID } from "node:crypto";
import { Cause, Clock, Effect, Exit, FiberSet, Option, Schema, Scope } from "effect";
import {
  AgentRequest,
  blockedExplanationLimit,
  BuildBlocked,
  CaptureRequest,
  ExecutionRequest,
  isReadOrWriteChoice,
  MintFailure,
  MintRequest,
  MintServices,
  PublicationRequest,
} from "./contracts.js";
import { finiteCaptureGap, finiteRunnerFailure } from "./runner-failure.js";
import { isSecretHandle } from "./secret-handles.js";
import type {
  AgentInputRequest,
  BuildAssumption,
  ExecutionEvidence,
  MintActions,
  MintOutcome,
  MintHarnessSnapshot,
  SpentSignIn,
} from "./contracts.js";
import type { ValidAnswers } from "../runtime/input-request.js";
import type { RecoveryToolCall } from "./recovery-contracts.js";
import type { SiteAccessDiagnostic } from "./site-access-contracts.js";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import { registryRefusal } from "./registry-feedback.js";
import { publicationBlockFeedback } from "./publication-block.js";
import {
  inputFeedbackInstruction,
  maximumInputFeedbackRounds,
  unresolvedInputFeedbackSummary,
} from "./input-feedback.js";
import type { MintCompletion } from "./input-feedback.js";
import {
  makeMintWorkspace,
  questionOnlyWorkspace,
  relativeSourcePath,
  screenMintText,
} from "./workspace.js";

const effectQuestionInstruction =
  "Before any website access, ask the person whether this build only looks things up or changes something on the website. Call request_input once with exactly one choice question whose options have the ids read and write: the prompt says in one or two plain sentences what the finished tool would do, and your best guess comes first; filling in or advancing a form that saves data on the site (an application, profile or checkout form) counts as a change, while searching or filtering does not. A write build does the requested task once, for real, with the person's values, while it builds (it may take several steps), and ends by reading the site's confirmation. No other tool is available until the person answers.";

/**
 * What the agent of a new attempt of a write build is told when an earlier attempt may have
 * changed the website (`priorAttemptMayHaveChanged`). It reads back before it writes again.
 */
const priorAttemptChangeNotice =
  "An earlier attempt of this build ended before it finished, after steps that may have changed the website, and this attempt starts over: a new workspace and a fresh browser on a new, empty profile, signed out, with none of that attempt's records. Before you run a write, read back on the site whether the requested change already happened; never redo one that did, and if it did, end the attempt and say so in the summary.";

/**
 * The host's own labels for the two answers of a read/write choice (the effect question and a
 * write upgrade). The agent writes the prompt, which Guardian reviews, but never what an answer
 * says, so a label cannot present `write` as keeping the build read-only.
 */
const effectAnswerLabels: Readonly<Record<string, string>> = {
  read: "Keep it read-only: only look things up",
  write: "Make it a write build: let it change the website",
};
const withEffectAnswerLabels = <
  Q extends { readonly type: string; readonly options?: readonly { readonly id: string }[] },
>(
  questions: readonly Q[],
): Q[] =>
  questions.map((question) =>
    question.type !== "choice" || question.options === undefined
      ? question
      : {
          ...question,
          options: question.options.map((option) => {
            const label = effectAnswerLabels[option.id];
            return label === undefined ? option : { id: option.id, label };
          }),
        },
  );

/**
 * A saved login another of the account's jobs holds, still held after the host waited for it in
 * place: nothing was sent, no sign-in was spent, and the login itself is fine. Never a credentials
 * problem.
 */
const loginInUseAnswer = {
  code: "login_in_use",
  fields: {
    signInOutcome: "signed_out",
    nextStep: "authenticate",
    credentialSent: false,
    countsTowardSignInCap: false,
  },
  notice:
    "The host started no sign-in: the saved login is in use by another of the account's jobs, which holds it until that job ends, and it was still in use after the host waited for it. This is not a credentials problem: nothing was sent, this does not count toward the attempt's sign-in limit, and no other login is needed, so do not ask the caller for one. Work that needs no sign-in may go on; call execute purpose authenticate again later, and the host binds the same login once it is free.",
} as const;

/** A failed or refused sign-in's answer, or a held login's; undefined for any other failure. */
const signInOrLoginInUseAnswer = (
  error: MintFailure,
  feedback: ReturnType<typeof signInFeedbackOf>,
  ending: Parameters<typeof signInAnswer>[2],
) =>
  feedback !== undefined
    ? signInAnswer(error, feedback, ending)
    : error.reason === "login_in_use"
      ? loginInUseAnswer
      : undefined;

/** A `request_input` call whose arguments ask for a write upgrade. */
const isWriteUpgradeCall = (call: RecoveryToolCall): boolean =>
  call.name === "request_input" &&
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.parseJson(Schema.Struct({ writeUpgrade: Schema.Literal(true) })),
    )(call.arguments),
  );

type AgentQuestion = (typeof AgentRequest.Type)["questions"][number];
/** The agent's question as its caller reads it, with each caller-visible text redacted. */
const callerVisibleQuestion = (
  question: AgentQuestion,
  redact: (text: string) => string,
): AgentQuestion => {
  const prompt = redact(question.prompt);
  if (question.type === "choice" || question.type === "multi_choice")
    return {
      ...question,
      prompt,
      options: question.options.map((option) => ({
        ...option,
        label: redact(option.label),
        ...(option.maskedLabel === undefined ? {} : { maskedLabel: redact(option.maskedLabel) }),
      })),
    };
  if (question.type === "confirm" && question.followUp !== undefined) {
    const { defaultText } = question.followUp;
    return {
      ...question,
      prompt,
      followUp: {
        prompt: redact(question.followUp.prompt),
        // The caller's form shows it as the field's default.
        ...(defaultText === undefined ? {} : { defaultText: redact(defaultText) }),
      },
    };
  }
  return { ...question, prompt };
};
/** The agent's request as its caller reads it: its notice and every question. */
const callerVisibleRequest = <R extends typeof AgentRequest.Type>(
  request: R,
  redact: (text: string) => string,
): R => ({
  ...request,
  ...(request.notice === undefined ? {} : { notice: redact(request.notice) }),
  questions: request.questions.map((question) => callerVisibleQuestion(question, redact)),
});

/** How the minter removes an account reference from the named part of a tool's definition. */
const definitionFix = (section: string | undefined) =>
  section === "loginUrl"
    ? "Run authenticate again with the site's plain sign-in page as loginUrl, then call finish_build again with the same executionId."
    : section === "name" || section === "description" || section === "supportedVariants"
      ? `Rewrite the ${section} in finish_build's metadata without it and call finish_build again with the same executionId.`
      : section === "site"
        ? "Rewrite siteName and siteSummary in finish_build's metadata without it and call finish_build again with the same executionId."
        : section === "inputSchema" || section === "outputSchema" || section === "questions"
          ? "Edit the operation's schemas and questions in its source without it, then call finish_build again with the same executionId."
          : "Remove it from the metadata, the operation's schemas and questions, and the login URL, then call finish_build again with the same executionId.";

/** The owner's answer to a write upgrade's one question, and that question's prompt. */
const writeUpgradeChoice = (submitted: AgentInputRequest, answers: ValidAnswers) => {
  const [only] = submitted.questions;
  return { choice: answers[only?.id ?? ""]?.value, change: only?.prompt ?? "" };
};

/**
 * An answer as the model receives it: the value alone, keyed by question id. A `secret` answer is
 * the host's handle; anything else in its place could be the secret itself, so nothing is returned.
 */
const answersForModel = (answers: ValidAnswers) =>
  Object.values(answers).some((answer) => answer.type === "secret" && !isSecretHandle(answer.value))
    ? Effect.fail(
        new MintFailure({
          code: "Unavailable",
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "askInput",
            context: { check: "secret_answer_without_handle" },
          }),
        }),
      )
    : Effect.succeed(
        Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.value])),
      );
/**
 * What an execution whose runner left no readable result means for the agent: an execution-host
 * fault. It says nothing about the website, the browser or its egress, so it is no reason to
 * change browser mode or proxy.
 */
const runnerResultNotice = (runner: RunnerResultDefect) =>
  `The operation runner ended without a readable result (execution.runnerResult.cause: ${runner.cause}${runner.signal === undefined ? `, exit status ${runner.exitCode}` : `, ended by ${runner.signal}`}). This is an execution-host fault, not evidence about the website, the browser or its proxy; stderr, when present, is the runner's own account. The execution may have run, so its effect is possible. `;

const Count = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
/** Fresh verified examples allowed per attempt after publication finds an unreadable output. */
const maximumUnavailableOutputReruns = 2;
const VisibleReceipt = Schema.Struct({
  authentication: Schema.optional(
    Schema.Struct({
      state: Schema.Literal("authenticated", "failed"),
      effect: Schema.Literal("possible", "verified"),
    }),
  ),
  executionId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,200}$/)),
  status: Schema.Literal("completed", "failed", "unsupported", "needs_input"),
  effect: Schema.Literal("not_sent", "possible", "verified"),
  confirmation: Schema.optional(Schema.Literal("message", "readback")),
  preflight: Schema.optional(Schema.Literal("rejected_before_claim")),
  checks: Schema.optional(
    Schema.Struct({
      passed: Count,
      failed: Count,
      skipped: Count,
      unsupported: Count,
      liveSiteTouched: Schema.Boolean,
    }),
  ),
});

/**
 * Adds the host's pending notices (browser state that changed after an earlier call returned) to
 * a JSON tool result, so the agent hears them on its next host tool call of any kind. A result that
 * is not a JSON object, such as a source read, or a failed call keeps them for the next one.
 */
const decodeJsonObject = Schema.decodeUnknownEither(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

const withHostNotices = (
  actions: MintActions,
  drain: (() => readonly object[] | undefined) | undefined,
): MintActions => {
  if (drain === undefined) return actions;
  const attach = (result: string): string => {
    // A result that is not a JSON object, such as a source read, keeps its notices for the next.
    const parsed = decodeJsonObject(result);
    if (parsed._tag === "Left") return result;
    const notices = drain();
    if (notices === undefined) return result;
    return JSON.stringify({ ...parsed.right, hostNotices: notices });
  };
  const wrap =
    <A extends readonly unknown[]>(action: (...args: A) => Effect.Effect<string, MintFailure>) =>
    (...args: A) =>
      action(...args).pipe(Effect.map(attach));
  return {
    ...actions,
    ...(actions.retainCapture === undefined ? {} : { retainCapture: wrap(actions.retainCapture) }),
    execute: wrap(actions.execute),
    finish: wrap(actions.finish),
    requestInput: wrap(actions.requestInput),
    ...(actions.reportBlocked === undefined ? {} : { reportBlocked: wrap(actions.reportBlocked) }),
    ...(actions.captchaState === undefined ? {} : { captchaState: wrap(actions.captchaState) }),
    ...(actions.requestBrowserRecovery === undefined
      ? {}
      : { requestBrowserRecovery: wrap(actions.requestBrowserRecovery) }),
  };
};

/** The paths an input schema rejected, as a sentence, or nothing when the host has none. */
const inputIssueText = (issues: MintFailure["inputIssues"]) =>
  issues === undefined || issues.length === 0
    ? ""
    : ` It rejected ${issues
        .map(
          ({ path, issue }) =>
            `${path === "" ? "the input itself" : JSON.stringify(path)} (${issue})`,
        )
        .join(", ")}.`;

/** What the agent does about a question its script asked that reached nobody. */
const scriptQuestionInstruction: Readonly<
  Record<NonNullable<ExecutionEvidence["scriptQuestion"]>["outcome"], string>
> = {
  reword:
    "Guardian did not allow the question this script asked, so nobody was asked and the script's ask failed. Revise the script's declared question using the rationale, then execute again; the revised question is reviewed again. Do not ask for a value you were already given or that the site shows: read a value the caller's input or the request gives from the tool's input (when the caller's input is empty, pass it in exampleInput on the example, or on the write session's first act step), and use the {{secret.<id>}} handle of a protected answer you already hold.",
  authentication:
    "The script's question asks for a website login, which only the host requests, so nobody was asked. Remove it from the script's questions and sign in with execute purpose authenticate instead.",
  invalid:
    "The host could not accept the script's question as asked, so nobody was asked. Check its declaration and options, then execute again.",
  unavailable:
    "The host could not review or deliver the script's question, so nobody was asked; nothing is wrong with the question. You may execute again once; if it fails the same way, end the attempt and say the question could not be asked.",
};

const siteAccessDiagnostic = (evidence: ExecutionEvidence): SiteAccessDiagnostic | undefined => {
  try {
    if (evidence.status !== "failed") return undefined;
    const candidate: unknown = evidence.siteAccess;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return undefined;
    const code: unknown = Reflect.get(candidate, "code");
    const basis: unknown = Reflect.get(candidate, "evidence");
    if (code === "site_bot_challenge" && basis === "screened_page_and_response_headers")
      return { code, evidence: basis };
    if (code === "site_rate_limited" && basis === "response_headers")
      return { code, evidence: basis };
  } catch {
    // Optional model-visible provenance cannot replace the primary execution receipt.
  }
  return undefined;
};

/** Copy known receipt fields without invoking an optional hostile accessor. */
const safeExecutionEvidence = (evidence: ExecutionEvidence): ExecutionEvidence => {
  const siteAccess = siteAccessDiagnostic(evidence);
  return {
    executionId: evidence.executionId,
    status: evidence.status,
    effect: evidence.effect,
    observations: evidence.observations,
    ...(evidence.review === undefined ? {} : { review: evidence.review }),
    ...(evidence.authentication === undefined ? {} : { authentication: evidence.authentication }),
    ...(evidence.terminalFailure === undefined
      ? {}
      : { terminalFailure: evidence.terminalFailure }),
    ...(evidence.noResponse === undefined ? {} : { noResponse: evidence.noResponse }),
    ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
    ...(evidence.resultRef === undefined ? {} : { resultRef: evidence.resultRef }),
    ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
    ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
    ...(siteAccess === undefined ? {} : { siteAccess }),
  };
};

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) =>
        new MintFailure({
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "Schema.decodeUnknown",
            error,
          }),
          code: "InvalidRequest",
        }),
    ),
  );

const diagnosticUnavailable = (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    diagnosticRetentionReason: diagnosticRetentionReason(error),
    diagnosticStorageFailure: diagnosticStorageFailure(error),
  });

type JsonTypeTree =
  | { readonly type: "null" | "string" | "number" | "boolean" }
  | { readonly type: "object"; readonly fields: Record<string, JsonTypeTree> }
  | { readonly type: "array"; readonly elementTypes: JsonTypeTree[] };

const jsonTypeTree = (value: unknown): JsonTypeTree => {
  const visit = (current: unknown): JsonTypeTree => {
    if (current === null) return { type: "null" };
    if (typeof current === "string") return { type: "string" };
    if (typeof current === "boolean") return { type: "boolean" };
    if (typeof current === "number" && Number.isFinite(current)) return { type: "number" };
    if (Array.isArray(current)) {
      const elements = new Map<string, JsonTypeTree>();
      for (const value of current) {
        const tree = visit(value);
        elements.set(JSON.stringify(tree), tree);
      }
      return {
        type: "array",
        elementTypes: [...elements]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, tree]) => tree),
      };
    }
    if (typeof current !== "object") throw new Error("Invalid JSON input");
    const fields: Record<string, JsonTypeTree> = {};
    for (const key of Object.keys(current).sort())
      Object.defineProperty(fields, key, {
        value: visit(Reflect.get(current, key)),
        enumerable: true,
        configurable: true,
      });
    return { type: "object", fields };
  };
  return visit(value);
};

const loginRequestInstruction = (login: "held" | "supplied" | "inspect" | "unavailable") =>
  login === "inspect"
    ? "Inspect the website's current sign-in screen, then call execute purpose authenticate with target liveBrowser and signInStep describing its observed fields. The host asks privately for only the missing fields after verifying them. Never ask for credentials yourself."
    : login === "unavailable"
      ? "This asks for a website login, which only the host requests, and this build cannot be given one. Do not ask for it again; continue without it or end the attempt and say why."
      : "This asks for a website login, which only the host requests. The host now holds a login for this site: call execute purpose authenticate with target liveBrowser. Never ask for passwords, usernames or logins yourself.";

/** One coding flow. Durable dispatch claims, leases, authority and cleanup belong to the host. */
export const runMint = (input: unknown): Effect.Effect<MintOutcome, MintFailure, MintServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* decode(MintRequest, input);
      yield* Effect.try({
        try: () =>
          JSON.stringify(request, (key, value: unknown) => {
            if (key === "website_auth" || key === "websiteAuth") throw new Error("private_input");
            return value;
          }),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "JSON.stringify",
              phase: "request_validation",
              error,
            }),
            code: "InvalidRequest",
          }),
      });
      const dependencies = yield* MintServices;
      const redactCallerText = dependencies.redactCallerText ?? ((text: string) => text);
      const reportFailure = (error: unknown, details: MintReportContext) =>
        dependencies.reporting?.failure(error, details) ?? Effect.void;
      const reportBestEffort = (effect: Effect.Effect<void, Error>, details: MintReportContext) =>
        dependencies.reporting?.bestEffort(effect, details) ??
        effect.pipe(
          Effect.catchAll((error) =>
            diagnose({
              operation: details.operation,
              ...(details.phase === undefined ? {} : { phase: details.phase }),
              ...failureDetailMetadata(
                new MintFailure({
                  code: "Unavailable",
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: details.operation,
                    ...(details.phase === undefined ? {} : { phase: details.phase }),
                    error,
                  }),
                }),
              ),
            }),
          ),
        );
      const recovered = dependencies.agentRecovery?.initial?.harness;
      const finished: { build?: MintOutcome["build"] } = {};
      yield* Effect.addFinalizer((exit) =>
        dependencies.attemptFinished === undefined
          ? Effect.void
          : dependencies.attemptFinished(
              Exit.isFailure(exit)
                ? Cause.isInterruptedOnly(exit.cause)
                  ? "interrupted"
                  : "failed"
                : finished.build === "published"
                  ? finished.build
                  : "incomplete",
            ),
      );
      // An unanswered Dashboard build only asks its effect question. It is always the first turn.
      const effectQuestion = request.effect === "ask";
      if (effectQuestion && dependencies.capabilityQuestion)
        return yield* new MintFailure({ code: "ScopeDenied" });
      const toolScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(toolScope, Exit.void));
      const runTool = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.provideService(Scope.Scope, toolScope),
      );
      const initialPrompt = yield* screenMintText(dependencies, {
        ...request,
        siteOrigin: undefined,
      });
      const businessInputTypes = dependencies.capabilityQuestion
        ? undefined
        : yield* Effect.gen(function* () {
            const types = yield* Effect.try({
              try: () => jsonTypeTree(request.businessInput),
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "jsonTypeTree",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "InvalidRequest",
                }),
            });
            const screened = yield* screenMintText(dependencies, types);
            return yield* Effect.try({
              try: () => JSON.parse(screened) as unknown,
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "JSON.parse",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "Unavailable",
                }),
            });
          });
      // The job's own site origin is routing data the agent may see (decided 2026-09-26).
      const site =
        request.siteOrigin === undefined
          ? { available: false as const }
          : {
              available: true as const,
              siteOrigin: request.siteOrigin,
              loginRouting: "kernel_domain_discovery" as const,
              instruction:
                "The host already owns this exact site origin; do not ask the user to repeat it. Never use opaque or withheld text as a URL. Pass loginUrl on authenticate with the sign-in page you observed; the host uses it exactly as given, query and one-time values included. Without it, sign-in starts from the page the browser is on, else Kernel discovery.",
            };
      const serial = yield* Effect.makeSemaphore(1);
      const prompt = initialPrompt;
      const executions: ExecutionEvidence[] = [
        ...new Map(
          [
            ...(recovered?.executions ??
              (dependencies.initialExample ? [dependencies.initialExample] : [])),
            ...(dependencies.priorReadExecutions ?? []),
          ].map((entry) => [entry.executionId, entry]),
        ).values(),
      ];
      const diagnostics: string[] = [...(recovered?.diagnostics ?? [])];
      let unavailableOutputRefusals = recovered?.unavailableOutputRefusals ?? 0;
      const purposes = new Map<string, ExecutionRequest["purpose"] | "command">(
        (
          recovered?.purposes ??
          (dependencies.initialExample
            ? [
                {
                  executionId: dependencies.initialExample.executionId,
                  purpose: "example" as const,
                },
              ]
            : [])
        ).map((entry) => [entry.executionId, entry.purpose]),
      );
      for (const receipt of dependencies.priorReadExecutions ?? [])
        purposes.set(receipt.executionId, "example");
      let example: ExecutionEvidence | undefined =
        recovered?.exampleId === undefined
          ? executions.findLast((entry) => purposes.get(entry.executionId) === "example")
          : executions.find((entry) => entry.executionId === recovered.exampleId);
      let exampleClaimed =
        (recovered?.exampleClaimed ?? false) || (dependencies.exampleClaimed ?? false);
      // The build's effect and read authority. A read build's owner may approve a write upgrade
      // mid-build, which switches both in place.
      let buildEffect = request.effect;
      let repeatableRead = dependencies.repeatableRead === true;
      // A takeover keeps the owner's refusal, so the agent never asks again after it.
      let writeUpgradeDeclined = recovered?.writeUpgradeDeclined === true;
      // A write build's one live session: its first act step takes the example claim and the
      // step that records the site's confirmation closes it. A takeover restores this session;
      // an unrelated attempt with an existing claim keeps it closed.
      let writeSession: "none" | "open" | "closed" =
        recovered?.writeSession ?? (exampleClaimed ? "closed" : "none");
      const availabilityMetadata = () => {
        const executionAvailability = dependencies.executionAvailability?.();
        return executionAvailability === undefined ? {} : { executionAvailability };
      };
      const availabilityInstruction = () => {
        if (executionClosed)
          return "Live execution has ended for this attempt, but its eligible retained receipt can still be published. Correct source if needed and call finish_build with that receipt's executionId; do not execute again. request_input is still available when publication needs something only the user knows. ";
        switch (dependencies.executionAvailability?.()) {
          case "host_unavailable":
            return "The execution host is unavailable. End this attempt; preserve existing receipts and unresolved effects. Source edits or user input cannot restore this host. ";
          case "open":
          case undefined:
            return "Fresh reads require both existing authority and an available host; repeatableRead is not a promise of lifecycle capacity. ";
        }
      };
      // The trusted host notice about its entry page. It lives in the request
      // context, never the agent instructions, and is repeated only when it changes.
      // The host supplies it only for a fresh entry, never for a resumed page.
      let shownEntryState: string | undefined;
      const entryNotice = () => {
        const current = dependencies.entryNavigation?.();
        if (current === undefined) return undefined;
        const notice =
          current.state === "replaced"
            ? {
                state: current.state,
                requestedUrl: current.requestedUrl,
                page: current.page,
                reason: current.reason,
                instruction:
                  current.reason === "recovery"
                    ? current.page === undefined
                      ? "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery), on a new, empty profile. Read page.url() before acting and navigate from there."
                      : "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery) and, because this is a read, reopened the last page the site served the previous browser; page is where it landed. The new browser has a new, empty profile. Read page.url() and the page before acting and continue from there."
                    : current.page === undefined
                      ? "The host signed in on a new browser from the site's saved profile, in this same attempt. Read page.url() before acting and navigate from there."
                      : "The host signed in on a new browser from the site's saved profile, in this same attempt, and opened it on page: the page you were on, or the login page when that did not load. Read page.url() before acting and continue from there.",
                ...(current.instruction === undefined ? {} : { instruction: current.instruction }),
              }
            : current.state === "opened"
              ? {
                  state: current.state,
                  outcome: current.outcome,
                  requestedUrl: current.requestedUrl,
                  resolvedUrl: current.resolvedUrl,
                  ...(current.status === null ? {} : { status: current.status }),
                  instruction:
                    current.outcome === "ready"
                      ? "The trusted host already loaded this exact requested page before you started; the browser is at resolvedUrl. Do not navigate to the entry URL again or guess a homepage; start from the current page."
                      : (current.instruction ??
                        "The trusted host already loaded the requested page before you started, but the site answered with an HTTP error status. Inspect the current page before assuming its content; do not navigate to the entry URL again."),
                }
              : current.reason === "prior_effect"
                ? {
                    state: current.state,
                    outcome: current.outcome,
                    reason: current.reason,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "The host did not open the requested page, because an earlier attempt of this build already ran on the website. The browser is not on requestedUrl; read page.url() before acting. Navigate to requestedUrl yourself when the task needs it, after reading back whether a write an earlier attempt may have made already happened.",
                  }
                : {
                    state: current.state,
                    outcome: current.outcome,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "Host entry navigation did not reach the requested page. Do not assume the browser is on requestedUrl; read page.url() before acting.",
                  };
        // The caller's own page URLs are shown exactly; they are never masked.
        return current.state === "opened" && current.egressProxy !== undefined
          ? {
              ...notice,
              egressProxy: current.egressProxy,
            }
          : notice;
      };
      const changedEntryNotice = (): { readonly hostEntryNavigation?: object } => {
        const current = dependencies.entryNavigation?.();
        const state =
          current === undefined
            ? undefined
            : `${current.state}:${"outcome" in current ? current.outcome : ""}:${"reason" in current ? current.reason : ""}:${"page" in current ? (current.page ?? "") : ""}`;
        if (state === undefined || state === shownEntryState) return {};
        const notice = entryNotice();
        shownEntryState = state;
        return notice === undefined ? {} : { hostEntryNavigation: notice };
      };
      const executionContext = () =>
        Effect.gen(function* () {
          const retainedExecutions = yield* Effect.forEach(executions, (entry) =>
            decode(VisibleReceipt, {
              executionId: entry.executionId,
              status: entry.status,
              effect: entry.effect,
            }).pipe(
              Effect.map((receipt) => ({
                ...receipt,

                purpose: purposes.get(entry.executionId),
                repairPublicationAllowed:
                  dependencies.canPublishRepair?.(entry.executionId) === true,
              })),
            ),
          );
          return {
            repeatableRead,
            ...availabilityMetadata(),
            exampleClaimed,
            ...(writeSession === "none" ? {} : { writeSession }),
            retainedExecutions,
            instruction:
              availabilityInstruction() +
              "These are host-owned execution references, distinct from invocation and attempt IDs. Do not ask the user for internal receipt IDs. Failed receipts do not establish a successful current result. With repeatableRead:true and an available live host, use purpose explore for current read-only observations and purpose example for a fresh reviewed execution of the corrected read under the original input/account after confirmed executor cleanup. Purpose inspect is the separate reconciliation protocol for prior uncertain effects, not the generic browser-probe mode. Otherwise preserve the dispatch fence and reconcile current state; repairPublicationAllowed permits future source review, not replay or a claim that the original action failed.",
          };
        });
      let terminal: MintHarnessSnapshot["terminal"] = recovered?.terminal;
      /**
       * The last sign-in's failure while no later authenticate has started, and whether a final
       * answer already got its guidance back.
       */
      let unresolvedSignIn:
        | {
            readonly failure: SignInDiagnostic;
            readonly spent: SpentSignIn | undefined;
            guided: boolean;
          }
        | undefined;
      /**
       * Sign-in is unavailable in this build: the answer that said so, which a later authenticate
       * gets again, and the outcome the build ends with. A retained receipt that may still
       * publish holds the outcome back until the model stops.
       */
      let signInUnavailable: MintHarnessSnapshot["signInUnavailable"] =
        recovered?.signInUnavailable;
      /** The model gave a final answer while sign-in was unavailable, which stops it. */
      let modelStoppedForSignIn = false;
      // A question to the build's owner went unanswered; the build ends as no_response.
      let noResponse = recovered?.noResponse;
      let unavailableCauseRecorded = recovered?.unavailableCauseRecorded ?? false;
      // Resubmissions after a review outage, per kind; recorded for diagnosis only. The host
      // already retried each review with backoff, so only an outage that outlasts
      // `reviewOutageBudgetMs` with no review completing ends the attempt.
      const reviewUnavailableRetries = {
        ...(recovered?.reviewUnavailableRetries ?? { execution: 0, publication: 0, question: 0 }),
      };
      /** When the current run of review outages began; cleared by any completed review. */
      let reviewOutageStartedAt = recovered?.reviewOutageStartedAt;
      const reviewCompleted = Effect.sync(() => {
        reviewOutageStartedAt = undefined;
      });
      /** A failure that shows Guardian decided: a deny, or an execution it allowed. */
      const reviewDecided = (error: MintFailure) =>
        error.code === "ReviewDenied" ||
        error.review !== undefined ||
        error.execution !== undefined;
      let destinationEvidenceRefusals = recovered?.destinationEvidenceRefusals ?? 0;
      let inputFeedbackRounds = recovered?.inputFeedbackRounds ?? 0;
      /** The last input-feedback review found a tool already public, which never falls back. */
      let inputFeedbackPublicTool = recovered?.inputFeedbackPublicTool ?? false;
      /** The screened coverage of the last candidate Guardian returned input feedback for. */
      let inputFeedbackCoverage = recovered?.inputFeedbackCoverage ?? "";
      /** Guardian's finite reason when the latest publication was a completed denial. */
      let publicationDenial = recovered?.publicationDenial;
      const destinationEvidenceInstruction = {
        no_route_evidence:
          "This example recorded no route of its own, so there is no route evidence to publish with.",
        sign_in_route_evidence:
          "No verified sign-in's routes cover this example: no sign-in ran in this build, the example ran with a different selected login URL than the sign-in used, or the sign-in recorded no routes. Call execute with purpose authenticate to sign in, then run the example again.",
        inconsistent_route_evidence:
          "The recorded route evidence is inconsistent, for example more than 64 routes.",
        receipt_mismatch: "The recorded route evidence belongs to other source than this receipt.",
        unknown: "The recorded route evidence cannot support publication.",
      };
      // Executions the provider failed, for diagnosis; like review outages, only an outage that
      // outlasts its budget with no execution completing closes live execution.
      let providerUnavailableRetries = recovered?.providerUnavailableRetries ?? 0;
      let providerOutageStartedAt = recovered?.providerOutageStartedAt;
      let diagnosticRetentionRetries = recovered?.diagnosticRetentionRetries ?? 0;
      const reviewOutageBudgetMs = dependencies.reviewOutageBudgetMs ?? 15 * 60_000;
      const maximumDiagnosticRetentionRetries = 1;
      const unavailableHostTerminal = () => {
        const cause = dependencies.unavailableHostCause?.();
        if (!unavailableCauseRecorded) {
          unavailableCauseRecorded = true;
          // The terminal diagnostics always name the host's own first cause, so a stop after the
          // last successful tool call is never recorded without one.
          const stopped = dependencies.hostUnavailableCause?.();
          if (cause !== undefined)
            for (const entry of cause.diagnostics) diagnostics.push(JSON.stringify(entry));
          else
            diagnostics.push(
              JSON.stringify({
                phase: "host",
                hostFailure: "host_unavailable",
                cause: stopped,
              }),
            );
        }
        return {
          build: "incomplete" as const,
          // A policy failure of background traffic is the site's doing, not infrastructure's.
          ...(cause === undefined ? { hostFailure: "host_unavailable" as const } : {}),
          summary:
            cause === undefined
              ? "Execution infrastructure is unavailable. Preserve recorded effects and reconcile possible dispatch before further execution."
              : `Execution infrastructure is unavailable because background browser traffic failed a policy check${cause.reason === undefined ? "" : ` (${cause.reason})`}. Diagnostics list any earlier execution failure first; the later check does not explain that earlier failure. Preserve recorded effects and reconcile possible dispatch before further execution.`,
        };
      };
      /**
       * Publishes the last candidate whose review found only input feedback, privately and
       * flagged, and settles the build. Nothing publishes for a tool that is already public or
       * when that publication fails; the build then ends incomplete, naming which.
       */
      const settleUnresolvedInputFeedback = Effect.gen(function* () {
        const fallback = dependencies.inputFeedbackFallback;
        if (fallback === undefined) return false;
        const outcome = yield* Effect.either(fallback.publish);
        if (outcome._tag === "Left") {
          yield* diagnose({
            phase: "publication",
            reason: "input_feedback_unresolved",
            code: outcome.left.code,
            failureReason: outcome.left.reason,
          });
          terminal = { build: "incomplete", summary: unresolvedInputFeedbackSummary(outcome.left) };
          return false;
        }
        const published = outcome.right;
        if (published === undefined) {
          // A later review dropped the candidate; that review's own outcome stands. A public
          // tool keeps its published revision, flagged for its next maintenance.
          if (inputFeedbackPublicTool) {
            yield* fallback.flagPublished;
            terminal = {
              build: "incomplete",
              summary: unresolvedInputFeedbackSummary("public_tool"),
            };
          }
          return false;
        }
        for (const gap of published.diagnostics) {
          const diagnostic = JSON.stringify(gap);
          if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
        }
        terminal = {
          build: "published",
          publicationRef: published.publicationRef,
          summary: `${inputFeedbackCoverage} Published for this account only and flagged: Guardian's input feedback (${published.categories.join(", ")}) was not resolved.`,
        };
        return true;
      });
      // Publication reads workspace files and retained results, never the browser or executor.
      // Once live execution ends, a retained publishable receipt keeps the attempt open for
      // source correction and finish_build instead of ending it.
      let executionClosed = recovered?.executionClosed ?? false;
      const publishableReceipt = () =>
        executions.some(
          (entry) =>
            ((purposes.get(entry.executionId) === "example" ||
              purposes.get(entry.executionId) === "act") &&
              entry.status === "completed" &&
              entry.resultRef !== undefined) ||
            (purposes.get(entry.executionId) === "act" && entry.confirmation !== undefined) ||
            dependencies.canPublishRepair?.(entry.executionId) === true,
        );
      const hostIsUnavailable = () => dependencies.executionAvailability?.() === "host_unavailable";
      /** Ends live execution; the attempt itself ends only without a publishable receipt. */
      const closeExecution = () => {
        if (terminal === undefined && publishableReceipt()) executionClosed = true;
        else terminal ??= unavailableHostTerminal();
      };
      const stopUnavailableHost = (afterModel = false) => {
        if (!hostIsUnavailable()) return false;
        if (!afterModel && terminal === undefined && publishableReceipt()) {
          executionClosed = true;
          return false;
        }
        const unavailable = unavailableHostTerminal();
        terminal ??= unavailable;
        return true;
      };
      const stopRevokedAttempt = () => {
        if (!dependencies.attemptRevoked?.()) return false;
        if (terminal === undefined) {
          terminal = {
            build: "incomplete",
            summary:
              "This attempt stopped or lost its lease. Earlier execution receipts and unresolved effects remain retained; no further model or tool work is allowed.",
          };
          diagnostics.push(JSON.stringify({ phase: "attempt", reason: "stopped" }));
        }
        return true;
      };
      const active = (use: "execution" | "publication" = "execution") =>
        Effect.suspend(() =>
          terminal
            ? Effect.fail(new MintFailure({ code: "AlreadyExecuted" }))
            : stopUnavailableHost()
              ? Effect.fail(new MintFailure({ code: "Unavailable" }))
              : stopRevokedAttempt()
                ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
                : use === "execution" && executionClosed
                  ? Effect.fail(
                      new MintFailure({ code: "Unavailable", reason: "executor_unavailable" }),
                    )
                  : Effect.void,
        );
      const screenRationale = (rationale: string) =>
        screenMintText(dependencies, rationale).pipe(
          Effect.catchAll((error) =>
            Effect.succeed(
              `Guardian feedback delivery failed during credential screening (${error.code}); consult the protected review trace.`,
            ),
          ),
        );
      const screenAssumptions = (proposedAssumptions: PublicationRequest["assumptions"] = []) =>
        Effect.gen(function* () {
          // An assumption that screening would change may carry private data: drop it.
          const assumptions: BuildAssumption[] = [];
          for (const entry of proposedAssumptions ?? []) {
            const subject = yield* screenMintText(dependencies, entry.subject);
            const choice = yield* screenMintText(dependencies, entry.choice);
            if (subject === entry.subject && choice === entry.choice)
              assumptions.push({ kind: "site_default", subject, choice });
          }
          return assumptions;
        });
      const publicationResult = (
        published: MintCompletion,
        coverage: string,
        assumptions: readonly BuildAssumption[] = [],
      ) =>
        Effect.gen(function* () {
          terminal = {
            build: "published",
            ...(published.publicationRef === undefined
              ? {}
              : { publicationRef: published.publicationRef }),
            ...("artifact" in published ? { artifact: published.artifact } : {}),
            summary: coverage,
            ...(assumptions.length === 0 ? {} : { assumptions }),
          };
          return JSON.stringify({
            status: "published",
            ...(published.review === undefined
              ? {}
              : {
                  review: {
                    ...published.review,
                    rationale: yield* screenRationale(published.review.rationale),
                  },
                }),
            ...(published.shareability === undefined
              ? {}
              : {
                  shareability: {
                    ...published.shareability,
                    rationale: yield* screenRationale(published.shareability.rationale),
                  },
                }),
            instruction:
              "Build published for future calls. The current invocation outcome is returned separately; do not execute the example again.",
          });
        });
      const recordInputAnswer = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          const value = answers[submitted.questions[0]?.id ?? ""]?.value;
          let summary: string;
          if (effectQuestion) {
            const effect = value;
            if (effect !== "read" && effect !== "write")
              return yield* new MintFailure({ code: "InvalidRequest" });
            if (!dependencies.recordBuildEffect)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.recordBuildEffect(effect);
            summary = `The owner chose a ${effect} build.`;
          } else if (dependencies.capabilityQuestion !== undefined) {
            const answer = value;
            if (typeof answer !== "string" || !dependencies.capabilityAnswered)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.capabilityAnswered(answer);
            summary = "The owner answered the capability question.";
          } else return;
          terminal ??= { build: "incomplete", summary };
        });
      const inputResult = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          yield* recordInputAnswer(submitted, answers);
          const visibleAnswers = yield* answersForModel(answers);
          const handles = Object.values(answers).some((answer) => answer.type === "secret");
          return JSON.stringify({
            status: "answered",
            answers: visibleAnswers,
            instruction: `The caller answered. Continue in this attempt with these answers; verify the current page before acting on them, and before any further write.${handles ? " A secret answer is a handle such as {{secret.s1}}, never the value, which you never see. Write the handle exactly as given, as the whole string literal passed as the value to fill, type or pressSequentially, or as a field of a request to this site, in the Playwright code of a kernel.browsers.playwright.execute call in explore, test or act source; the host fills in the value when it runs that source live, and masks it in what comes back. It refuses a handle anywhere else, such as in a variable, a concatenation, a transform, a return value or a navigation. Offline targets get the handle text unchanged. An example and published source never hold a handle: a value the finished tool needs at run time is a declared secret question it asks with ask." : ""}`,
          });
        });
      const visible = (evidence: ExecutionEvidence) =>
        Effect.gen(function* () {
          const siteAccess = siteAccessDiagnostic(evidence);
          const receipt = yield* decode(VisibleReceipt, {
            executionId: evidence.executionId,
            status: evidence.status,
            effect: evidence.effect,
            ...(evidence.authentication ? { authentication: evidence.authentication } : {}),
            ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
            ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
            ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
          });
          // Receipt identifiers are host control metadata, never generated observations.
          // Screening the whole envelope can corrupt IDs and make completion impossible.
          const parsed = yield* Effect.try((): unknown =>
            typeof evidence.observations === "string"
              ? JSON.parse(evidence.observations)
              : evidence.observations,
          ).pipe(Effect.option);
          const observations =
            parsed._tag === "Some"
              ? yield* dependencies.projection.json(parsed.value).pipe(
                  Effect.map((value) => JSON.stringify(value)),
                  Effect.mapError(
                    (error) =>
                      new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "screenJsonObservation",
                          error: error,
                          context: {
                            executionId: evidence.executionId,
                            executionStatus: evidence.status,
                          },
                        }),
                        code: "Unavailable",
                      }),
                  ),
                )
              : yield* screenMintText(dependencies, evidence.observations);
          return JSON.stringify({
            ...receipt,
            ...(evidence.review === undefined
              ? {}
              : {
                  review: {
                    ...evidence.review,
                    rationale: yield* screenRationale(evidence.review.rationale),
                  },
                }),
            siteAccess,
            ...(evidence.scriptQuestion === undefined
              ? {}
              : {
                  scriptQuestion: {
                    ...evidence.scriptQuestion,
                    ...("rationale" in evidence.scriptQuestion
                      ? { rationale: yield* screenRationale(evidence.scriptQuestion.rationale) }
                      : {}),
                    instruction: scriptQuestionInstruction[evidence.scriptQuestion.outcome],
                  },
                }),
            repeatableRead,
            ...availabilityMetadata(),
            ...changedEntryNotice(),
            observations,
          });
        });
      const record = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) => {
        const safe = safeExecutionEvidence(evidence);
        const referenceOnly = {
          ...safe,
          observations:
            "Private observations are available through the screened execution response.",
        };
        executions.push(referenceOnly);
        purposes.set(evidence.executionId, purpose);
        if (purpose === "example") example = referenceOnly;
        // The step that recorded the site's confirmation is the build's own write result.
        if (purpose === "act" && safe.confirmation !== undefined) {
          example = referenceOnly;
          writeSession = "closed";
        }
        if (safe.siteAccess !== undefined)
          diagnostics.push(JSON.stringify({ phase: "site_access", ...safe.siteAccess }));
      };
      const executionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) =>
        Effect.gen(function* () {
          record(evidence, purpose);
          const receipt = yield* visible(evidence);
          if (evidence.terminalFailure === "ChallengeFailure" && !stopUnavailableHost())
            terminal ??= {
              build: "incomplete",
              summary:
                "The live operation reported a challenge failure. No build was published. Recorded effects and receipts are preserved.",
            };
          // The owner never answered the example's question: the build ends as no_response
          // instead of handing the minter a failed example.
          if (evidence.noResponse !== undefined && !stopUnavailableHost()) {
            noResponse ??= evidence.noResponse;
            terminal ??= {
              build: "incomplete",
              summary:
                "The build's example asked a question that was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.",
            };
          }
          return receipt;
        });
      /** Restore the host's durable claim before exposing an adopted execution receipt. */
      const recoveredExecutionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) =>
        Effect.gen(function* () {
          if (
            (purpose === "example" || purpose === "act") &&
            evidence.preflight !== "rejected_before_claim"
          ) {
            exampleClaimed = true;
            if (purpose === "act" && writeSession === "none") writeSession = "open";
          }
          return yield* executionResult(evidence, purpose);
        });
      /** A diagnostic copy that could not be written, kept as a gap in the outcome. */
      const recordDiagnosticGap = (event: string) => (error: MintFailure) =>
        Effect.gen(function* () {
          diagnostics.push(
            JSON.stringify({
              phase: "diagnostics",
              reason: "diagnostic_gap",
              event,
              code: error.code,
              diagnosticRetentionReason: error.diagnosticRetentionReason,
              diagnosticStorageFailure: error.diagnosticStorageFailure,
            }),
          );
          yield* reportFailure(error, {
            component: "mint",
            operation: "diagnostics.emit",
            phase: event,
            subCause: "mint_host_dependency_failed",
            correlation: dependencies.reportCorrelation ?? "process",
          });
        });
      // Screening serializes through JSON, which leaves out undefined fields.
      const diagnose = (value: unknown) =>
        screenMintText(dependencies, value).pipe(
          Effect.tap((safe) =>
            Effect.sync(() => {
              diagnostics.push(safe);
            }),
          ),
          Effect.ignore,
        );
      const diagnoseExecution = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
        details: Readonly<Record<string, unknown>>,
        /** Archive-only detail; never copied into the harness's own diagnostics. */
        failure?: unknown,
      ) => {
        const policy = policyFailureMetadata(details);
        const authority = authorityCheckMetadata(details);
        const privateCandidate = destinationPrivateCandidateMetadata(details);
        const code = details.code;
        const retained =
          (policy !== undefined || authority !== undefined || privateCandidate !== undefined) &&
          (code === "ScopeDenied" || code === "Unavailable")
            ? (dependencies.diagnostics
                ?.emit("mint.policy_failed", {
                  code,
                  ...policy,
                  ...authority,
                  ...privateCandidate,
                  ...failureDetailMetadata(failure),
                })
                .pipe(Effect.ignore) ?? Effect.void)
            : failureDetailMetadata(failure) !== undefined
              ? // Every other execution failure with detail is retained for diagnosis.
                (dependencies.diagnostics
                  ?.emit("mint.execution_failed", {
                    code,
                    ...(typeof details.rootCode === "string" ? { rootCode: details.rootCode } : {}),
                    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
                    ...failureDetailMetadata(failure),
                  })
                  .pipe(Effect.ignore) ?? Effect.void)
              : Effect.void;
        return diagnose({
          phase: "execution",
          purpose: submitted.purpose,
          target: submitted.target,
          ...(submitted.purpose === "command"
            ? {}
            : {
                fixtureCount: submitted.fixtureRefs.length,
                filterCount: submitted.caseFilter.length,
                maxWorkers: submitted.maxWorkers,
              }),
          ...details,
        }).pipe(Effect.zipRight(retained));
      };
      /**
       * Whether the unanswered build may have committed: yes unless it never dispatched or the
       * site rejected it, so any write example or residual not proven `not_sent` counts.
       */
      const possibleCommit = () =>
        buildEffect === "write" &&
        executions.some((entry) => {
          const purpose = purposes.get(entry.executionId);
          return (purpose === "example" || purpose === "residual") && entry.effect !== "not_sent";
        });
      /** Why this build cannot ask to become a write now; undefined when it may. */
      const writeUpgradeUnavailable = () => {
        if (effectQuestion || dependencies.capabilityQuestion !== undefined)
          return "This turn only asks the host's own question. Ask it as instructed.";
        if (request.mode === "maintenance")
          return "Maintenance keeps the published tool's effect, so it cannot become a write. Repair it as it is.";
        if (buildEffect === "write")
          return "This build is already a write build. Perform the task through purpose act steps, as .agents/writes/SKILL.md describes.";
        if (request.siteOrigin === undefined)
          return "An offline build has no website to change. Finish it as a read.";
        // The job's one example claim is either reads or the write's; a job that already ran a
        // live read example can never start a write session.
        if (
          !repeatableRead ||
          exampleClaimed ||
          (dependencies.priorReadExecutions ?? []).length > 0
        )
          return "This build already ran a live read example, so this job cannot become a write: its example is a read. Finish what a read can do, or end the attempt and say in the summary that the task needs a new write build. Ask for a write upgrade before running a live example.";
        if (writeUpgradeDeclined)
          return "The owner already kept this build read-only. Finish what a read can do, or end the attempt and say in the summary that the task needs a write build.";
        if (dependencies.upgradeToWrite === undefined)
          return "This host cannot switch the build's effect. Finish what a read can do, or end the attempt and say in the summary that the task needs a write build.";
        return undefined;
      };
      /**
       * Why a request is refused before anyone reviews it, if it is: the effect question and a
       * write upgrade are each one read-or-write choice, and the capability question is the host's
       * own text question.
       */
      const requestShapeRefusal = (
        submitted: AgentInputRequest,
        upgrade: boolean,
      ): { readonly reason: string; readonly instruction: string } | undefined => {
        const [only] = submitted.questions;
        const readOrWrite = isReadOrWriteChoice(submitted);
        if (effectQuestion && !readOrWrite)
          return {
            reason: "effect_question_shape",
            instruction:
              "Ask exactly one choice question whose options have the ids read and write, with no other option and no notice.",
          };
        if (
          !effectQuestion &&
          dependencies.capabilityQuestion !== undefined &&
          (submitted.questions.length !== 1 ||
            only?.type !== "text" ||
            only.prompt !== dependencies.capabilityQuestion)
        )
          return {
            reason: "capability_question_shape",
            instruction:
              "Ask exactly the host's capability question as one text question with that prompt.",
          };
        if (!upgrade) return undefined;
        if (!readOrWrite)
          return {
            reason: "write_upgrade_shape",
            instruction:
              "Ask exactly one choice question whose options have the ids read and write, with no other option and no notice. Its prompt says in one or two plain sentences what the build would change on the website and why the requested task needs it.",
          };
        const unavailable = writeUpgradeUnavailable();
        return unavailable === undefined
          ? undefined
          : { reason: "write_upgrade_unavailable", instruction: unavailable };
      };
      /**
       * Applies the owner's answer to a write upgrade. `write` switches the build to write authority
       * and the write build rules in place; anything else keeps it a read. A switch the host could
       * not record leaves the build a read and says exactly why, so the agent can continue. A
       * takeover applies a recovered answer here too: Guardian reviewed the question before the
       * owner saw it, and switching changes nothing on the site, so neither is repeated.
       */
      const answerWriteUpgrade = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          const { choice, change } = writeUpgradeChoice(submitted, answers);
          const asked = { answers: yield* answersForModel(answers), change };
          const upgradeToWrite = dependencies.upgradeToWrite;
          if (choice !== "write" || upgradeToWrite === undefined) {
            writeUpgradeDeclined = true;
            return JSON.stringify({
              status: "answered",
              answers: asked.answers,
              buildEffect: "read",
              instruction:
                "The owner kept this build read-only. Do not fill, choose, advance, save or submit anything on the site. Finish what a read can do, or end the attempt and say in the summary that the task needs a write build.",
            });
          }
          const switched = yield* Effect.either(upgradeToWrite(asked.change));
          if (switched._tag === "Left") {
            yield* reportFailure(switched.left, {
              component: "mint",
              operation: "upgradeToWrite",
              phase: "write_upgrade",
              subCause: "mint_host_dependency_failed",
              correlation: dependencies.reportCorrelation ?? "process",
            });
            return JSON.stringify({
              status: "write_upgrade_failed",
              answers: asked.answers,
              buildEffect: "read",
              code: switched.left.code,
              ...failureDetailMetadata(switched.left),
              userInputRequired: false,
              instruction:
                "The owner approved the write, but the host could not record the switch, so this build is still a read and nothing on the site may change. failureDetail says which step failed and why. You may ask again once; otherwise end the attempt and say in the summary that the owner approved a write the host could not record.",
            });
          }
          buildEffect = "write";
          repeatableRead = false;
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.effect_upgraded", {
              priorExecutions: purposes.size,
              priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent").length,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.effect_upgraded",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          return JSON.stringify({
            status: "answered",
            answers: asked.answers,
            buildEffect: "write",
            instruction:
              "The owner approved: this build is now a write build, and every later execution is reviewed under write authority. Read .agents/writes/SKILL.md, and .agents/forms/SKILL.md for a form, before the next step. The write is the whole task the request asks for, done once through purpose act steps; it may take several steps, and drafts, autosaves and step saves along the way are part of it. Before the first act step, ask with request_input for any value the task needs that the input does not settle. The first act step starts with navigation to the site origin (keeping the session saved after sign-in), so it must navigate to any deeper task page it needs; what you observed so far stays valid evidence. From now on a live example or live test is refused, and so is a live explore once the session starts.",
          });
        });
      /** The build's owner left a question unanswered: the build ends as no_response. */
      const unanswered = (error: MintFailure, step: string) =>
        Effect.sync(() => {
          noResponse ??= {
            possibleCommit: error.noResponse?.possibleCommit === true || possibleCommit(),
          };
          terminal ??= {
            build: "incomplete",
            summary: `A question to the build's owner while ${step} was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.`,
          };
          return JSON.stringify({
            status: "no_response",
            instruction: "The build's owner did not answer in time. The host is ending this build.",
          });
        });
      const reviewFeedback = (error: MintFailure) =>
        Effect.gen(function* () {
          const rationale = error.review
            ? yield* screenMintText(dependencies, error.review.rationale)
            : "Guardian rejected this submission; rationale unavailable.";
          return JSON.stringify({
            status: "review_rejected",
            code: "ReviewDenied",
            exampleClaimed,
            repeatableRead,
            ...availabilityMetadata(),
            ...(error.review
              ? { outcome: error.review.outcome, reviewId: error.review.reviewId }
              : {}),
            rationale,
            notice:
              availabilityInstruction() +
              (repeatableRead
                ? "This invocation permits fresh reviewed reads only while live execution remains available and after confirmed executor cleanup; preserve earlier receipts. "
                : exampleClaimed
                  ? "The example is already claimed; never repeat it. "
                  : "This example has not been claimed. Correct undispatched source and submit it for fresh review. ") +
              "Correct the submitted source or collect missing evidence through an authorized safe observation, then submit for fresh review. Request user input only for missing authority or information the user must supply. This feedback grants no new authority. Preserve prior effects; do not repeat a claimed example or uncertain write/login.",
          });
        }).pipe(
          Effect.catchAll(() =>
            Effect.succeed(
              JSON.stringify({
                status: "review_rejected",
                code: "ReviewDenied",
                exampleClaimed,
                ...availabilityMetadata(),
                rationale: "Review feedback unavailable.",
                notice:
                  availabilityInstruction() +
                  "Preserve prior effects; do not repeat a claimed example.",
              }),
            ),
          ),
        );
      /** Whether this review failure ends the attempt: its retention retry is spent, or reviews
       * have been unavailable for the whole outage budget. */
      const reviewRetryExhausted = (retentionFailure: boolean) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          if (retentionFailure)
            return diagnosticRetentionRetries >= maximumDiagnosticRetentionRetries;
          reviewOutageStartedAt ??= now;
          return now - reviewOutageStartedAt >= reviewOutageBudgetMs;
        });
      /**
       * A spent model quota is a host failure no retry gets past, whether the minter's call or
       * Guardian's hit it, since both use the same provider account.
       * Operators see it like any other host failure, with the provider's error beneath the
       * finite code.
       */
      const endForSpentModelQuota = (failure: MintFailure, phase: "model" | "review") =>
        Effect.gen(function* () {
          // Another outcome already ended the attempt; it stands, and nothing claims otherwise.
          if (terminal !== undefined) return terminal.hostFailure === "model_quota_exhausted";
          terminal = {
            build: "incomplete",
            hostFailure: "model_quota_exhausted",
            summary:
              "The model provider refused this attempt's calls because the account's model quota is spent, so the host ended the attempt without publishing. Retrying cannot help until the quota is restored. Recorded effects and receipts are preserved.",
          };
          yield* diagnose({
            phase,
            hostFailure: "model_quota_exhausted",
            code: failure.code,
            rootCause: failureRootCause(failure),
          });
          yield* reportFailure(failure, {
            component: "mint",
            operation: phase === "model" ? "model.run" : "guardian.review",
            phase,
            subCause: "model_quota_exhausted",
            correlation: dependencies.reportCorrelation ?? "process",
            ...(dependencies.diagnostics === undefined ? {} : { sink: dependencies.diagnostics }),
          });
          return true;
        });
      /** Guardian's review found the quota spent; the reply names only the outcome that stands. */
      const spentQuotaReview = (error: MintFailure) =>
        endForSpentModelQuota(error, "review").pipe(
          Effect.map((ended) =>
            JSON.stringify({
              status: "review_unavailable",
              code: error.code,
              reviewFailure: error.reviewFailure,
              ...(ended ? { hostFailure: "model_quota_exhausted" } : {}),
              retryable: false,
              userInputRequired: false,
              instruction: ended
                ? "Guardian could not review because the model provider's quota is spent; nothing was approved and waiting does not restore it. End this attempt; preserve recorded effects and receipts."
                : "Guardian could not review, and nothing was approved; this attempt has already ended with its recorded outcome. Preserve recorded effects and receipts.",
            }),
          ),
        );
      /**
       * A review Guardian could not complete, as the agent reads it. `next` is how the attempt goes
       * on, with the live execution it still has; without it the attempt ends. `retention` adds why
       * the review's evidence could not be kept.
       */
      const reviewUnavailableAnswer = (
        error: MintFailure,
        notice: string,
        {
          retention = true,
          next,
        }: {
          readonly retention?: boolean;
          readonly next?: { readonly retryable: boolean; readonly retriesRemaining?: number };
        } = {},
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "review_unavailable",
          code: "ReviewUnavailable",
          reviewFailure: error.reviewFailure,
          reviewPhase: error.reviewPhase,
          reviewDispatch: error.reviewDispatch,
          ...(retention
            ? {
                ...(error.diagnosticRetentionReason === undefined
                  ? {}
                  : { diagnosticRetentionReason: diagnosticRetentionReason(error) }),
                diagnosticScreeningReason: diagnosticScreeningReason(error),
                diagnosticStorageFailure: diagnosticStorageFailure(error),
              }
            : {}),
          ...next,
          userInputRequired: false,
          ...(next === undefined ? {} : availabilityMetadata()),
          notice: next === undefined ? notice : availabilityInstruction() + notice,
        });
      /**
       * A review that Guardian could not complete is not a deny. The host already retried it with
       * backoff; the agent may resubmit while reviews have been unavailable for less than the
       * outage budget, and any completed review starts the budget again. A review whose evidence
       * could not be retained takes the diagnostic retention budget. Past either, `exhausted`
       * ends the attempt.
       */
      const reviewUnavailableRetry =
        (
          kind: keyof typeof reviewUnavailableRetries,
          exhausted: (error: MintFailure) => Effect.Effect<string>,
        ) =>
        (error: MintFailure) =>
          Effect.gen(function* () {
            if (error.modelOutage === "quota_exhausted") return yield* spentQuotaReview(error);
            const retentionFailure = error.reviewPhase === "diagnostic_retention";
            if (stopUnavailableHost() || (yield* reviewRetryExhausted(retentionFailure)))
              return yield* exhausted(error);
            // Live execution ended during this review: the execution cannot be resubmitted, but the
            // retained receipt can still be published and a question still asked.
            if (kind === "execution" && executionClosed)
              return reviewUnavailableAnswer(
                error,
                "Guardian review did not complete and nothing was approved; this execution cannot be resubmitted.",
                { retention: false, next: { retryable: false } },
              );
            if (retentionFailure) diagnosticRetentionRetries += 1;
            else reviewUnavailableRetries[kind] += 1;
            return reviewUnavailableAnswer(
              error,
              "Guardian review did not complete. This is not a deny or escalation, and nothing was approved. " +
                reviewRetryInstruction[kind] +
                (retentionFailure
                  ? " retriesRemaining counts what this attempt still allows, after which review unavailability ends the attempt."
                  : " The host already retried this review with backoff before answering. Resubmitting is safe; if Guardian stays unavailable long enough, the host ends the attempt.") +
                " Do not change site code to work around review infrastructure.",
              {
                next: {
                  retryable: true,
                  ...(retentionFailure
                    ? {
                        retriesRemaining:
                          maximumDiagnosticRetentionRetries - diagnosticRetentionRetries,
                      }
                    : {}),
                },
              },
            );
          });
      const reviewRetryInstruction = {
        execution:
          "You may resubmit the same execution for a fresh review. reviewDispatch not_sent means this submission did not run; without it, treat the submission as possibly executed and reconcile before any further effect. Never repeat a claimed example.",
        publication:
          "Nothing was published. Call finish_build again with the same executionId for a fresh publication review; the retained example is not executed again.",
        question:
          "No question was created. Submit the same request_input again for a fresh question review; do not ask it in prose or invent a clarification.",
      };
      const reviewUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() => {
          terminal = {
            build: "incomplete",
            hostFailure: "review_unavailable",
            summary:
              "Guardian review could not complete. No review approval was obtained; recorded effects and claimed examples remain preserved.",
          };
          return reviewUnavailableAnswer(
            error,
            "Review did not complete; this is not a Guardian deny or escalation decision. End this attempt without publication. Do not change site code to repair review infrastructure or automatically retry execution. Preserve prior effects and claimed examples; reconcile possibly executed operations before any further effect. Missing user authority or credentials has not been established.",
          );
        });
      /** A publication dependency the host retried and that stayed unavailable. */
      const publicationOutage = (error: MintFailure) =>
        error.reason === "registry_unavailable" ||
        error.reason === "source_storage" ||
        (error.code === "Unavailable" && error.reason === undefined);
      /**
       * A publication refusal the minter can act on: `details` names what was refused, and
       * `instruction` follows what live execution is still available.
       */
      const notPublished = (
        code: MintFailure["code"],
        reason: string | undefined,
        details: object,
        instruction: string,
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "not_published",
          code,
          reason,
          ...details,
          ...availabilityMetadata(),
          userInputRequired: false,
          instruction: availabilityInstruction() + instruction,
        });
      /**
       * A registry refusal of a reviewed publication. A check the minter's metadata or source
       * decides goes back to it to fix, with no cap; any other refusal ends the attempt with its
       * reason. A registry outage the host's retries did not clear may be tried again until the
       * publication outage budget runs out.
       */
      const registryFeedback = (error: MintFailure) =>
        Effect.gen(function* () {
          const outage = publicationOutage(error);
          const refusal = outage
            ? {
                fixable: !(stopUnavailableHost() || (yield* reviewRetryExhausted(false))),
                instruction:
                  "Publication infrastructure (the tool registry or its source store) stayed unavailable through the host's retries, so nothing was published. Call finish_build again with the same executionId; the retained example is not executed again.",
              }
            : registryRefusal(error.registryIssue, error.registryProblem);
          if (!refusal.fixable)
            terminal = {
              build: "incomplete",
              ...(outage || error.registryIssue === undefined
                ? { hostFailure: "publication_unavailable" as const }
                : {}),
              summary: `Not published: ${refusal.instruction} The existing execution outcomes and protected results remain retained.`,
            };
          return notPublished(
            error.code,
            error.reason,
            {
              registryIssue: error.registryIssue,
              registryProblem: error.registryProblem,
              ...failureDetailMetadata(error),
              fixRequired: refusal.fixable && !outage,
              ...(outage ? { retryable: refusal.fixable } : {}),
            },
            refusal.instruction +
              (refusal.fixable ? "" : " This attempt ends here; preserve the recorded receipt."),
          );
        });
      const unavailableExecutionHost = (error: MintFailure) =>
        error.code === "Unavailable" &&
        error.reason === "executor_unavailable" &&
        error.execution === undefined &&
        error.authentication === undefined;
      const screenedRunnerFailure = (error: MintFailure) => {
        try {
          return finiteRunnerFailure(error.runnerFailure);
          // error-reporting-allow: parse-predicate an unreadable runnerFailure getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedCaptureGap = (error: MintFailure) => {
        try {
          return finiteCaptureGap(error.captureGap);
          // error-reporting-allow: parse-predicate an unreadable captureGap getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedRunnerChannels = ({ runnerChannels }: MintFailure) =>
        runnerChannels === undefined
          ? {}
          : {
              stdout: runnerChannels.stdout,
              stderr: runnerChannels.stderr,
              events: runnerChannels.events,
            };
      /** Whether a provider outage may still be resubmitted, starting its window if new. */
      const providerOutageOpen = (now: number) => {
        providerUnavailableRetries += 1;
        providerOutageStartedAt ??= now;
        return now - providerOutageStartedAt < reviewOutageBudgetMs;
      };
      const executionFeedback = (error: MintFailure) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => providerFeedback(error, now));
      const providerFeedback = (error: MintFailure, now: number) => {
        const runnerFailure = screenedRunnerFailure(error);
        const captureGap = screenedCaptureGap(error) ?? runnerFailure?.captureGap;
        const hostStopped = stopUnavailableHost() || unavailableExecutionHost(error);
        // The executor stop settles before this failure arrives, and a stop that failed makes
        // the host unavailable. So an available host here means the stop was confirmed. The host
        // already retried what it could, so the agent may resubmit until the outage outlasts its
        // budget.
        const providerRetry =
          !hostStopped &&
          error.execution?.reason === "provider_unavailable" &&
          providerOutageOpen(now);
        if (!providerRetry && (hostStopped || error.execution?.reason === "provider_unavailable"))
          closeExecution();
        const openCaptureGapNotice =
          captureGap !== undefined &&
          dependencies.executionAvailability?.() === "open" &&
          !hostStopped &&
          !executionClosed &&
          terminal === undefined
            ? "This command may have completed, but its capture observation is unavailable. The execution host remains open. You may make a new bounded observation of the current page and continue the request under ordinary review. Do not replay the previous command automatically or treat the missing capture as proof of success. Read back an uncertain write before any further write, never repeat a claimed example, and publish only from an eligible retained receipt."
            : undefined;
        const providerNotice = providerRetry
          ? {
              retryable: true,
              effect: error.execution?.dispatch === "not_sent" ? "not_sent" : "possible",
              providerNotice:
                error.execution?.dispatch === "not_sent"
                  ? "The execution provider was unavailable before this execution was dispatched, so it did not run. The host already retried; you may submit it again. If the provider stays unavailable long enough, live execution closes."
                  : "The execution provider failed after dispatch, and the host confirmed the executor stopped. The execution may have run: its effect is possible. Reconcile current state before claiming success or repeating any write; never repeat a claimed example. If the provider stays unavailable long enough, live execution closes.",
            }
          : {};
        // A failed sign-in names its own root cause and next step, never the wrapper's code.
        const feedback = signInFeedbackOf(error);
        // Until the agent signs in again, a final answer gets the way past it back once.
        if (error.authentication !== undefined && !hostStopped)
          unresolvedSignIn = {
            failure: error.authentication,
            spent: error.spentSignIn,
            guided: false,
          };
        // No further sign-in can run: the build ends with that outcome, not the loop guard.
        // A stop or cleanup the host could not confirm ends live work on its own terms.
        const ending =
          hostStopped ||
          terminal !== undefined ||
          error.authentication?.cleanupCode !== undefined ||
          feedback?.nextStep !== "report_sign_in_unavailable"
            ? ("none" as const)
            : publishableReceipt()
              ? ("after_publication" as const)
              : ("now" as const);
        const signIn = signInOrLoginInUseAnswer(error, feedback, ending);
        const rootCause = failureRootCause(error);
        return dependencies.projection
          .json({
            status: signIn === undefined ? "execution_unavailable" : "authentication_unavailable",
            code: signIn?.code ?? error.code,
            ...signIn?.fields,
            reason: error.reason,
            // A sign-in's diagnostic is its root cause; anything else names the one beneath.
            ...(signIn !== undefined || rootCause === undefined ? {} : { rootCause }),
            ...availabilityMetadata(),
            ...(error.destinationReason === "observation_unavailable"
              ? { destinationReason: error.destinationReason }
              : {}),
            execution: error.execution,
            workspace: error.workspace,
            runnerFailure,
            captureGap,
            // The runner's own output, when there is no capture view to carry it.
            ...screenedRunnerChannels(error),
            authentication: error.authentication,
            ...providerNotice,
            userInputRequired: false,
            notice:
              openCaptureGapNotice ??
              (error.execution?.workspace === undefined
                ? availabilityInstruction() +
                  (error.execution?.runnerResult === undefined
                    ? ""
                    : runnerResultNotice(error.execution.runnerResult)) +
                  (signIn?.notice ??
                    "Host execution failed; this does not establish missing credentials or a missing user answer. Preserve prior effects and the claimed example; reconcile uncertain website state before any further effect.")
                : error.execution.workspace.reason === "digest_mismatch"
                  ? `Nothing ran: the job sandbox's copy of ${(error.execution.workspace.mismatched ?? []).join(", ")} did not match the source Guardian reviewed. The host writes those files again before the next execution; submit the same execution again.`
                  : `Nothing ran: the host could not copy ${error.execution.workspace.fileCount} workspace file(s) inside the job sandbox for this execution. Submit it again; if it fails the same way, report that the execution sandbox is unavailable.`),
          })
          .pipe(
            Effect.map((value) => JSON.stringify(value)),
            Effect.catchAll(() =>
              Effect.succeed(
                JSON.stringify({
                  status: "execution_unavailable",
                  code: "Unavailable",
                  ...availabilityMetadata(),
                  userInputRequired: false,
                  notice:
                    availabilityInstruction() +
                    "Execution diagnostics unavailable; missing credentials were not established. Preserve prior effects; do not repeat a claimed example.",
                }),
              ),
            ),
            Effect.tap((answer) =>
              ending === "none" ? Effect.void : endForUnavailableSignIn(error, answer),
            ),
          );
      };
      /**
       * Records that sign-in is unavailable in this build, with the failed sign-in's root cause:
       * the build ends with that outcome at once, or once the model stops when a retained receipt
       * may still publish. A later authenticate gets the same answer.
       */
      const endForUnavailableSignIn = (error: MintFailure, answer: string) =>
        Effect.gen(function* () {
          const failure = error.authentication;
          const outcome = {
            build: "incomplete" as const,
            // A Personal conflict keeps its own actionable status; the worker words a saved
            // login's with its masked username.
            recoveryReason:
              failure?.code === "LoginIdentityConflict"
                ? ("login_identity_conflict" as const)
                : ("sign_in_unavailable" as const),
            summary: signInUnavailableSummary(failure, error.spentSignIn),
          };
          signInUnavailable = { answer, outcome };
          if (!publishableReceipt()) terminal ??= outcome;
          yield* diagnose({
            phase: "sign_in",
            reason: "sign_in_unavailable",
            ...(failure === undefined
              ? {}
              : {
                  code: signInRootCode(failure),
                  authenticationCode: failure.code,
                  authenticationPhase: failure.phase,
                  credentialSent: failure.nothingSubmitted !== true,
                }),
            spentSignIn: error.spentSignIn,
          });
        });
      const diagnosticUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() => {
          // One retry: evidence the host still cannot retain after it is an invariant it
          // cannot maintain, so the second failure ends the attempt.
          if (
            diagnosticRetentionRetries < maximumDiagnosticRetentionRetries &&
            dependencies.executionAvailability?.() !== "host_unavailable"
          ) {
            diagnosticRetentionRetries += 1;
            return JSON.stringify({
              status: "diagnostic_unavailable",
              code: "Unavailable",
              diagnosticRetentionReason: diagnosticRetentionReason(error),
              diagnosticStorageFailure: diagnosticStorageFailure(error),
              retryable: true,
              retriesRemaining: maximumDiagnosticRetentionRetries - diagnosticRetentionRetries,
              effect: "possible",
              userInputRequired: false,
              notice:
                "The host could not safely retain this execution's diagnostics, so no unscreened observations are available for it. The website action may have completed: treat its effect as possible and reconcile before claiming success; never repeat a claimed example. You may continue; another retention failure in this attempt ends it. Site code changes, credentials and user clarification cannot repair this infrastructure failure.",
            });
          }
          terminal = {
            build: "incomplete",
            hostFailure: "diagnostic_retention",
            summary:
              "Execution diagnostic retention failed. Preserve recorded effects and protected results; this does not establish a website or browser-provider failure.",
          };
          return JSON.stringify({
            status: "diagnostic_unavailable",
            code: "Unavailable",
            diagnosticRetentionReason: diagnosticRetentionReason(error),
            diagnosticStorageFailure: diagnosticStorageFailure(error),
            userInputRequired: false,
            notice:
              "The host could not safely retain execution diagnostics. End this attempt without publication or another execution. The website action may have completed; preserve existing receipts and reconcile prior effects. Site code changes, credentials and user clarification cannot repair this infrastructure failure. No unscreened observations are available.",
          });
        });
      const reviewedExecution: typeof dependencies.reviewAndExecute = (
        submitted,
        onDispatch = Effect.void,
      ) =>
        dependencies
          .reviewAndExecute(
            submitted,
            submitted.purpose === "example" ||
              (submitted.purpose === "act" && writeSession === "none")
              ? Effect.uninterruptible(
                  dependencies.claimExample.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        exampleClaimed = true;
                        if (submitted.purpose === "act") writeSession = "open";
                      }),
                    ),
                    Effect.zipRight(onDispatch),
                  ),
                )
              : submitted.purpose === "act"
                ? // Later steps continue the session's started claim; the journal never claims again.
                  Effect.uninterruptible(onDispatch)
                : Effect.void,
          )
          .pipe(
            // A refusal the host returned before any review or dispatch shows neither Guardian
            // nor the provider working, so it leaves both outage windows running.
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? Effect.void
                : reviewCompleted.pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        providerOutageStartedAt = undefined;
                      }),
                    ),
                  ),
            ),
            Effect.tapError((error) => (reviewDecided(error) ? reviewCompleted : Effect.void)),
            Effect.tapError((error) =>
              error.code === "CaptureUnavailable"
                ? Effect.sync(() => {
                    terminal = {
                      build: "incomplete",
                      hostFailure: "capture_unavailable",
                      summary:
                        "Execution stopped because infrastructure capture is unavailable. Recorded effects and protected results remain retained; site code must not be replayed to repair capture.",
                    };
                  })
                : Effect.void,
            ),
            Effect.map((evidence) => {
              // The script question's correction is for this result only, never the ledger.
              const receipt = {
                ...safeExecutionEvidence(evidence),
                ...(evidence.scriptQuestion === undefined
                  ? {}
                  : { scriptQuestion: evidence.scriptQuestion }),
              };
              // Only this harness's preflight can authorize correcting request mechanics.
              delete receipt.preflight;
              return receipt;
            }),
            Effect.tapError((error) =>
              diagnoseExecution(
                submitted,
                {
                  code: error.code,
                  // The root cause's own code, beneath the host's wrapper.
                  rootCode:
                    error.authentication === undefined
                      ? undefined
                      : signInRootCode(error.authentication),
                  reason: error.reason,
                  destinationReason: error.destinationReason,
                  ...policyFailureMetadata(error),
                  ...authorityCheckMetadata(error),
                  ...destinationPrivateCandidateMetadata(error),
                  reconciliationStage: error.reconciliationStage,
                  review: error.review,
                  reviewFailure: error.reviewFailure,
                  reviewPhase: error.reviewPhase,
                  reviewDispatch: error.reviewDispatch,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                  execution: error.execution,
                  authentication: error.authentication,
                },
                error,
              ),
            ),
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? diagnoseExecution(submitted, {
                    status: evidence.status,
                    reason: evidence.observations,
                  })
                : Effect.void,
            ),
          );
      /**
       * Answers a reviewed execution's failure the agent can act on: a review deny or outage, a
       * retention failure, the host's own unavailability, or what `executionFailed` picks out.
       */
      const executionFailureFeedback =
        (executionFailed: (error: MintFailure) => boolean) =>
        <A, R>(execution: Effect.Effect<A, MintFailure, R>) =>
          execution.pipe(
            Effect.catchIf((error) => error.code === "ReviewDenied", reviewFeedback),
            Effect.catchIf(
              (error) => error.code === "ReviewUnavailable",
              reviewUnavailableRetry("execution", reviewUnavailableFeedback),
            ),
            Effect.catchIf(
              (error) => error.diagnosticRetentionReason !== undefined,
              diagnosticUnavailableFeedback,
            ),
            Effect.catchIf(
              (error) =>
                dependencies.executionAvailability?.() === "host_unavailable" ||
                unavailableExecutionHost(error) ||
                executionFailed(error),
              executionFeedback,
            ),
          );
      const command = (command: string) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            if (effectQuestion) return yield* new MintFailure({ code: "ScopeDenied" });
            yield* active();
            const evidence = yield* reviewedExecution({
              purpose: "command",
              target: "pureFiles",
              command,
            });
            record(evidence, "command");
            return yield* visible(evidence);
          }).pipe(
            executionFailureFeedback(
              (error) => error.execution !== undefined || error.authentication !== undefined,
            ),
          ),
        );
      const workspace = yield* Effect.try({
        try: () =>
          makeMintWorkspace(dependencies, command, runTool, (run) =>
            runTool(
              serial.withPermits(1)(
                active("publication").pipe(
                  Effect.zipRight(Effect.promise(run).pipe(Effect.uninterruptible)),
                ),
              ),
            ),
          ),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "makeMintWorkspace",
              error,
            }),
            code: "Unavailable",
          }),
      });
      const session = effectQuestion ? questionOnlyWorkspace(workspace) : workspace;
      // A host-enforced question turn authorizes no execution, source read or publication.
      const questionOnly = effectQuestion || Boolean(dependencies.capabilityQuestion);
      let captchaChecks = recovered?.captchaChecks ?? 0;
      /**
       * Why the agent may not end blocked now, as its tool result, or undefined. Something it can
       * still get past is not impossible as asked, and the screened explanation keeps its bound,
       * which screening's longer markers can break, so a takeover's checkpoint still reads it.
       */
      const blockedRefusal = (screenedExplanation: string) => {
        const refused = (reason: string, instruction: string) =>
          JSON.stringify({
            status: "blocked_refused",
            reason,
            userInputRequired: false,
            instruction,
          });
        if (unresolvedSignIn !== undefined)
          return refused(
            "sign_in_unresolved",
            "The last sign-in failed and is unresolved. Resolve it as its result says, with authenticate once its cause is fixed, before deciding the task is impossible as asked.",
          );
        if (reviewOutageStartedAt !== undefined)
          return refused(
            "review_unavailable_pending",
            "A Guardian review was unavailable and may be resubmitted. Submit that same call again first; an unavailable review is not a reason the task is impossible.",
          );
        if (screenedExplanation.length > blockedExplanationLimit)
          return refused(
            "explanation_too_long",
            "Private values in the explanation made it longer than 500 characters once screened. Shorten it, leave private values out, and call report_blocked again.",
          );
        return undefined;
      };
      /**
       * Guardian's question review of a blocked explanation before any caller reads it. Only
       * `allow_business` shows it; a reword or a review that did not complete leaves the reason's
       * fixed sentence alone, never the agent's words.
       */
      const reviewBlockedExplanation = (explanation: string) =>
        dependencies.reviewQuestion === undefined
          ? Effect.succeed("unavailable" as const)
          : dependencies
              .reviewQuestion(
                { questions: [{ id: "blocked", type: "text", prompt: explanation }] },
                { blockedOutcome: true },
              )
              .pipe(
                Effect.tap(() => reviewCompleted),
                Effect.map((review) => review.outcome),
                // The build still ends blocked: the failure is recorded, and the caller reads
                // the reason alone.
                Effect.catchAll((error) =>
                  diagnose({
                    phase: "blocked_review",
                    code: error.code,
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  }).pipe(Effect.as("unavailable" as const)),
                ),
              );
      const actions: MintActions = {
        retainCapture: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active();
              const submitted = yield* decode(CaptureRequest, input);
              if ((submitted.kind === "full") !== (submitted.requestId === null))
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (!dependencies.retainCapture)
                return yield* new MintFailure({ code: "CaptureUnavailable" });
              return yield* dependencies.retainCapture(submitted);
            }),
          ),
        readSource: (path, range) =>
          questionOnly
            ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
            : Effect.tryPromise({
                try: async () => {
                  const relative = relativeSourcePath(path);
                  const offset = range?.offset ?? 0;
                  const limit =
                    range?.limit ?? (relative.startsWith("captures/") ? 24_000 : undefined);
                  if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    (limit !== undefined &&
                      (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000))
                  )
                    throw new MintFailure({ code: "InvalidRequest" });
                  // This attempt's own capture the workspace does not hold is not saved yet, not
                  // refused. Another attempt's retained capture keeps its read's own result.
                  const own = dependencies.reportCorrelation;
                  if (
                    own !== undefined &&
                    relative.startsWith(`captures/${own.jobId}/attempts/${own.attemptId}/`) &&
                    !(await session.pathExists?.(relative))
                  )
                    throw new MintFailure({
                      code: "CaptureUnavailable",
                      reason: "capture_not_saved",
                    });
                  // Screen the complete source before slicing so partial secrets cannot evade screening.
                  let result: unknown;
                  try {
                    result = await session.readFile?.({ path: relative });
                  } catch (error) {
                    // The index and route summary arrive with the first published capture. Only a
                    // failed read counts, so a maintenance mint's retained index still reads.
                    if (
                      (relative === "captures/index.json" || relative === "captures/routes.json") &&
                      !(await session.pathExists?.("captures/index.json"))
                    )
                      throw new MintFailure({
                        code: "CaptureUnavailable",
                        reason: "capture_not_saved",
                      });
                    throw error;
                  }
                  if (typeof result !== "string") throw new MintFailure({ code: "Unavailable" });
                  if (offset > result.length) throw new MintFailure({ code: "InvalidRequest" });
                  const end =
                    limit === undefined ? result.length : Math.min(result.length, offset + limit);
                  return JSON.stringify({
                    kind: "untrusted_source",
                    path: relative,
                    source: result.slice(offset, end),
                    offset,
                    total: result.length,
                    offsetUnit: "UTF-16 code units",
                    nextOffset: end < result.length ? end : null,
                  });
                },
                catch: (error) =>
                  error instanceof MintFailure && error.reason === "capture_not_saved"
                    ? error
                    : new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "session.readFile",
                          error,
                          context: { path, offset: range?.offset, limit: range?.limit },
                        }),
                        code: "ScopeDenied",
                      }),
              }),
        execute: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              // Once sign-in is unavailable, another authenticate gets the same answer.
              if (
                signInUnavailable !== undefined &&
                Schema.is(Schema.Struct({ purpose: Schema.Literal("authenticate") }))(input)
              )
                return signInUnavailable.answer;
              yield* active();
              const submitted = yield* decode(ExecutionRequest, input);
              yield* Effect.try({
                try: () => relativeSourcePath(submitted.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: submitted.entrypoint,
                        purpose: submitted.purpose,
                        target: submitted.target,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              });
              if (submitted.target === "liveBrowser" && submitted.maxWorkers !== 1)
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (submitted.purpose === "example" && exampleClaimed && !repeatableRead)
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              if (
                submitted.purpose === "act" &&
                (writeSession === "closed" || (writeSession === "none" && exampleClaimed))
              )
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              const availability = yield* dependencies
                .preflight(submitted)
                .pipe(
                  Effect.tapError((error) => diagnoseExecution(submitted, { code: error.code })),
                );
              if (!availability.supported) {
                const evidence: ExecutionEvidence = {
                  executionId: randomUUID(),
                  status: "unsupported",
                  effect: "not_sent",
                  ...(submitted.purpose === "example"
                    ? { preflight: "rejected_before_claim" as const }
                    : {}),
                  observations: availability.reason,
                };
                yield* diagnoseExecution(submitted, {
                  status: evidence.status,
                  reason: availability.reason,
                });
                record(evidence, submitted.purpose);
                return yield* visible(evidence);
              }
              if (submitted.purpose === "residual") yield* dependencies.authorizeResidual;
              if (submitted.purpose === "authenticate") unresolvedSignIn = undefined;
              const effectful =
                submitted.purpose === "example" ||
                submitted.purpose === "act" ||
                submitted.purpose === "residual";
              let crossedDispatchBoundary = false;
              const evidence = yield* reviewedExecution(
                submitted,
                Effect.sync(() => {
                  crossedDispatchBoundary = true;
                }),
              ).pipe(
                Effect.onExit((result) =>
                  Effect.sync(() => {
                    if (
                      (!effectful && submitted.purpose !== "authenticate") ||
                      Exit.isSuccess(result)
                    )
                      return;
                    // A defect or interruption can occur after dispatch just like a typed failure.
                    const reviewPreventedExecution =
                      Cause.isFailType(result.cause) &&
                      (result.cause.error.code === "ReviewDenied" ||
                        (result.cause.error.code === "ReviewUnavailable" &&
                          result.cause.error.reviewDispatch === "not_sent"));
                    record(
                      {
                        executionId: `unresolved_${randomUUID()}`,
                        status: "failed",
                        effect:
                          submitted.purpose === "example" || submitted.purpose === "act"
                            ? crossedDispatchBoundary
                              ? "possible"
                              : "not_sent"
                            : reviewPreventedExecution || submitted.purpose === "authenticate"
                              ? "not_sent"
                              : "possible",
                        ...(submitted.purpose === "authenticate" && !reviewPreventedExecution
                          ? {
                              authentication: {
                                state: "failed" as const,
                                // Possible only while the sign-in's outcome is unknown.
                                effect:
                                  Cause.isFailType(result.cause) &&
                                  (result.cause.error.code === "CredentialsRejected" ||
                                    (result.cause.error.authentication !== undefined &&
                                      signInFailureFeedback(result.cause.error.authentication)
                                        .signInOutcome === "signed_out"))
                                    ? ("verified" as const)
                                    : ("possible" as const),
                              },
                            }
                          : {}),
                        observations:
                          "Execution did not produce a result. Reconcile using the host's durable execution journal.",
                      },
                      submitted.purpose,
                    );
                  }),
                ),
              );
              return yield* executionResult(evidence, submitted.purpose);
            }).pipe(
              // The owner never answered a sign-in request: the build ends as no_response.
              Effect.catchIf(
                (error) => error.noResponse !== undefined && !stopUnavailableHost(),
                (error) => unanswered(error, "signing in to the website"),
              ),
              // The host already asked for a correction in place, and the site refused it too.
              Effect.catchIf(
                (error) => error.code === "CredentialsRejected",
                (error) => {
                  terminal ??= {
                    build: "incomplete",
                    rejectedCredential: error.rejectedCredential ?? "password",
                    summary:
                      "The website rejected a sign-in value and the bounded correction flow ended. No build was published. Recorded effects and receipts are preserved.",
                  };
                  return Effect.succeed(
                    JSON.stringify({
                      status: "credentials_rejected",
                      field: error.rejectedCredential ?? "password",
                      userInputRequired: false,
                      instruction:
                        "The website rejected the login again after the host asked for a correction. The host is ending this build; never ask for credentials yourself.",
                    }),
                  );
                },
              ),
              executionFailureFeedback(
                (error) =>
                  screenedRunnerFailure(error) !== undefined ||
                  screenedCaptureGap(error) !== undefined ||
                  error.execution !== undefined ||
                  error.authentication !== undefined ||
                  error.spentSignIn !== undefined ||
                  error.reason === "login_in_use",
              ),
            ),
          ),
        finish: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active("publication");
              const proposed = yield* decode(PublicationRequest, input);
              yield* Effect.try({
                try: () => relativeSourcePath(proposed.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: proposed.entrypoint,
                        executionId: proposed.executionId,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              });
              const evidence = executions.find(
                (entry) => entry.executionId === proposed.executionId,
              );
              const repair = dependencies.canPublishRepair?.(proposed.executionId) === true;
              // The step that read the site's confirmation publishes its session even when its
              // own output failed: the write happened once, and publication never runs it again.
              const confirmedWrite =
                evidence !== undefined &&
                purposes.get(evidence.executionId) === "act" &&
                evidence.confirmation !== undefined;
              if (
                !evidence ||
                (!repair &&
                  !confirmedWrite &&
                  (evidence.status !== "completed" || !evidence.resultRef)) ||
                purposes.get(evidence.executionId) === "authenticate" ||
                purposes.get(evidence.executionId) === "test" ||
                purposes.get(evidence.executionId) === "command" ||
                // A write maintenance's inspection or residual step is its repair receipt.
                (!repair &&
                  (purposes.get(evidence.executionId) === "inspect" ||
                    purposes.get(evidence.executionId) === "residual"))
              ) {
                const reason = !evidence
                  ? "missing_receipt"
                  : evidence.status !== "completed"
                    ? "receipt_incomplete"
                    : !evidence.resultRef
                      ? "missing_protected_result"
                      : "wrong_execution_purpose";
                yield* diagnose({
                  phase: "publication",
                  code: "PublicationUnavailable",
                  reason,
                });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  executionContext: yield* executionContext(),
                });
              }
              const coverage = yield* screenMintText(dependencies, proposed.coverage);
              const assumptions = yield* screenAssumptions(proposed.assumptions);
              const publication = yield* dependencies
                .publish(
                  {
                    entrypoint: proposed.entrypoint,
                    executionId: proposed.executionId,
                    metadata: proposed.metadata,
                    coverage,
                  },
                  evidence,
                )
                .pipe(Effect.either);
              if (publication._tag === "Right" || reviewDecided(publication.left))
                yield* reviewCompleted;
              const denial = publication._tag === "Left" ? publication.left.review : undefined;
              const deniedCategory = denial?.findings?.[0]?.category;
              publicationDenial =
                publication._tag === "Left" && publication.left.code === "ReviewDenied"
                  ? {
                      ...(denial?.reason === undefined ? {} : { reason: denial.reason }),
                      ...(deniedCategory === undefined ? {} : { category: deniedCategory }),
                    }
                  : undefined;
              const publicationDiagnostics =
                publication._tag === "Right"
                  ? publication.right.diagnostics
                  : (publication.left.publicationDiagnostics ?? []);
              for (const gap of publicationDiagnostics) {
                const diagnostic = JSON.stringify(gap);
                if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
              }
              if (publication._tag === "Left") {
                const error = publication.left;
                const outputUnavailable =
                  error.code === "PublicationUnavailable" &&
                  error.reason === "example_output_unavailable";
                if (outputUnavailable) unavailableOutputRefusals++;
                // Each refusal permits one fresh verified example; a third unavailable output, or
                // an example that cannot be repeated, is an infrastructure failure.
                const outputUnrecoverable =
                  outputUnavailable &&
                  (!repeatableRead ||
                    executionClosed ||
                    unavailableOutputRefusals > maximumUnavailableOutputReruns);
                const hostUnavailable =
                  stopUnavailableHost() ||
                  outputUnrecoverable ||
                  error.code === "CaptureUnavailable" ||
                  (error.code === "PublicationUnavailable" &&
                    (error.reason === "executor_unavailable" ||
                      error.reason === "registry_publication"));
                if (hostUnavailable)
                  terminal = {
                    build: "incomplete",
                    hostFailure: "publication_unavailable",
                    summary: outputUnrecoverable
                      ? "The host could not read the retained output of a verified example, so publication review had nothing to judge. The existing execution outcomes remain recorded."
                      : error.code === "CaptureUnavailable"
                        ? "Publication ended incomplete because live capture is unavailable, so the capture evidence publication requires could not be completed. The existing execution outcomes and protected results remain retained."
                        : "Publication infrastructure is unavailable. The existing execution outcomes and protected results remain retained independently of future code publication.",
                  };
                // Screening serializes through JSON, which leaves out undefined fields.
                const diagnostic = yield* screenMintText(dependencies, {
                  phase: "publication",
                  code: error.code,
                  reason: error.reason,
                  screening: error.screening,
                  publicationBlock: error.publicationBlock,
                  destinationEvidenceGap: error.destinationEvidenceGap,
                  ...(error.review === undefined
                    ? {}
                    : {
                        review: {
                          ...error.review,
                          rationale: yield* screenRationale(error.review.rationale),
                        },
                      }),
                  reviewPhase: error.reviewPhase,
                  reviewFailure: error.reviewFailure,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                }).pipe(Effect.either);
                if (diagnostic._tag === "Right") diagnostics.push(diagnostic.right);
                if (error.code === "ReviewUnavailable")
                  return yield* reviewUnavailableRetry(
                    "publication",
                    reviewUnavailableFeedback,
                  )(error);
                if (
                  error.reason === "registry_invalid_definition" ||
                  error.reason === "registry_conflict" ||
                  publicationOutage(error)
                )
                  return yield* registryFeedback(error);
                if (hostUnavailable)
                  return JSON.stringify({
                    status: "publication_unavailable",
                    code: error.code,
                    ...availabilityMetadata(),
                    reason: outputUnrecoverable ? "example_output_unrecoverable" : error.reason,
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    userInputRequired: false,
                    instruction:
                      "Publication infrastructure is unavailable. End this attempt without retrying finish_build or execution. Preserve all existing receipts and protected results; source edits or a fabricated user question cannot restore this dependency.",
                  });
                if (error.code !== "PublicationUnavailable" && error.code !== "ReviewDenied")
                  return yield* error;
                // Input feedback never fails the mint: the minter gets bounded rounds to fix it,
                // then the last reviewed candidate publishes privately and flagged.
                if (error.review?.reason === "input_feedback") {
                  inputFeedbackRounds++;
                  inputFeedbackCoverage = coverage;
                  const privateFallback = dependencies.inputFeedbackFallback?.kept() === true;
                  inputFeedbackPublicTool =
                    dependencies.inputFeedbackFallback !== undefined && !privateFallback;
                  if (inputFeedbackRounds <= maximumInputFeedbackRounds)
                    return notPublished(
                      error.code,
                      "input_feedback",
                      {
                        findings: error.review.findings ?? [],
                        rationale: yield* screenRationale(error.review.rationale),
                        reviewId: error.review.reviewId,
                        feedbackRoundsRemaining: maximumInputFeedbackRounds - inputFeedbackRounds,
                      },
                      inputFeedbackInstruction(maximumInputFeedbackRounds - inputFeedbackRounds, {
                        write: buildEffect === "write",
                        privateFallback,
                      }),
                    );
                  if (yield* settleUnresolvedInputFeedback)
                    return "Build published for this account only and flagged with Guardian's unresolved input feedback. The current invocation outcome is returned separately; do not execute again.";
                  terminal ??= { build: "incomplete", summary: unresolvedInputFeedbackSummary() };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: "input_feedback_unresolved",
                    userInputRequired: false,
                    instruction: "Nothing was published. End this attempt; do not execute again.",
                  });
                }
                // Every finding is in a file the host wrote, which no edit of the minter's changes
                //: it stops and reports rather than resubmitting unchanged.
                if (error.review?.reason === "host_owned")
                  return notPublished(
                    error.code,
                    "host_owned",
                    {
                      findings: error.review.findings ?? [],
                      rationale: yield* screenRationale(error.review.rationale),
                      reviewId: error.review.reviewId,
                    },
                    "Not published: every finding is in a host-owned file, which cannot be fixed from source. Do not edit source for it, run anything again or call finish_build unchanged. Stop and report the findings and Guardian's rationale in your final answer.",
                  );
                // A gate refusal names its file and what matched there. It is the minter's to fix,
                // never a review outage to retry.
                if (error.publicationBlock !== undefined) {
                  const feedback = publicationBlockFeedback(error.publicationBlock);
                  // The file goes out as the minter knows it, under `file` below.
                  const block = Object.fromEntries(
                    Object.entries(error.publicationBlock).filter(([key]) => key !== "file"),
                  );
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      file: feedback.file,
                      ...block,
                      retryable: false,
                      fixRequired: feedback.fixable,
                    },
                    feedback.instruction,
                  );
                }
                // Nothing to publish ends the repair here, so no continuation prompt asks for an edit.
                if (error.reason === "repair_unchanged") {
                  terminal ??= {
                    build: "incomplete",
                    summary:
                      "The repair changed none of the registered revision's source, so nothing was published and the registered revision stays current. Recorded effects and receipts are preserved.",
                  };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: error.reason,
                    userInputRequired: false,
                    instruction:
                      "Not published: the source this repair would publish is byte for byte the registered revision's, so there is nothing to publish. A new name or description alone is not a repair. The registered revision stays current and this repair ends here; do not call finish_build again.",
                  });
                }
                if (error.reason === "tool_name_taken")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published and not reviewed: ${registryRefusal("tool_name_taken").instruction}`,
                  );
                if (error.reason === "site_metadata_required")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published and not reviewed: this is the first tool of this site's integration, which takes its name from this publication. Add siteName, the site's everyday name as people say it (such as Google Flights, 1 to 60 characters), and siteSummary, one sentence on what the site is, not what this tool does (1 to 160 characters), to finish_build's metadata, and call finish_build again with the same executionId. Both are public: write them from what the site shows anyone, never from this account or session.",
                  );
                if (error.reason === "variants_unsupported")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: this Kernel script declares supportedVariants, and only Effect runs dispatch variants, so every call would fail with InvalidOutput. Either remove supportedVariants from the tool's metadata (keep one script that handles the variation itself) and call finish_build again with the same executionId; the recorded example and result stay valid and nothing needs to run again. Or, if variants are essential, make it an offline tool: execute a new example with target pureFiles, then call finish_build with that new executionId. The same executionId is refused again while its receipt is a Kernel script.",
                  );
                if (
                  error.reason === "http_implementation_untested" ||
                  error.reason === "http_implementation_stale"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    (error.reason === "http_implementation_stale"
                      ? "Not published yet: src/tool-http.mjs changed since its last passing live test, and a test counts only for the source it ran. Run execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs on the current file, or restore the version that passed, then call finish_build again with the same executionId."
                      : "Not published yet: this read has no HTTP implementation that passed a live test, so try one once. Read .agents/http-mcp/SKILL.md, write src/tool-http.mjs from captures/routes.json and the example, and run execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs. Iterate until its output matches the example's, then call finish_build again with the same executionId.") +
                      " To publish the Playwright version alone instead, delete src/tool-http.mjs, say why in coverage and call finish_build again. The host asks only once, only while live capture is open, and never after you delete a src/tool-http.mjs you ran.",
                  );
                if (error.reason === "login_url_one_time")
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published yet: the login URL this tool would publish (the loginUrl you passed to authenticate, or the page the browser was on when you passed none) is one authorization request: an identity provider's authorize URL, or a URL carrying one-time authorization values (oneTimeParameters names the authorize path and those values). They are spent once this sign-in ends, so later runs that reopen it would start from stale values. The host changed nothing. Navigate the browser to the site's stable sign-in entry, the page a person would bookmark or the site's own login link before it redirected, run authenticate again with that page's address as loginUrl, then call finish_build again with the same executionId. If no stable entry exists, call finish_build again and the host publishes the URL as it is, flagged. The host asks only once.",
                  );
                if (
                  error.reason === "login_url_contains_credential" ||
                  error.reason === "metadata_contains_credential"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published: each part named in parts holds a registered credential (credentialKinds names the kind, never the value). A published tool never carries one, and the host changes nothing itself. For loginUrl, run authenticate again with a login URL that has no credential in it, the site's plain sign-in page. For name, description, siteName or siteSummary, rewrite the text without it. Then call finish_build again with the same executionId. The host refuses every time until the credential is gone; the build is not over.",
                  );
                if (error.reason === "definition_login_reference") {
                  const section = error.screening?.section;
                  return notPublished(
                    error.code,
                    error.reason,
                    { section },
                    `Not published: the tool's ${section ?? "definition"} quotes this build's account reference, an opaque value the host gave this build to identify its login (such as an inspection's accountScope). It means nothing to a caller and is never published. ${definitionFix(section)} The existing example and result remain recorded.`,
                  );
                }
                if (error.reason === "secret_handle") {
                  const path = error.screening?.path ?? "the source";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path },
                    `Not published: ${path} holds a {{secret.…}} handle. A handle works only in this build's own executions, where the host fills in the caller's answer; published code never holds a handle or a value. Declare the value as a secret question in the operation's questions and read it with ask at run time, as .agents/caller-input/SKILL.md shows, then call finish_build again.`,
                  );
                }
                if (
                  error.reason === "session_token_literal" ||
                  error.reason === "session_token_placeholder"
                ) {
                  const path = error.screening?.path ?? "the source";
                  const placeholder = error.reason === "session_token_placeholder";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path, section: error.screening?.section },
                    placeholder
                      ? `Not published: ${path} still reads [session token withheld] where an earlier release withheld a live token, so it no longer matches what ran. Do not paste a token back in: edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded.`
                      : error.screening?.section === "loginUrl"
                        ? "Not published: the login URL holds a literal session token observed during sign-in. Run authenticate again with the site's stable sign-in page URL, without the token, then call finish_build again with the same executionId. The host keeps the URL unchanged for your HTTP work and does not end this build."
                        : `Not published: ${path} holds a literal session token from captures/session-tokens.json. Published code never contains a token. Edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded. Your workspace keeps the token for your own HTTP work. If the file is src/tool-http.mjs, run its live test again first, because the edit invalidates the last one.`,
                  );
                }
                if (error.reason === "confirm_action_unmatched")
                  return notPublished(
                    error.code,
                    error.reason,
                    { confirmActionIds: error.confirmActionIds ?? [] },
                    "Not published: the session accepted confirm popups reported to decideDialog under these step names, and the composed script does not report them under the same names. Reuse each step literal exactly, for example by importing the step's helper, so runs accept the same popups without asking; then call finish_build again with the same executionId. Never run the write again.",
                  );
                if (error.reason === "write_not_submitted")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: no act step of this build's session recorded a confirmation, sent a non-read request or entered a commit mark. A commit that check cannot see, such as a GET link or a websocket message, may still have run. Read back first, in an act step that reads the page or the account. If the write happened, record it with verified() in that step and call finish_build naming it. If the read-back shows it did not happen, submit it once with the caller's values, marking its commit step, and read its confirmation (a step that only filled the form, or an offline example, never submitted it). If the site offers no read-back that can tell, never submit again: publish the write as unverifiable against the step that could have committed.",
                  );
                if (
                  error.reason === "confirmation_undeclared" ||
                  error.reason === "commit_marks_undeclared" ||
                  error.reason === "commit_marks_unentered" ||
                  error.reason === "confirmation_unrecorded" ||
                  error.reason === "contract_input_mismatch" ||
                  error.reason === "contract_output_mismatch"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    error.reason === "contract_input_mismatch" && error.inputIssues !== undefined
                      ? { inputIssues: error.inputIssues }
                      : {},
                    (error.reason === "confirmation_undeclared"
                      ? "Not published: the composed script declares no write confirmation. Add write: {confirmation: 'message' | 'readback' | 'unverifiable'} to its defineOperation, matching what the session read, and call finish_build again with the same executionId."
                      : error.reason === "commit_marks_undeclared"
                        ? "Not published: the composed script names none of its commit steps. List every step that can change the site (an autosave, a saved form step, the final submit) in order as write.commits, such as commits: ['save-address', 'place-order'], using short lowercase hyphenated names, and mark each with the context's enteringCommit(name) right before the execute call that can send it (an HTTP implementation calls journal.enteringCommit(name) before that request). Then call finish_build again with the same executionId."
                        : error.reason === "commit_marks_unentered"
                          ? "Not published: the composed script declares a commit step that no act step of the session entered, so nothing shows its marks follow the real commit. Declare exactly the marks the session's act steps entered, marked by the same helper the composed script uses, and call finish_build again with the same executionId. If the session's steps entered none, it cannot publish: never run the write again for this; end the build and say its commit steps were not marked."
                          : error.reason === "confirmation_unrecorded"
                            ? "Not published: the declared write confirmation does not match the session. Name the act step that recorded the declared confirmation, or declare what the session actually read; a session that recorded a confirmation is never unverifiable. Then call finish_build again."
                            : error.reason === "contract_input_mismatch"
                              ? `Not published: the script's input schema rejects the input the example or session ran: the caller's own, or the exampleInput you passed when the caller's was empty (in maintenance, the original invocation's).${inputIssueText(error.inputIssues)} Correct the schema, or the code that reads that input, so this input decodes, then call finish_build again with the same executionId. Keep each input the tool needs required; make one optional only when the tool can work without it.`
                              : "Not published: the script's output schema rejects the output this read's example returned. Correct the schema so that output decodes: a field the example did not return must be optional or removed. Then call finish_build again with the same executionId.") +
                      " The host extracts the contract offline; never run the write or the example again for this.",
                  );
                if (error.reason === "destination_validation") {
                  // Publication uses the route evidence the host recorded while the example ran.
                  // Source edits and another finish_build on the same receipt cannot change it,
                  // so only one fresh reviewed read gets a chance before the attempt ends.
                  destinationEvidenceRefusals++;
                  const freshRead =
                    repeatableRead && !executionClosed && destinationEvidenceRefusals === 1;
                  if (!freshRead)
                    terminal = {
                      build: "incomplete",
                      summary:
                        "Publication could not use the route evidence the host recorded for the example, and no fresh example can replace it in this attempt. The existing execution outcomes and protected results remain retained.",
                    };
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      destinationEvidenceGap: error.destinationEvidenceGap,
                      repeatableRead: freshRead,
                    },
                    "Not published: publication uses the route evidence the host recorded while this example ran. " +
                      destinationEvidenceInstruction[error.destinationEvidenceGap ?? "unknown"] +
                      " Source edits and another finish_build against this executionId cannot change it. " +
                      (freshRead
                        ? "Run one fresh reviewed execute with purpose example of the same source under the original input/account/budget, restoring the sign-in's login URL first if it changed, then call finish_build with the new executionId. Another refusal ends this attempt."
                        : "No fresh example can replace it in this attempt, which ends here. Preserve the recorded receipt."),
                  );
                }
                if (outputUnavailable)
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      rerunsRemaining: maximumUnavailableOutputReruns - unavailableOutputRefusals,
                      repeatableRead: true,
                    },
                    "Not published and not reviewed: the host could not read the retained output of this example, so there was nothing to judge. Run a fresh reviewed execute with purpose example of the same source under the original input/account so its result is retained, then call finish_build with that new executionId. Do not edit source for this reason. This is bounded; another unavailable output after the remaining re-runs ends publication.",
                  );
                return notPublished(
                  error.code,
                  error.reason,
                  {
                    expectedEntrypoint: error.expectedEntrypoint,
                    ...(error.review === undefined
                      ? {}
                      : {
                          review: {
                            ...error.review,
                            rationale: yield* screenRationale(error.review.rationale),
                          },
                        }),
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    repeatableRead,
                  },
                  "Not published. The existing example and result remain recorded. Source edits and another finish_build publication review may continue; this does not guarantee the failure is repairable. A fresh reviewed example read requires an available live host and host repeatableRead:true within the same input/account after confirmed executor cleanup. Otherwise never repeat the example or a write step that may have committed.",
                );
              }
              return yield* publicationResult(publication.right, coverage, assumptions);
            }),
          ),
        // One open request at a time: the execution permit is held while the caller decides.
        requestInput: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              // Asking needs no live execution: it stays open after execution closed and while a
              // write's outcome is uncertain. The agent still verifies before writing again.
              yield* active("publication");
              const { writeUpgrade, ...proposed } = callerVisibleRequest(
                yield* decode(AgentRequest, input),
                redactCallerText,
              );
              const upgrade = writeUpgrade === true;
              const submitted =
                upgrade || effectQuestion
                  ? { ...proposed, questions: withEffectAnswerLabels(proposed.questions) }
                  : proposed;
              const refusal = requestShapeRefusal(submitted, upgrade);
              if (refusal !== undefined)
                return JSON.stringify({
                  status: "question_refused",
                  reason: refusal.reason,
                  userInputRequired: false,
                  instruction: refusal.instruction,
                });
              if (!dependencies.askInput)
                return yield* new MintFailure({
                  code: "Unavailable",
                  reason: "executor_unavailable",
                });
              // The effect question offers two fixed answers and the capability question is the
              // host's own, so neither can collect private data; the agent's own requests are
              // reviewed before the caller sees them.
              let reviewId: string | undefined;
              // One id from proposal on: its review, the request the caller sees and its end.
              const requestId = randomUUID();
              if (!effectQuestion && dependencies.capabilityQuestion === undefined) {
                if (!dependencies.reviewQuestion)
                  return yield* new MintFailure({
                    code: "ReviewUnavailable",
                    reviewFailure: "Unavailable",
                  });
                const review = yield* dependencies.reviewQuestion(submitted, {
                  requestId,
                  ...(upgrade ? { writeUpgrade: true as const } : {}),
                });
                yield* reviewCompleted;
                reviewId = review.reviewId;
                // When the question came relative to the work before it, without reading the
                // model's reasoning: how much ran first and whether sign-in was tried.
                const priorPurposes = [...purposes.values()];
                yield* reportBestEffort(
                  dependencies.diagnostics?.emit("mint.input_requested", {
                    requestId,
                    ...(reviewId === undefined ? {} : { reviewId }),
                    questionCount: submitted.questions.length,
                    reviewOutcome: review.outcome,
                    priorExecutions: priorPurposes.length,
                    priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent")
                      .length,
                    ...(priorPurposes.at(-1) === undefined
                      ? {}
                      : { lastExecutionPurpose: priorPurposes.at(-1) }),
                    authenticateAttempted: priorPurposes.includes("authenticate"),
                    ...(upgrade ? { writeUpgrade: true } : {}),
                  }) ?? Effect.void,
                  {
                    component: "mint",
                    operation: "diagnostics.emit",
                    phase: "mint.input_requested",
                    correlation: dependencies.reportCorrelation ?? "process",
                  },
                );
                const rationale = yield* screenMintText(dependencies, review.rationale);
                // A write upgrade never asks for a login, so a login verdict means reword it.
                if (review.outcome === "authentication" && !upgrade) {
                  const login = dependencies.requestLogin
                    ? yield* dependencies.requestLogin()
                    : ("unavailable" as const);
                  if (login === "in_use")
                    return JSON.stringify({
                      status: "login_request",
                      login,
                      code: loginInUseAnswer.code,
                      ...loginInUseAnswer.fields,
                      rationale,
                      userInputRequired: false,
                      instruction: loginInUseAnswer.notice,
                    });
                  return JSON.stringify({
                    status: "login_request",
                    login,
                    rationale,
                    userInputRequired: false,
                    instruction: loginRequestInstruction(login),
                  });
                }
                if (review.outcome !== "allow_business")
                  return JSON.stringify({
                    status: "question_rejected",
                    rationale,
                    userInputRequired: false,
                    instruction:
                      "Reword the question using the rationale, or withdraw it and continue. Do not ask again for a value you were already given or that the site shows. A reworded question is reviewed again.",
                  });
              }
              const answers = yield* dependencies.askInput(submitted, {
                requestId,
                ...(reviewId === undefined ? {} : { reviewId }),
              });
              if (upgrade) return yield* answerWriteUpgrade(submitted, answers);
              return yield* inputResult(submitted, answers);
            }).pipe(
              Effect.catchIf(
                (error) => error.noResponse !== undefined,
                (error) => unanswered(error, "asking a question"),
              ),
              // error-reporting-allow: typed-recovery an invalid request is the model's to correct, told as its result
              Effect.catchIf(
                (error) => error.code === "InvalidRequest",
                () =>
                  Effect.succeed(
                    JSON.stringify({
                      status: "question_invalid",
                      userInputRequired: false,
                      instruction:
                        "The request was not valid: use unique lowercase question ids, unique option ids, at most eight questions and selection bounds that fit the options. Correct it and ask again.",
                    }),
                  ),
              ),
              Effect.catchIf(
                (error) => error.code === "ReviewUnavailable",
                (error) =>
                  diagnose({
                    phase: "question_review",
                    code: error.code,
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  }).pipe(
                    Effect.zipRight(
                      reviewUnavailableRetry("question", () =>
                        Effect.sync(() => {
                          terminal ??= {
                            build: "incomplete",
                            hostFailure: "review_unavailable",
                            summary:
                              "The proposed question could not be reviewed. No user input request was created; prior execution outcomes remain retained.",
                          };
                          return JSON.stringify({
                            status: "question_review_unavailable",
                            code: "ReviewUnavailable",
                            userInputRequired: false,
                            instruction:
                              "Question review is unavailable. End this attempt; do not ask the question in prose or resubmit execution.",
                          });
                        }),
                      )(error),
                    ),
                  ),
              ),
            ),
          ),
        // The minter's own ending for a task impossible as asked: a
        // terminal outcome distinct from failure, with a typed reason and a screened explanation
        // its caller reads. It runs nothing and holds the permit only to order it with the rest.
        ...(questionOnly
          ? {}
          : {
              reportBlocked: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active("publication");
                    const submitted = yield* decode(BuildBlocked, input);
                    const explanation = redactCallerText(
                      yield* screenMintText(dependencies, submitted.explanation),
                    );
                    const refusal = blockedRefusal(explanation);
                    if (refusal !== undefined) return refusal;
                    const review = yield* reviewBlockedExplanation(explanation);
                    yield* active("publication");
                    const shown = review === "allow_business";
                    const blocked = {
                      reason: submitted.reason,
                      ...(shown ? { explanation } : {}),
                    };
                    terminal = {
                      build: "incomplete",
                      blocked,
                      summary: `The build is blocked (${blocked.reason}): ${explanation}`,
                    };
                    yield* diagnose({
                      phase: "blocked",
                      reason: blocked.reason,
                      explanationReview: review,
                    });
                    return JSON.stringify({
                      status: "blocked",
                      reason: blocked.reason,
                      explanationShown: shown,
                      notice: shown
                        ? "The build ended blocked. Its caller reads the reason and your explanation; nothing more runs in this attempt."
                        : "The build ended blocked. Guardian did not allow your explanation to reach the caller, who reads only the reason's fixed sentence; nothing more runs in this attempt.",
                    });
                  }),
                ),
            }),
        // Read-only provider state. It takes no execution permit, dispatches no browser
        // action and grants no authority; unsupported hosts do not offer the tool.
        ...(dependencies.captchaState === undefined || questionOnly
          ? {}
          : {
              captchaState: (input: unknown) => {
                const read = dependencies.captchaState;
                return Effect.gen(function* () {
                  if (read === undefined) return yield* new MintFailure({ code: "Unavailable" });
                  yield* active();
                  yield* decode(Schema.Struct({}), input);
                  if (captchaChecks >= read.limit)
                    return JSON.stringify({ kind: "host_captcha_state", ...read.exhausted });
                  captchaChecks += 1;
                  const state = yield* read.read();
                  return JSON.stringify({ kind: "host_captcha_state", ...state });
                });
              },
            }),
        // A troubleshooting request for a new browser. It holds the execution permit, so
        // no execution runs while the browser changes, and it is never part of the published tool.
        ...(dependencies.requestBrowserRecovery === undefined || questionOnly
          ? {}
          : {
              requestBrowserRecovery: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    const request = dependencies.requestBrowserRecovery;
                    if (request === undefined)
                      return yield* new MintFailure({ code: "Unavailable" });
                    yield* active();
                    const { rationale } = yield* decode(
                      Schema.Struct({
                        rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
                      }),
                      input,
                    );
                    return JSON.stringify({
                      kind: "host_browser_recovery",
                      ...(yield* request(rationale)),
                    });
                  }),
                ),
            }),
      };
      const hostIncidentsBeforeStart = yield* dependencies.drainStartIncidents?.() ??
        Effect.succeed(undefined);
      const retainRuntimeRecord = dependencies.diagnostics?.retainRuntimeRecord;
      const observeModelTrace = dependencies.diagnostics?.observeModelTrace;
      const captureHarness = (): MintHarnessSnapshot => ({
        executions: [...executions],
        purposes: [...purposes].map(([executionId, purpose]) => ({
          executionId,
          purpose,
        })),
        diagnostics: [...diagnostics],
        ...(example === undefined ? {} : { exampleId: example.executionId }),
        exampleClaimed,
        writeSession,
        unavailableOutputRefusals,
        ...(terminal === undefined ? {} : { terminal }),
        ...(noResponse === undefined ? {} : { noResponse }),
        unavailableCauseRecorded,
        reviewUnavailableRetries: { ...reviewUnavailableRetries },
        ...(reviewOutageStartedAt === undefined ? {} : { reviewOutageStartedAt }),
        destinationEvidenceRefusals,
        inputFeedbackRounds,
        inputFeedbackPublicTool,
        inputFeedbackCoverage,
        providerUnavailableRetries,
        ...(providerOutageStartedAt === undefined ? {} : { providerOutageStartedAt }),
        diagnosticRetentionRetries,
        executionClosed,
        captchaChecks,
        ...(writeUpgradeDeclined ? { writeUpgradeDeclined: true as const } : {}),
        ...(signInUnavailable === undefined ? {} : { signInUnavailable }),
        ...(publicationDenial === undefined ? {} : { publicationDenial }),
      });
      const agentRecovery = dependencies.agentRecovery;
      yield* agentRecovery?.bindHarness?.(captureHarness) ?? Effect.void;
      const modelResult = yield* dependencies.model
        .run({
          runTool,
          ...(agentRecovery === undefined
            ? {}
            : {
                recovery: {
                  ...(agentRecovery.recoverTool === undefined
                    ? {}
                    : {
                        recoverTool: (call) =>
                          Effect.gen(function* () {
                            const recoveredTool = yield* agentRecovery.recoverTool?.(call) ??
                              Effect.succeed(undefined);
                            if (recoveredTool === undefined) return undefined;
                            if (recoveredTool.input !== undefined) {
                              const { request: asked, answers } = recoveredTool.input;
                              // The recovered call is the one the model made, so its arguments
                              // say whether it asked for a write upgrade.
                              const result = yield* isWriteUpgradeCall(call)
                                ? answerWriteUpgrade(asked, answers)
                                : inputResult(asked, answers);
                              return { result: recoveredTool.result ?? result };
                            }
                            if (recoveredTool.publication !== undefined) {
                              const result = yield* publicationResult(
                                recoveredTool.publication.published,
                                yield* screenMintText(
                                  dependencies,
                                  recoveredTool.publication.coverage,
                                ),
                                yield* screenAssumptions(recoveredTool.publication.assumptions),
                              );
                              return { result: recoveredTool.result ?? result };
                            }
                            const execution = recoveredTool.execution;
                            if (execution === undefined) return { result: recoveredTool.result };
                            const result = yield* recoveredExecutionResult(
                              execution.evidence,
                              execution.purpose,
                            );
                            return { result: recoveredTool.result ?? result };
                          }),
                      }),
                  ...(agentRecovery.initial === undefined
                    ? {}
                    : { initial: agentRecovery.initial.agent }),
                  save: (agent) => agentRecovery.save(agent, captureHarness()),
                },
              }),
          ...(effectQuestion ? { effectQuestion: true as const } : {}),
          ...(dependencies.autofillSignIn ? { autofillSignIn: true as const } : {}),
          input: JSON.stringify({
            ...(effectQuestion
              ? { effectQuestion: { instruction: effectQuestionInstruction } }
              : {}),
            screenedRequest: dependencies.capabilityQuestion
              ? {
                  instruction:
                    "Ask exactly this question through request_input as one text question with this prompt. No other action is authorized until the answer is reassessed.",
                  question: dependencies.capabilityQuestion,
                }
              : prompt,
            businessInputTypes,
            site,
            ...changedEntryNotice(),
            ...(dependencies.priorAttemptMayHaveChanged === true
              ? {
                  priorAttempt: {
                    websiteMayHaveChanged: true,
                    instruction: priorAttemptChangeNotice,
                  },
                }
              : {}),
            hostIncidentsBeforeStart,
            executionContext: yield* executionContext(),
            websiteAuthentication: {
              credentialsAvailable: dependencies.websiteCredentialsAvailable === true,
              instruction:
                dependencies.websiteCredentialsAvailable === true
                  ? "Credential values are private host input. After discovering the login entry, use execute purpose authenticate with the observed reusable loginUrl before the business example; it runs Kernel Managed Auth. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host."
                  : "No website credentials are bound to this invocation. If the requested operation works signed out, proceed with its business flow and example without discovering a login or calling authenticate. If the task needs an account or the site presents a login wall, discover the actual login entry and pass it as loginUrl to execute purpose authenticate before dependent business work; the host asks the caller for a login and continues within the same call. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host.",
            },
          }),
          ...(dependencies.deadline ? { deadline: dependencies.deadline } : {}),
          session,
          instructions: dependencies.instructions,
          skills: dependencies.skills,
          ...(dependencies.hostToolDescriptions === undefined
            ? {}
            : { hostToolDescriptions: dependencies.hostToolDescriptions }),
          actions: withHostNotices(
            dependencies.retainCapture === undefined
              ? (({ retainCapture: _capture, ...available }) => available)(actions)
              : actions,
            dependencies.drainHostNotices,
          ),
          screen: (value) => screenMintText(dependencies, value),
          isComplete: () =>
            stopUnavailableHost() ||
            stopRevokedAttempt() ||
            terminal !== undefined ||
            modelStoppedForSignIn,
          reportTrace: (value, timing) => {
            const retained = (
              dependencies.diagnostics?.[timing !== undefined ? "retainModelTranscript" : "emit"](
                "mint.model",
                value,
                timing === undefined
                  ? undefined
                  : {
                      modelTiming: timing,
                      ...(observeModelTrace === undefined ? {} : { lifecycleObserved: true }),
                      // With traced records the readable copy is a projection: it is never
                      // dropped for ordinary diagnostics, and a failed write is a recorded gap.
                      ...(retainRuntimeRecord === undefined ? {} : { required: true }),
                    },
              ) ?? Effect.void
            ).pipe(Effect.mapError(diagnosticUnavailable));
            // A model transcript copy keeps its required durability; any other trace event is
            // diagnosis only, so a failed write is a recorded gap.
            return timing === undefined
              ? retained.pipe(Effect.catchAll(recordDiagnosticGap("mint.model")))
              : retained;
          },
          ...(retainRuntimeRecord === undefined
            ? {}
            : {
                retainRuntimeRecord: (record: RuntimeRecordInput) =>
                  retainRuntimeRecord(record).pipe(Effect.mapError(diagnosticUnavailable)),
              }),
          ...(observeModelTrace === undefined
            ? {}
            : {
                observeTrace: (timing: ModelDiagnosticTiming) => {
                  Effect.runFork(observeModelTrace("mint.model", timing));
                },
              }),
          reportDiagnostic: (value) =>
            screenMintText(dependencies, value).pipe(
              Effect.tap((safe) =>
                Effect.sync(() => {
                  diagnostics.push(safe);
                }),
              ),
              Effect.asVoid,
            ),
          unresolvedGuidance: () =>
            Effect.suspend(() => {
              // Sign-in is unavailable and the model answered without publishing its retained
              // receipt: the model stops here, never after more prompts. Its outcome is settled
              // after the model stops, in the usual order: a flagged input-feedback publication,
              // then the host's own stop, then the sign-in outcome.
              if (signInUnavailable !== undefined) {
                modelStoppedForSignIn = true;
                return Effect.succeed(undefined);
              }
              const pending = unresolvedSignIn;
              if (
                pending === undefined ||
                pending.guided ||
                terminal !== undefined ||
                stopUnavailableHost()
              )
                return Effect.succeed(undefined);
              pending.guided = true;
              return screenMintText(
                dependencies,
                unresolvedSignInGuidance(pending.failure, pending.spent),
              );
            }),
        })
        .pipe(Effect.exit, Effect.ensuring(Scope.close(toolScope, Exit.void)));
      const modelFailure = Exit.isFailure(modelResult)
        ? Option.getOrUndefined(Cause.failureOption(modelResult.cause))
        : undefined;
      if (
        terminal === undefined &&
        (modelFailure?.diagnosticRetentionReason === "storage" ||
          modelFailure?.diagnosticRetentionReason === "serialization")
      ) {
        // A required traced model/tool record could not be retained, so the model adapter
        // blocked further dispatch. Report the storage outcome, not a site or model failure.
        terminal = {
          build: "incomplete",
          hostFailure: "diagnostic_retention",
          summary:
            "Required model trace retention failed, so the host stopped new model and tool work. Preserve recorded effects and receipts; this does not establish a website, browser or model failure.",
        };
        yield* diagnose({
          phase: "model_trace",
          code: modelFailure.code,
          diagnosticRetentionReason: modelFailure.diagnosticRetentionReason,
          diagnosticStorageFailure: modelFailure.diagnosticStorageFailure,
        });
      }
      // A minter that stopped without fixing Guardian's input feedback still publishes its last
      // reviewed candidate, privately and flagged. Publication needs no browser or executor, but
      // an attempt that lost its lease publishes nothing.
      if (terminal === undefined && inputFeedbackRounds > 0 && !stopRevokedAttempt())
        yield* settleUnresolvedInputFeedback;
      // Background traffic can poison the host after the last tool call and completion check.
      // Name that cause instead of the generic stop, but never replace a terminal outcome.
      if (terminal === undefined) stopUnavailableHost(true);
      if (terminal === undefined) stopRevokedAttempt();
      // Sign-in stayed unavailable and the retained receipt never published.
      if (terminal === undefined && signInUnavailable !== undefined)
        terminal = signInUnavailable.outcome;
      // Live execution ended and the model stopped without publishing its retained receipt.
      if (terminal === undefined && executionClosed) terminal = unavailableHostTerminal();
      if (
        terminal === undefined &&
        Exit.isSuccess(modelResult) &&
        modelResult.value.stopReason === "repeated_final_without_tool"
      ) {
        terminal = {
          build: "incomplete",
          summary:
            "The minter kept answering without a tool call after the host asked it to continue, so the host ended this attempt. No build was published. Recorded effects and receipts are preserved.",
        };
        yield* diagnose({ phase: "continuation", reason: "repeated_final_without_tool" });
      }
      if (terminal === undefined && modelFailure?.modelOutage === "quota_exhausted")
        yield* endForSpentModelQuota(modelFailure, "model");
      // The outcome is already decided; its diagnostic copy never blocks returning it.
      yield* dependencies.diagnostics
        ?.emit("mint.model_finished", {
          state: Exit.isSuccess(modelResult) ? "completed" : "failed",
          diagnostics,
          executions,
          ...(dependencies.hostAnomalies === undefined
            ? {}
            : { anomalies: dependencies.hostAnomalies() }),
        })
        .pipe(
          Effect.mapError(diagnosticUnavailable),
          Effect.catchAll(recordDiagnosticGap("mint.model_finished")),
        ) ?? Effect.void;
      const currentInvocation = dependencies.currentInvocation?.();
      finished.build = terminal?.build ?? "incomplete";
      // An unpublished build whose last publication Guardian denied says so, with its reason.
      const denied = finished.build === "incomplete" ? publicationDenial : undefined;
      return {
        ...(terminal ?? {
          build: "incomplete" as const,
          // The provider or the run's record failed, as opposed to the agent running out of
          // calls, turns or time, or choosing to stop.
          ...(modelFailure?.modelOutage === "unavailable"
            ? { hostFailure: "model_unavailable" as const }
            : {}),
          summary:
            denied === undefined
              ? "Minting stopped before publication; inspect recorded execution outcomes before continuing."
              : `Guardian's publication review denied the last publication (${[denied.reason, denied.category].filter((part) => part !== undefined).join(", ")}), and minting stopped before a corrected one was published; inspect recorded execution outcomes before continuing.`,
        }),
        ...(denied === undefined ? {} : { publicationDenial: denied }),
        ...(noResponse === undefined ? {} : { noResponse }),
        ...(example ? { example } : {}),
        ...(currentInvocation === undefined ? {} : { currentInvocation }),
        executions,
        diagnostics,
      };
    }),
  );
