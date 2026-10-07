import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  runLocalOperation,
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../execution/local-operation.js";
import {
  MintFailure,
  type MintDependencies,
  type ExecutionEvidence,
  type ExecutionRequest,
  type ScriptQuestionOutcome,
} from "../mint/contracts.js";
import { makeDialogDecider } from "../inputs/dialog.js";
import { questionForReview } from "../guardian/question.js";
import { noticeRequest, InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintState } from "./mint-state.js";
import { error, inputValue, mintError } from "./errors.js";
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
    yield* context.review("operation/command.sh", sources, {}, "command", "pureFiles");
    yield* beforeDispatch ?? Effect.void;
    const exec = workspace.session.exec?.bind(workspace.session);
    if (exec === undefined)
      return yield* Effect.fail(new Error("Workspace command execution unavailable"));
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
  });
/** A page check before this sign-in's steps sent the login proves nothing about this build. */
const credentialsNotSubmitted = {
  signedIn: false,
  failed: "credentials_not_submitted",
  nextStep:
    "No sign-in step since the last verified sign-in sent the login's identifier with a password, a code or a completed approval, so the host cannot take this page as signed in. A verified sign-in is over, so checking it again counts for nothing. Send the sign-in screens' signInSteps first, then check again.",
} as const;
const executeAuthentication = (
  state: MintState,
  signIn: NonNullable<ExecutionRequest["signInStep"]>,
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { start, auth, afterSubmit, mintAsk, context } = state;
    const { projection } = state.session;
    const id = randomUUID();

    yield* start.enter;

    let result: unknown;
    let authenticated = false;
    if ("fields" in signIn) {
      start.signIn();
      const report = yield* auth.step(signIn, beforeDispatch);
      start.sent(report, signIn.fields);
      result = yield* afterSubmit(report);
    } else if ("signedIn" in signIn) {
      // A check is a sign-in step too: after a verified sign-in it starts a new one.
      start.signIn();
      if (start.submitted) {
        const checked = yield* auth.signedIn(signIn.signedIn);
        authenticated = checked.signedIn && start.verified();
        result = checked;
      } else result = credentialsNotSubmitted;
    } else if ("rejected" in signIn) {
      start.signIn();
      auth.rejected(signIn.rejected.slot);
      result = { outcome: "correction_requested" };
    } else {
      start.signIn();
      result = yield* mintAsk(
        noticeRequest(
          randomUUID(),
          "system",
          `Complete the ${signIn.approval.replaceAll("_", " ")} sign-in for ${context.siteOrigin}, then confirm.`,
        ),
      );
      start.approved();
    }
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
        { credentialsAvailable: false },
        projection.text,
      );
      const review = yield* context.guardian.reviewQuestion(
        context.pending(`operation/${entrypoint}`, input),
        question,
        context.readSources(sourceMap),
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

type Journal = Parameters<MintDependencies["reviewAndExecute"]>[2];
interface ReceiptInput {
  readonly state: MintState;
  readonly execution: Exclude<Execution, { purpose: "command" }>;
  readonly id: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input: unknown;
  readonly reviewed: {
    readonly reviewId: string;
    readonly decision: {
      readonly outcome: "allow" | "deny" | "escalate";
      readonly rationale: string;
    };
  };
  readonly journal: Journal;
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
    const { state, execution, id, sources, input, reviewed, journal } = receipt;
    const { runs } = state;
    const { secrets } = state.session;
    const { scriptQuestion, unanswered } = questions;

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
    const { state, execution, id, sources, input, reviewed, journal } = receipt;
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
      output: result.output,
      purpose: execution.purpose,
      journal: result,
    });
    yield* journal?.record(evidence) ?? Effect.void;
    return evidence;
  });

const authoredExecution = (
  state: MintState,
  execution: Exclude<Parameters<MintDependencies["reviewAndExecute"]>[0], { purpose: "command" }>,
  beforeDispatch: Parameters<MintDependencies["reviewAndExecute"]>[1],
  journal: Parameters<MintDependencies["reviewAndExecute"]>[2],
) =>
  Effect.gen(function* () {
    const { workspace, context, request, handles, start, mintAsk } = state;
    const { browser, secrets } = state.session;
    const id = randomUUID();
    const sources = (yield* workspace.snapshot).filter(([path]) =>
      /^(src|explore|test|scratch)\//u.test(path),
    );
    const sourceMap = new Map(sources.map(([path, text]) => [`operation/${path}`, text]));
    const input = yield* inputValue(
      execution.testInput ?? execution.exampleInput,
      request.input ?? {},
    );
    const reviewed = yield* context.review(
      `operation/${execution.entrypoint}`,
      sourceMap,
      input,
      execution.purpose,
      execution.target === "pureFiles" ? "pureFiles" : "liveBrowser",
    );
    if (
      handles.unissued(new Map(sources)).length > 0 ||
      handles.misplaced(new Map(sources), context.siteOrigin) !== undefined
    )
      return yield* Effect.fail(new MintFailure({ code: "ScopeDenied" }));
    // A code the site sent for the sign-in under way, which an explore typed into the page,
    // finished that sign-in: it counts as the proof, as a code the host fills does. Only a typing
    // call that delivered the code's value and completed counts, never the source text.
    const known = new Map(handles.snapshot());
    const codes =
      execution.purpose === "explore" && execution.target === "liveBrowser"
        ? context.signInCodes().flatMap((handle) => known.get(handle) ?? [])
        : [];
    const watch = codes.length === 0 ? undefined : browser.watchTyping(codes);
    yield* beforeDispatch ?? Effect.void;
    yield* start.before(execution);
    const questions = scriptQuestions(state, execution.entrypoint, input, sourceMap);
    const { scriptAsk } = questions;
    const executed = yield* Effect.either(
      runLocalOperation({
        workspace,
        entrypoint: execution.entrypoint,
        sources: [...handles.fill(new Map(sources), context.siteOrigin)],
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
        target: execution.target === "pureFiles" ? "pureFiles" : "browser",
        ask: scriptAsk,
        decideDialog: makeDialogDecider(mintAsk, secrets.redact),
      }),
    );
    if (watch !== undefined && watch.typed().size > 0) start.typedCode();
    const receipt = { state, execution, id, sources, input, reviewed, journal };
    return yield* executed._tag === "Left"
      ? failedReceipt(receipt, executed.left, questions)
      : completedReceipt(receipt, executed.right);
  });
export const mintExecution =
  (state: MintState): MintDependencies["reviewAndExecute"] =>
  (execution, beforeDispatch, journal) => {
    const perform: Effect.Effect<ExecutionEvidence, Error> =
      execution.purpose === "command"
        ? executeCommand(state, execution, beforeDispatch)
        : execution.purpose === "authenticate" && execution.signInStep !== undefined
          ? executeAuthentication(state, execution.signInStep, beforeDispatch)
          : authoredExecution(state, execution, beforeDispatch, journal);
    return perform.pipe(
      Effect.tap((evidence) => Effect.sync(() => state.context.record(execution, evidence))),
      Effect.mapError(mintError),
    );
  };
