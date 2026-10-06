import type { Agent, AgentOutputType } from "@openai/agents";
import { RunContext, RunState } from "@openai/agents";
import { Effect, Schema } from "effect";
import type { ReviewTurn } from "./review.js";
import { siteDomain } from "../runtime/same-site.js";
import { ownerNamedOrigins } from "./owner-named-origins.js";
import { guardianModel } from "./model.js";
import { guardianCompaction } from "./session.js";
import { withReasoningContinuity } from "../models/reasoning-settings.js";

/** JSON.stringify leaves an undefined key out, so an empty list never reaches the model. */
const absentWhenEmpty = <T>(list: readonly T[]) => (list.length === 0 ? undefined : list);

export const guardianReviewInput = (
  turn: ReviewTurn,
  extra: Readonly<Record<string, unknown>> = {},
) =>
  JSON.stringify({
    trusted_authority: {
      intent: turn.pending.screenedIntent,
      allowedOrigins: turn.pending.allowedOrigins,
      // Derived from the screened origins, so no new text reaches the model.
      allowedSites: turn.pending.allowedOrigins.flatMap((origin) => {
        const registrableDomain = siteDomain(origin);
        return registrableDomain === undefined ? [] : [{ scheme: "https", registrableDomain }];
      }),
      allowedEffects: turn.pending.allowedEffects,
      // The `typed` mark is the host's, for ownerNamedOrigins only.
      answeredQuestions: absentWhenEmpty(
        (turn.pending.answeredQuestions ?? []).map(({ question, answer }) => ({
          question,
          answer,
        })),
      ),
      ownerNamedOrigins: absentWhenEmpty(ownerNamedOrigins(turn.pending)),
    },
    ...extra,
    ...(turn.pending.questionCandidate === undefined
      ? {}
      : {
          question_review: {
            request: {
              questions: turn.pending.questionCandidate.questions,
              ...(turn.pending.questionCandidate.notice === undefined
                ? {}
                : { notice: turn.pending.questionCandidate.notice }),
            },
            credentialsAvailable: turn.pending.questionCandidate.credentialsAvailable,
            ...(turn.pending.questionCandidate.writeUpgrade === true ? { writeUpgrade: true } : {}),
            ...(turn.pending.questionCandidate.blockedOutcome === true
              ? { blockedOutcome: true }
              : {}),
          },
        }),
    submitted_call: {
      entrypoint: turn.pending.entrypoint,
      input: turn.pending.screenedInput,
    },
    // read_source's own JSON result, so the model reads it as it reads that tool's.
    ...(turn.entrypointSource === undefined
      ? {}
      : { untrusted_entrypoint_source: JSON.parse(turn.entrypointSource) as unknown }),
    ...(turn.pending.mintContext === undefined
      ? {}
      : { trusted_execution_context: turn.pending.mintContext }),
    untrusted_observations: turn.pending.screenedObservations,
    untrusted_step_results: turn.pending.stepResults,
  });

export const guardianReviewSettings = (turn: ReviewTurn) =>
  withReasoningContinuity({
    ...guardianModel.modelSettings,
    ...(turn.session
      ? {
          reasoning: {
            ...guardianModel.modelSettings.reasoning,
            context: "all_turns" as const,
          },
        }
      : {}),
    parallelToolCalls: true,
    ...(turn.session
      ? {
          providerData: guardianCompaction().samplingParams({
            model: guardianModel.model,
          }),
        }
      : {}),
  });

export const guardianReviewState = <TContext, TOutput extends AgentOutputType>(
  turn: ReviewTurn,
  input: string,
  agent: Agent<TContext, TOutput>,
  maxTurns = 12,
) =>
  Effect.gen(function* () {
    const continuedInput = turn.session ? yield* turn.session.input(input) : input;
    return new RunState(new RunContext<TContext>(), continuedInput, agent, maxTurns);
  });

export const SourceInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.Int.pipe(Schema.nonNegative()),
});
