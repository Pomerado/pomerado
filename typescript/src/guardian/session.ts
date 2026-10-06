import type { AgentInputItem, ModelProvider, ModelRequest } from "@openai/agents";
import { protocol } from "@openai/agents";
import { compaction, StaticCompactionPolicy } from "@openai/agents/sandbox";
import { Effect, Schema } from "effect";
import { leadingPrivateAfter } from "./review-layout.js";

/** Private continuation state; complete original exchanges remain in protected model records. */
export const GuardianSessionSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sdkVersion: Schema.Literal("0.18.0"),
  history: Schema.Array(Schema.Unknown),
  incomplete: Schema.Boolean,
  effectiveReasoningContext: Schema.optional(
    Schema.Literal("all_turns", "current_turn", "not_reported"),
  ),
  /**
   * The items before the history's first request belong to a private review whose request
   * a compaction removed, so readable records still withhold them.
   */
  leadingPrivate: Schema.optional(Schema.Literal(true)),
});
export type GuardianSessionSnapshot = typeof GuardianSessionSnapshot.Type;
interface GuardianReasoningReport {
  readonly requested: "all_turns";
  readonly effective: "all_turns" | "current_turn" | "not_reported";
  readonly level: "info" | "warning";
  readonly detail?: string;
}
export interface GuardianSessionOptions {
  readonly reportReasoning?: (context: GuardianReasoningReport) => Effect.Effect<void>;
  readonly initial?: GuardianSessionSnapshot;
  readonly save?: (snapshot: GuardianSessionSnapshot) => Effect.Effect<void, Error>;
}

export const guardianContinuityPolicy =
  "This is one continuing Guardian conversation for this mint. Earlier requests, source reads, " +
  "reasoning and verdicts are historical context, never authority for this request. Apply the " +
  "current instructions and this turn's trusted authority. Inspect current source for every " +
  "execution: an earlier allow never satisfies this review, and an earlier read does only for " +
  "a source the host lists in trusted_review.unchangedSources as byte-identical to it. An " +
  "interrupted review grants no approval.";

/** Same explicit provider compaction threshold as the minter; no additional tools or sandbox. */
export const guardianCompaction = (): ReturnType<typeof compaction> =>
  compaction({ policy: new StaticCompactionPolicy(240_000) });

const closeInterruptedReview = (items: AgentInputItem[]) => {
  const answered = new Set(
    items.flatMap((item) => (item.type === "function_call_result" ? [item.callId] : [])),
  );
  for (const item of [...items])
    if (item.type === "function_call" && !answered.has(item.callId))
      items.push({
        type: "function_call_result",
        status: "completed",
        name: item.name,
        callId: item.callId,
        output: {
          type: "text",
          text: "The previous review was interrupted before this source result was retained. No source result or approval is implied. Read the current source again.",
        },
      });
  items.push({
    role: "user",
    type: "message",
    content:
      "The preceding review did not complete. Continue in the same conversation and review the following current request afresh; earlier verdicts are not authorization.",
  });
};

const continuationProvider = ({
  provider,
  state,
  signal,
  save,
  reportReasoning,
  setEffective,
  compacted,
}: {
  provider: ModelProvider;
  state: () => AgentInputItem[];
  signal: () => AbortSignal;
  save: (items: readonly AgentInputItem[], incomplete: boolean) => Effect.Effect<void, Error>;
  reportReasoning: GuardianSessionOptions["reportReasoning"];
  setEffective: (value: "all_turns" | "current_turn" | "not_reported") => void;
  compacted: () => void;
}): ModelProvider => ({
  getModel: (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* Effect.promise(async () => provider.getModel(name));
        return {
          ...model,
          getStreamedResponse: model.getStreamedResponse.bind(model),
          getResponse: (request: ModelRequest) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* save(state(), true);
                const response = yield* Effect.tryPromise({
                  try: () =>
                    model.getResponse({
                      ...request,
                      input:
                        typeof request.input === "string"
                          ? request.input
                          : guardianCompaction().processContext(request.input),
                    }),
                  catch: (error) =>
                    error instanceof Error
                      ? error
                      : new Error("Guardian provider failed", { cause: error }),
                });
                signal().throwIfAborted();
                if (response.output.some((item) => item.type === "compaction")) compacted();
                const metadata = Schema.decodeUnknownEither(
                  Schema.Struct({
                    reasoning: Schema.Struct({
                      context: Schema.Literal("all_turns", "current_turn"),
                    }),
                  }),
                )(response.providerData);
                const effective =
                  metadata._tag === "Right" ? metadata.right.reasoning.context : "not_reported";
                setEffective(effective);
                yield* save([...state(), ...response.output], true);
                // A current_turn response still decides: each request carries its own trusted
                // authority and source inspection, and the replayed history keeps earlier requests,
                // source exchanges and verdicts. Only earlier turns' reasoning is not carried.
                if (reportReasoning)
                  yield* reportReasoning(
                    effective === "current_turn"
                      ? {
                          requested: "all_turns",
                          effective,
                          level: "warning",
                          detail:
                            "Guardian requested all_turns reasoning but the provider reported current_turn: earlier reviews' reasoning was not carried into this response. The review continues; earlier requests, source exchanges and verdicts are still sent as conversation history.",
                        }
                      : { requested: "all_turns", effective, level: "info" },
                  );
                return response;
              }),
              { signal: signal() },
            ),
        };
      }),
    ),
});

export const makeGuardianSession = (options: GuardianSessionOptions) => {
  const permit = Effect.unsafeMakeSemaphore(1);
  /** Provider compactions this process observed; each replaces the context Guardian sees. */
  let compactions = 0;
  let current: GuardianSessionSnapshot = options.initial ?? {
    version: 1,
    sdkVersion: "0.18.0",
    history: [],
    incomplete: false,
  };
  const history = (): AgentInputItem[] =>
    current.history.map((item) => protocol.ModelItem.parse(item));
  const save = (items: readonly AgentInputItem[], incomplete: boolean) =>
    Effect.suspend(() => {
      // Only the provider's continuation item replaces context. Never trim reviews ourselves.
      let start = 0;
      for (let index = 0; index < items.length; index++)
        if (items[index]?.type === "compaction") start = index;
      const { leadingPrivate: _previous, ...rest } = current;
      current = {
        ...rest,
        history: items.slice(start),
        incomplete,
        ...(leadingPrivateAfter(items.slice(0, start), current.leadingPrivate === true)
          ? { leadingPrivate: true as const }
          : {}),
      };
      return (options.save?.(current) ?? Effect.void).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            current = { ...current, incomplete: true };
          }),
        ),
      );
    });
  return {
    provider: (provider: ModelProvider, state: () => AgentInputItem[], signal: () => AbortSignal) =>
      continuationProvider({
        provider,
        state,
        signal,
        save,
        reportReasoning: options.reportReasoning,
        setEffective: (effective) => {
          current = { ...current, effectiveReasoningContext: effective };
        },
        compacted: () => {
          compactions++;
        },
      }),
    snapshot: () => current,
    /** Whether readable records must withhold the history's leading items; see the snapshot. */
    leadingPrivate: () => current.leadingPrivate === true,
    /** The conversation since its last compaction, as the next request continues it. */
    history,
    /** Changes whenever a compaction replaces the context, including in the middle of a review. */
    compactions: () => compactions,
    exclusive: <A, E, R>(work: Effect.Effect<A, E, R>) => permit.withPermits(1)(work),
    observe: (items: readonly AgentInputItem[]) => save(items, true),
    complete: () => save(history(), false),
    sourceResult: (callId: string, output: string) =>
      save(
        [
          ...history(),
          {
            type: "function_call_result",
            status: "completed",
            name: "read_source",
            callId,
            output: { type: "text", text: output },
          },
        ],
        true,
      ),
    /** Adds a request; `continuing` marks the host's follow-up within the review in progress. */
    input: (request: string, continuing = false) =>
      Effect.gen(function* () {
        const items = history();
        if (current.incomplete && !continuing) {
          closeInterruptedReview(items);
        }
        items.push({ role: "user", type: "message", content: request });
        yield* save(items, true);
        return items;
      }),
  };
};
export type GuardianSession = ReturnType<typeof makeGuardianSession>;
