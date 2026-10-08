import { randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import {
  runLocalOperation,
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../execution/local-operation.js";
import {
  type MintDependencies,
  type ExecutionEvidence,
  type ExecutionRequest,
  type ScriptQuestionOutcome,
} from "../mint/contracts.js";
import { localCommandTimeoutMs } from "../execution/local-workspace.js";
import { localOutputLimit } from "../execution/local-path.js";
import { makeDialogDecider } from "../inputs/dialog.js";
import { questionForReview } from "../guardian/question.js";
import { secretHandleRefusal } from "../mint/secret-handles.js";
import { replayedWriteStep, stepInput, writeStepDigest } from "../mint/step-checks.js";
import {
  commitEvidenceOf,
  commitUncertain,
  verifyFirstNotice,
  type CommitEvidence,
} from "../mint/write-session.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { siteDomain } from "../runtime/same-site.js";
import { trustedUrl } from "../runtime/sign-in-origins.js";
import type { MintState } from "./mint-state.js";
import { error, mintError } from "./errors.js";
type Execution = Parameters<MintDependencies["reviewAndExecute"]>[0];
type BeforeDispatch = Parameters<MintDependencies["reviewAndExecute"]>[1];
const executeCommand = (
  state: MintState,
  execution: Extract<Execution, { purpose: "command" }>,
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { workspace, context } = state;
    const { projection } = state.session;
    const id = randomUUID();

    const sources = new Map(
      (yield* workspace.snapshot).map(([path, text]) => [`operation/${path}`, text]),
    );
    sources.set("operation/command.sh", execution.command);
    yield* context.review(
      {
        entrypoint: "operation/command.sh",
        sources,
        input: {},
        currentExecution: {
          purpose: "command",
          target: "pureFiles",
          commandSandbox: {
            // The command runs in the workspace; its path on this machine is not Guardian's.
            cwd: ".",
            timeoutSeconds: localCommandTimeoutMs / 1000,
            maxOutputBytes: localOutputLimit,
          },
        },
      },
      "not_sent",
    );
    yield* beforeDispatch ?? Effect.void;
    const exec = workspace.session.exec?.bind(workspace.session);
    if (exec === undefined)
      return yield* Effect.fail(new Error("Workspace command execution unavailable"));
    return yield* context.running(
      { purpose: "command", target: "pureFiles" },
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => exec({ cmd: execution.command }),
          catch: error,
        });
        return {
          executionId: id,
          status: result.exitCode === 0 ? ("completed" as const) : ("failed" as const),
          effect: "not_sent" as const,
          observations: yield* projection.json(result),
        };
      }),
    );
  });
/**
 * A sign-in step: a screen the recorder fills, an approval, a rejected value or a signed-in check.
 * Each belongs to the sign-in under way, and after a verified sign-in the first one starts a new
 * one. A screen's report reaches the minter as `step`, with its controls after a clicked submit.
 */
const executeAuthentication = (
  state: MintState,
  signIn: NonNullable<ExecutionRequest["signInStep"]>,
  loginUrl: string | undefined,
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { start, recorder, afterSubmit, context, markers } = state;
    const { projection } = state.session;
    const id = randomUUID();

    yield* start.enter;
    start.signIn();
    if (!("signedIn" in signIn)) markers.signInStep();
    const step = yield* recorder.step(
      signIn,
      loginUrl,
      Effect.zipRight(markers.beforeTyping, beforeDispatch ?? Effect.void),
    );
    if ("fields" in signIn && step.report !== undefined) start.sent(step.report, signIn.fields);
    if (step.approved === true) start.approved();
    const authenticated = step.verified === true && start.verified();
    const result =
      step.report === undefined
        ? step.result
        : { step: yield* afterSubmit(step.report), ...step.result };
    yield* context.observe;
    return {
      executionId: id,
      status: "completed" as const,
      effect: "possible" as const,
      observations: yield* projection.json(result),
      ...(authenticated
        ? {
            authentication: {
              state: "authenticated" as const,
              effect: "verified" as const,
            },
          }
        : {}),
    };
  });

const scriptQuestions = (
  state: MintState,
  entrypoint: string,
  input: unknown,
  sourceMap: ReadonlyMap<string, string>,
) => {
  const { context, mintAsk } = state;
  const { projection } = state.session;
  let scriptQuestion: ScriptQuestionOutcome | undefined;
  let unanswered = false;
  const scriptAsk: InputAsker = (candidate, bounds) =>
    Effect.gen(function* () {
      const question = yield* questionForReview(
        candidate,
        { credentialsAvailable: false, scriptAsk: true },
        projection.text,
      );
      const review = yield* context.reviewQuestion(
        { entrypoint: `operation/${entrypoint}`, sources: sourceMap, input },
        question,
      );
      if (review.decision.outcome !== "allow_business") {
        scriptQuestion = {
          requestId: candidate.id,
          outcome: review.decision.outcome,
          rationale: review.decision.rationale,
          reviewId: review.reviewId,
        };
        return yield* Effect.fail(new InputRequestFailure({ code: "Unauthorized" }));
      }
      return yield* mintAsk(candidate, bounds).pipe(
        Effect.tap((answers) => context.answered(candidate, answers)),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof InputRequestFailure
          ? cause
          : new InputRequestFailure({ code: "Unavailable" }),
      ),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          if (cause.code === "NoResponse") unanswered = true;
        }),
      ),
    );
  return {
    scriptAsk,
    get scriptQuestion() {
      return scriptQuestion;
    },
    get unanswered() {
      return unanswered;
    },
  };
};

/**
 * What an act step's effect journal shows about its write. The journal reads `not_sent` only
 * while the step made no browser call, so anything else may have sent the write: the step is
 * `possiblySent`, since the local host counts no requests. A step whose child did not report its
 * own result has `unreported` commit evidence, and the marks it streamed count only once a later
 * step confirms.
 */
const actOutcome = (executed: Either.Either<LocalOperationOutput, Error>) => {
  const failure = Either.isLeft(executed) ? executed.left : undefined;
  const journal: LocalOperationJournal = Either.isRight(executed)
    ? executed.right
    : failure instanceof LocalOperationFailure
      ? failure.journal
      : { effect: "possible", commits: [] };
  const reported =
    Either.isRight(executed) || (failure instanceof LocalOperationFailure && failure.reported);
  const entered = journal.commits
    .filter((mark) => mark.state !== "not_sent")
    .map(({ name }) => name);
  const sent = journal.effect === "not_sent" ? 0 : undefined;
  const commit: CommitEvidence = reported ? commitEvidenceOf(journal.commits) : "unreported";
  return {
    stateChanging: journal.effect !== "not_sent",
    marks: {
      ...(journal.confirmation === undefined ? {} : { confirmation: journal.confirmation }),
      possiblySent: journal.effect !== "not_sent",
      enteredMarks: reported ? entered : [],
      ...(failure instanceof LocalOperationFailure && !reported ? { streamedMarks: entered } : {}),
    },
    writeSession:
      failure !== undefined && commitUncertain(sent, commit)
        ? { verifyFirst: true as const, notice: verifyFirstNotice(sent, commit) }
        : undefined,
  };
};

type Journal = Parameters<MintDependencies["reviewAndExecute"]>[2];
interface ReceiptInput {
  readonly state: MintState;
  readonly execution: Exclude<Execution, { purpose: "command" }>;
  readonly id: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input: unknown;
  readonly intentDerivedInput?: Readonly<Record<string, unknown>>;
  readonly reviewed: {
    readonly reviewId: string;
    readonly decision: {
      readonly outcome: "allow" | "deny" | "escalate";
      readonly rationale: string;
    };
  };
  readonly journal: Journal;
  /** A failed act step that may have committed its write: read back before writing again. */
  readonly writeSession?: { readonly verifyFirst: true; readonly notice: string };
}
const failedReceipt = (
  receipt: ReceiptInput,
  failure: Error,
  questions: {
    readonly scriptQuestion: ScriptQuestionOutcome | undefined;
    readonly unanswered: boolean;
  },
) =>
  Effect.gen(function* () {
    const { state, execution, id, sources, input, intentDerivedInput, reviewed, journal } = receipt;
    const { runs } = state;
    const { secrets } = state.session;
    const { scriptQuestion, unanswered } = questions;
    const { writeSession } = receipt;

    const failureJournal: LocalOperationJournal =
      failure instanceof LocalOperationFailure
        ? failure.journal
        : {
            effect: execution.target === "pureFiles" ? "not_sent" : "possible",
            commits: [],
          };
    runs.set(id, {
      sources,
      entrypoint: execution.entrypoint,
      input,
      ...(intentDerivedInput === undefined ? {} : { intentDerivedInput }),
      output: undefined,
      purpose: execution.purpose,
      journal: failureJournal,
    });
    const evidence: ExecutionEvidence = {
      executionId: id,
      status: "failed",
      effect: failureJournal.effect,
      ...(failureJournal.confirmation === undefined
        ? {}
        : { confirmation: failureJournal.confirmation }),
      observations: {
        message: secrets.redact(failure.message),
        ...(failure instanceof LocalOperationFailure
          ? { code: failure.code, tag: failure.tag }
          : {}),
        ...(writeSession === undefined ? {} : { writeSession }),
      },
      review: { reviewId: reviewed.reviewId, ...reviewed.decision },
      ...(scriptQuestion === undefined ? {} : { scriptQuestion }),
      ...(unanswered || (failure instanceof LocalOperationFailure && failure.code === "NoResponse")
        ? { noResponse: { possibleCommit: execution.purpose === "act" } }
        : {}),
    };
    yield* journal?.record(evidence) ?? Effect.void;
    return evidence;
  });
const completedReceipt = (receipt: ReceiptInput, result: LocalOperationOutput) =>
  Effect.gen(function* () {
    const { state, execution, id, sources, input, intentDerivedInput, reviewed, journal } = receipt;
    const { runs } = state;
    const { projection } = state.session;

    const evidence: ExecutionEvidence = {
      executionId: id,
      status: "completed",
      resultRef: `local:${id}`,
      effect: result.effect,
      ...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
      observations: yield* projection.json({
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        inputSchema: result.schemas.input,
        outputSchema: result.schemas.output,
      }),
      review: { reviewId: reviewed.reviewId, ...reviewed.decision },
    };
    runs.set(id, {
      sources,
      entrypoint: execution.entrypoint,
      input,
      ...(intentDerivedInput === undefined ? {} : { intentDerivedInput }),
      output: result.output,
      purpose: execution.purpose,
      journal: result,
    });
    yield* journal?.record(evidence) ?? Effect.void;
    return evidence;
  });

/** A step the host refuses before review: it runs nothing and leaves no history entry. */
const unsupported = (reason: string): ExecutionEvidence => ({
  executionId: randomUUID(),
  status: "unsupported",
  effect: "not_sent",
  observations: reason,
});

const authoredExecution = (
  state: MintState,
  execution: Exclude<Parameters<MintDependencies["reviewAndExecute"]>[0], { purpose: "command" }>,
  beforeDispatch: Parameters<MintDependencies["reviewAndExecute"]>[1],
  journal: Parameters<MintDependencies["reviewAndExecute"]>[2],
) =>
  Effect.gen(function* () {
    const { workspace, context, request, handles, start, mintAsk, writeSession } = state;
    const { browser, secrets } = state.session;
    const id = randomUUID();
    const sources = (yield* workspace.snapshot).filter(([path]) =>
      /^(src|explore|test|scratch)\//u.test(path),
    );
    const files = new Map(sources);
    const live = execution.target === "liveBrowser";
    const refusal =
      secretHandleRefusal(handles, files, execution, context.siteOrigin) ??
      replayedWriteStep(execution, files, writeSession.steps);
    if (refusal !== undefined) return unsupported(refusal);
    const selected = yield* stepInput(execution, {
      callerInput: request.input ?? {},
      sessionInput: writeSession.input,
    });
    const { input, mark } = selected;
    const sourceMap = new Map(sources.map(([path, text]) => [`operation/${path}`, text]));
    const reviewed = yield* context.review(
      {
        entrypoint: `operation/${execution.entrypoint}`,
        sources: sourceMap,
        input,
        currentExecution: {
          purpose: execution.purpose,
          target: execution.target,
          ...(mark === undefined ? {} : { input: mark }),
        },
        startsOnFreshPage: start.resets(execution),
      },
      "not_sent",
    );
    // A code the site sent for the sign-in under way, which an explore typed on the site,
    // finished that sign-in: it counts as the proof, as a code the host fills does. Only a typing
    // call that delivered the code's value in a frame on the site or a configured sign-in origin
    // and completed counts, never the source text.
    const known = new Map(handles.snapshot());
    const codes =
      execution.purpose === "explore" && live
        ? context.signInCodes().flatMap((handle) => known.get(handle) ?? [])
        : [];
    const signInOrigins = request.authenticationOrigins ?? [];
    const watch =
      codes.length === 0
        ? undefined
        : browser.watchTyping(codes, (url) => trustedUrl(context.siteOrigin, signInOrigins, url));
    yield* beforeDispatch ?? Effect.void;
    if (execution.purpose === "act") {
      writeSession.started = true;
      // Guardian allowed the step on this input, so the session runs it from here on.
      if (selected.mark === "intent_derived") writeSession.input = selected.input;
    }
    const questions = scriptQuestions(state, execution.entrypoint, input, sourceMap);
    const { scriptAsk } = questions;
    return yield* context.running(
      {
        purpose: execution.purpose,
        target: execution.target,
        ...(mark === "agent_chosen" ? { input: mark } : {}),
      },
      Effect.gen(function* () {
        yield* start.before(execution);
        const executed = yield* Effect.either(
          runLocalOperation({
            workspace,
            entrypoint: execution.entrypoint,
            // Only a live step receives a value; offline steps run the handle text as written.
            sources: live ? [...handles.fill(files, context.siteOrigin)] : sources,
            input,
            browser:
              watch === undefined
                ? browser
                : { sessionId: browser.sessionId, executeResponse: watch.executeResponse },
            siteOrigin: context.siteOrigin,
            ...(siteDomain(context.siteOrigin) === undefined
              ? {}
              : { siteDomain: siteDomain(context.siteOrigin) ?? "" }),
            timeoutMs: execution.timeoutSeconds * 1000,
            mode: "run",
            target: live ? "browser" : "pureFiles",
            dispatchAtFirstCall: true,
            ask: scriptAsk,
            decideDialog: makeDialogDecider(mintAsk, secrets.redact),
          }),
        );
        if (watch !== undefined && watch.typed().size > 0) {
          start.typedCode();
          state.recorder.codeTyped();
          state.markers.signInStep();
        }
        if (live) {
          yield* context.observe;
          if (execution.purpose === "explore") state.markers.explored(context.observedUrl);
        }
        const act = execution.purpose === "act" ? actOutcome(executed) : undefined;
        if (act !== undefined)
          writeSession.steps.push({
            entrypoint: execution.entrypoint,
            sourceDigest: writeStepDigest(files, execution.entrypoint),
            stateChanging: act.stateChanging,
            ...act.marks,
          });
        if (execution.purpose === "example" && executed._tag === "Right")
          context.setInputSchema(executed.right.schemas.input);
        const receipt = {
          state,
          execution,
          id,
          sources,
          input,
          ...(selected.mark === "intent_derived" ? { intentDerivedInput: selected.input } : {}),
          reviewed,
          journal,
          ...(act?.writeSession === undefined ? {} : { writeSession: act.writeSession }),
        };
        return yield* executed._tag === "Left"
          ? failedReceipt(receipt, executed.left, questions)
          : completedReceipt(receipt, executed.right);
      }),
    );
  });
export const mintExecution =
  (state: MintState): MintDependencies["reviewAndExecute"] =>
  (execution, beforeDispatch, journal) => {
    const perform: Effect.Effect<ExecutionEvidence, Error> =
      execution.purpose === "command"
        ? executeCommand(state, execution, beforeDispatch)
        : execution.purpose === "authenticate" && execution.signInStep !== undefined
          ? state.context.recorded(
              { purpose: "authenticate", target: "liveBrowser" },
              executeAuthentication(
                state,
                execution.signInStep,
                execution.loginUrl,
                beforeDispatch,
              ),
            )
          : authoredExecution(state, execution, beforeDispatch, journal);
    return perform.pipe(Effect.mapError(mintError));
  };
