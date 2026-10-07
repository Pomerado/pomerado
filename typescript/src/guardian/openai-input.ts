import type { Agent, AgentInputItem, AgentOutputType } from "@openai/agents";
import { RunContext, RunState } from "@openai/agents";
import { Effect, Schema } from "effect";
import type { ReviewTurn } from "./review.js";
import { siteDomain } from "../runtime/same-site.js";
import { ownerNamedOrigins } from "./owner-named-origins.js";
import { guardianModel } from "./model.js";
import { guardianCompaction } from "./session.js";
import { withReasoningContinuity } from "../models/reasoning-settings.js";
import { reviewKindOf } from "./review-layout.js";

/** JSON.stringify leaves an undefined key out, so an empty list never reaches the model. */
const absentWhenEmpty = <T>(list: readonly T[]) => (list.length === 0 ? undefined : list);

/**
 * The per-review user message. Everything that differs between review kinds is here, never in
 * the instructions, tools or output format, so switching kinds keeps the conversation cached.
 */
export const guardianReviewInput = (
  turn: ReviewTurn,
  policy: string,
  extra: Readonly<Record<string, unknown>> = {},
) =>
  JSON.stringify({
    trusted_review: {
      kind: turn.pending.hostReview?.kind ?? reviewKindOf(turn.pending),
      policy,
      // Marks the exchange so later readable records withhold it, even after a takeover.
      ...(turn.pending.hostReview?.private === true ? { private: true } : {}),
      ...(turn.pending.hostWrapper === undefined ? {} : { hostWrapper: turn.pending.hostWrapper }),
      ...(turn.sources?.unchangedSources === undefined
        ? {}
        : { unchangedSources: turn.sources.unchangedSources }),
    },
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
        (turn.pending.answeredQuestions ?? []).map(({ question, answer, other, note }) => ({
          question,
          answer,
          ...(other === undefined ? {} : { other }),
          ...(note === undefined ? {} : { note }),
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
    ...(turn.pending.hostReview === undefined
      ? {}
      : { host_review: turn.pending.hostReview.evidence }),
    submitted_call: {
      entrypoint: turn.pending.entrypoint,
      input: turn.pending.screenedInput,
      ...(turn.sources?.entrypoint === undefined
        ? {}
        : { entrypointSource: turn.sources.entrypoint }),
    },
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

/**
 * A review's default turn limit. A publication review reads across its whole evidence index, the
 * bundle, the definition and the output or session files, so it gets more turns than a step's.
 */
export const guardianReviewTurns = (turn: ReviewTurn) =>
  turn.pending.publication === undefined ? 12 : 32;

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

/** The same review continued with the host's follow-up after the reviewer's last output. */
export const guardianFollowUpState = <TContext, TOutput extends AgentOutputType>(
  turn: ReviewTurn,
  history: readonly AgentInputItem[],
  followUp: string,
  agent: Agent<TContext, TOutput>,
  maxTurns = 12,
) =>
  Effect.gen(function* () {
    const continuedInput = turn.session
      ? yield* turn.session.input(followUp, true)
      : [...history, { role: "user" as const, type: "message" as const, content: followUp }];
    return new RunState(new RunContext<TContext>(), continuedInput, agent, maxTurns);
  });

export const SourceInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.Int.pipe(Schema.nonNegative()),
});
