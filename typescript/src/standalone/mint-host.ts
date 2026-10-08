import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { questionForReview } from "../guardian/question.js";
import {
  MintFailure,
  MintServices,
  type ExecutionRequest,
  type MintDependencies,
  type PublicationDecisionLog,
} from "../mint/contracts.js";
import { runMint } from "../mint/harness.js";
import { makeOpenAIMinter } from "../mint/openai.js";
import {
  exampleInputRefusal,
  preflightTestInput,
  writeSessionBoundary,
} from "../mint/step-checks.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import { mintState, type MintState } from "./mint-state.js";
import { mintExecution } from "./mint-execution.js";
import { mintPublication } from "./mint-publication.js";
import { mintError } from "./errors.js";
import { memoryPublicationDecisions } from "./publication-decisions.js";
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
const mintDependencies = (
  state: MintState,
  publicationDecisions: PublicationDecisionLog,
) => {
  const { workspace, authoring, deadline, context, request, mintAsk, handles } = state;
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
          { entrypoint: "question", sources: new Map(), input: request.input ?? {} },
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
    upgradeToWrite: context.approveWrite,
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
            callerInput: request.input ?? {},
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
    checkSignedInMarker: state.markers.check,
    publish: mintPublication(state),
    publicationDecisions,
  };
  return dependencies;
};
export const mintRequest = (
  session: StandaloneSession,
  context: RequestContext,
  request: PomeradoRequest,
) =>
  Effect.gen(function* () {
    const state = yield* mintState(session, context, request);
    // The request's runs share its publication decisions.
    const publicationDecisions = memoryPublicationDecisions();
    const mintRequest = {
      mode: "mint",
      intent: request.intent,
      businessInput: request.input ?? {},
      observations: context.observations,
      siteOrigin: context.siteOrigin,
      effect: request.effect ?? "ask",
    } as const;
    // Each run reads the build's read/write state as it stands when the run starts.
    if (context.buildEffect === undefined) {
      const asked = yield* runMint(mintRequest).pipe(
        Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
      );
      if (context.buildEffect === undefined) return asked;
    }
    return yield* runMint({ ...mintRequest, effect: context.buildEffect }).pipe(
      Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
    );
  });
