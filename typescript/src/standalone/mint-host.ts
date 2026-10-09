import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { questionForReview } from "../guardian/question.js";
import {
  MintFailure,
  MintServices,
  type ExecutionRequest,
  type MintDependencies,
  type MintOutcome,
  type PublicationDecisionLog,
} from "../mint/contracts.js";
import { runMint } from "../mint/harness.js";
import { makeOpenAIMinter } from "../mint/openai.js";
import { makeOpenAIOutcomeReviewer } from "../mint/outcome-review-openai.js";
import {
  exampleInputRefusal,
  preflightTestInput,
  writeSessionBoundary,
} from "../mint/step-checks.js";
import type { LocalMintOutcome, PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import { mintState, type MintState } from "./mint-state.js";
import { mintExecution } from "./mint-execution.js";
import { mintPublication } from "./mint-publication.js";
import { mintError } from "./errors.js";
import { memoryPublicationDecisions } from "./publication-decisions.js";
import { listed, signInOriginsToAsk } from "./sign-in-origin-question.js";
import type { FileHandles } from "../mint/file-handles.js";
/**
 * Steps the local host refuses before review. It keeps no write maintenance, so it has no
 * possible write to inspect or finish. And once a write session started, a sign-in runs only as
 * a signInStep the host fills: an authenticate step without one would run the agent's own source
 * on the site outside the session's act steps.
 */
const localStepRefusal = (
  execution: ExecutionRequest,
  writeSessionStarted: boolean,
): { readonly supported: false; readonly reason: string } | undefined =>
  execution.purpose === "inspect" || execution.purpose === "residual"
    ? {
        supported: false,
        reason: `${execution.purpose} is for a write maintenance recovering a possible write; this build has none to recover.`,
      }
    : writeSessionStarted &&
        execution.purpose === "authenticate" &&
        execution.target === "liveBrowser" &&
        execution.signInStep === undefined
      ? {
          supported: false,
          reason:
            "This write session already started, so it signs in only through a signInStep the host fills: an authenticate step without one would run your own source on the site outside the session's act steps. Nothing was executed.",
        }
      : undefined;
const mintDependencies = (state: MintState, publicationDecisions: PublicationDecisionLog) => {
  const { workspace, authoring, deadline, context, mintAsk, handles } = state;
  const { projection, options } = state.session;
  const dependencies: MintDependencies = {
    workspace: workspace.session,
    instructions: authoring.instructions,
    skills: authoring.skills,
    projection,
    model: makeOpenAIMinter(options.minterProvider),
    deadline,
    autofillSignIn: true,
    requestLogin: () => Effect.succeed("inspect"),
    reviewQuestion: (candidate, facts) =>
      Effect.gen(function* () {
        const pendingQuestion = yield* questionForReview(
          candidate,
          { credentialsAvailable: false, ...facts },
          projection.text,
        );
        const result = yield* context.reviewQuestion(
          { entrypoint: "question", sources: new Map(), input: context.input },
          pendingQuestion,
        );
        return { ...result.decision, reviewId: result.reviewId };
      }).pipe(Effect.mapError(mintError)),
    askInput: (candidate, ids) =>
      mintAsk({
        ...candidate,
        id: ids?.requestId ?? randomUUID(),
        source: "agent",
      }).pipe(
        Effect.tap((answers) =>
          context.answered(
            { ...candidate, id: ids?.requestId ?? "question", source: "agent" },
            answers,
          ),
        ),
        Effect.map((answers) => handles.issue(answers)),
        Effect.tap((issued) => Effect.sync(() => context.askedByAgent(candidate, issued))),
        Effect.mapError(mintError),
      ),
    recordBuildEffect: (effect) => Effect.sync(() => context.setBuildEffect(effect)),
    reviewTaskUpdate: (candidate) =>
      context.reviewTaskUpdate(candidate).pipe(
        Effect.map((result) => ({ ...result.decision, reviewId: result.reviewId })),
        Effect.mapError(mintError),
      ),
    applyTaskUpdate: (application) =>
      context
        .applyTaskUpdate(application, (siteOrigin) => state.rebindSite(siteOrigin))
        .pipe(Effect.mapError(mintError)),
    repeatableRead: context.repeatableRead(),
    // A repeatable read's example claims nothing, so it may run again.
    claimExample: Effect.suspend(() =>
      context.repeatableRead()
        ? Effect.void
        : context.claimed
          ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
          : Effect.sync(context.claim),
    ),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ScopeDenied" })),
    preflight: (execution) =>
      Effect.sync(() => {
        if (execution.target !== "pureFiles" && execution.target !== "liveBrowser")
          return {
            supported: false as const,
            reason: "Standalone execution supports pureFiles and liveBrowser.",
          };
        const { buildEffect } = context;
        const refusal =
          localStepRefusal(execution, state.writeSession.started) ??
          preflightTestInput(execution, { buildEffect, executionHistory: context.executions() }) ??
          exampleInputRefusal(execution, {
            buildEffect,
            callerInput: context.input,
            writeSession: state.writeSession,
          });
        if (refusal !== undefined) return refusal;
        const boundary = writeSessionBoundary(execution, {
          buildEffect,
          writeSessionStarted: state.writeSession.started,
        });
        return boundary === undefined
          ? { supported: true as const }
          : { supported: false as const, reason: boundary };
      }),
    reviewAndExecute: mintExecution(state),
    checkSignedInMarker: (marker) => state.markers.check(marker),
    publish: mintPublication(state),
    // The local host keeps no recovery checkpoint; its write completion reads the assessments.
    outcomeReview: {
      model: makeOpenAIOutcomeReviewer(
        options.outcomeReviewerProvider === undefined
          ? {}
          : { modelProvider: options.outcomeReviewerProvider },
      ),
      save: () => Effect.void,
      bindWrites: context.bindWrites,
      recordAssessment: (assessment) =>
        Effect.sync(() => {
          state.assessments.set(assessment.executionId, assessment);
        }),
    },
    publicationDecisions,
  };
  return dependencies;
};
/**
 * An unpublished build names the origins its sign-in sent the login to since the last verified
 * sign-in, off the site and the request's sign-in origins, in its outcome and its summary, so its
 * caller can trust one when asked, or add it to `authenticationOrigins`, and mint again. One the
 * caller trusted during the build stays named, since no sign-in verified through it and nothing
 * saved it, and its summary says to pass it up front.
 */
const withUntrustedSignInOrigins = (
  outcome: MintOutcome,
  state: MintState,
): LocalMintOutcome => {
  const origins = [...state.untrustedSignInOrigins];
  if (outcome.build === "published" || origins.length === 0) return outcome;
  const trusted = origins.filter((origin) => state.signInOrigins.trusted.includes(origin));
  const untrusted = origins.filter((origin) => !trusted.includes(origin));
  const them = (some: readonly string[]) => (some.length === 1 ? "it" : "them");
  // A later build asks only about the origins `signInOriginsToAsk` allows.
  const asks =
    signInOriginsToAsk(untrusted, {
      siteOrigin: state.context.siteOrigin,
      trusted: [],
      asked: new Set(),
    }) !== undefined;
  const sentences = [
    ...(untrusted.length === 0
      ? []
      : [
          `The sign-in sent the login to ${listed(untrusted)}, which ${untrusted.length === 1 ? "is" : "are"} not trusted for sign-in.`,
          asks
            ? `Answer yes when asked, or pass ${them(untrusted)} in authenticationOrigins, and build again.`
            : `Pass ${them(untrusted)} in authenticationOrigins and build again.`,
        ]),
    ...(trusted.length === 0
      ? []
      : [
          `The sign-in sent the login to ${listed(trusted)}, which the caller trusted for sign-in, but no check verified a sign-in through ${them(trusted)}.`,
          `Pass ${them(trusted)} in authenticationOrigins and build again, so the login sent there counts from the first screen.`,
        ]),
  ];
  return {
    ...outcome,
    untrustedSignInOrigins: origins,
    summary: [outcome.summary, ...sentences].join(" "),
  };
};
export const mintRequest = (
  session: StandaloneSession,
  context: RequestContext,
  request: PomeradoRequest,
  fileHandles: FileHandles,
) =>
  Effect.gen(function* () {
    const state = yield* mintState(session, context, request, fileHandles);
    // The request's runs share its publication decisions.
    const publicationDecisions = memoryPublicationDecisions();
    const mintRequest = {
      mode: "mint",
      intent: request.intent,
      businessInput: request.input ?? {},
      observations: context.observations,
      siteOrigin: context.siteOrigin,
      effect: request.effect ?? "ask",
      // The caller's files, as handles with their metadata; the input holds the handles.
      ...(fileHandles.files.length === 0 ? {} : { files: fileHandles.files }),
    } as const;
    // Each run reads the build's read/write state as it stands when the run starts.
    if (context.buildEffect === undefined) {
      const asked = yield* runMint(mintRequest).pipe(
        Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
      );
      if (context.buildEffect === undefined) return withUntrustedSignInOrigins(asked, state);
    }
    const outcome = yield* runMint({ ...mintRequest, effect: context.buildEffect }).pipe(
      Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
    );
    return withUntrustedSignInOrigins(outcome, state);
  });
