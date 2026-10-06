import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { questionForReview } from "../guardian/question.js";
import { MintFailure, MintServices, type MintDependencies } from "../mint/contracts.js";
import { runMint } from "../mint/harness.js";
import { makeOpenAIMinter } from "../mint/openai.js";
import type { PomeradoRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import { mintState, type MintState } from "./mint-state.js";
import { mintExecution } from "./mint-execution.js";
import { mintPublication } from "./mint-publication.js";
import { mintError } from "./errors.js";
const mintDependencies = (state: MintState) => {
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
        const result = yield* context.guardian.reviewQuestion(
          context.pending("question", request.input ?? {}),
          pendingQuestion,
          context.readSources(new Map()),
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
    recordBuildEffect: (effect) =>
      Effect.sync(() => {
        state.setBuildEffect(effect);
        context.setEffect(effect);
      }),
    upgradeToWrite: () => Effect.sync(() => context.setEffect("write")),
    claimExample: Effect.suspend(() =>
      state.claimed
        ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
        : Effect.sync(() => {
            state.claim();
          }),
    ),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ScopeDenied" })),
    preflight: (execution) =>
      Effect.succeed(
        execution.target === "pureFiles" || execution.target === "liveBrowser"
          ? { supported: true as const }
          : {
              supported: false as const,
              reason: "Standalone execution supports pureFiles and liveBrowser.",
            },
      ),
    reviewAndExecute: mintExecution(state),
    publish: mintPublication(state),
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
    const dependencies = mintDependencies(state);
    const mintRequest = {
      mode: "mint",
      intent: request.intent,
      businessInput: request.input ?? {},
      observations: {},
      siteOrigin: context.siteOrigin,
      effect: request.effect ?? "ask",
    } as const;
    if (state.buildEffect === undefined) {
      const asked = yield* runMint(mintRequest).pipe(
        Effect.provideService(MintServices, dependencies),
      );
      if (state.buildEffect === undefined) return asked;
    }
    return yield* runMint({ ...mintRequest, effect: state.buildEffect }).pipe(
      Effect.provideService(MintServices, dependencies),
    );
  });
