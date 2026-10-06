import OpenAI from "openai";
import { lunaModel } from "../../src/models/models.js";
import { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Deferred, Effect, Either, Fiber, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

const pending: PendingExecution = {
  invocationId: "mint_continuity",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the selected trip",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://travel.example.test"],
  allowedEffects: ["read"],
};
afterEach(() => setDefaultModelProvider(new OpenAIProvider()));
const reason: ModelResponse["output"][number] = {
  type: "reasoning",
  id: "rs_first",
  content: [],
  providerData: { encrypted_content: "opaque-first-review-reasoning" },
};

it("keeps reasoning and source exchanges between reviews of the same mint without sharing another mint", async () => {
  const requests: ModelRequest[] = [];
  let sourceReads = 0;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const call = requests.length;
        return {
          usage: new Usage(),
          output:
            call % 2 === 1
              ? [
                  {
                    type: "function_call" as const,
                    callId: `read_${call}`,
                    name: "read_source",
                    arguments: JSON.stringify({ path: pending.entrypoint, offset: 0 }),
                    status: "completed" as const,
                  },
                ]
              : [
                  ...(call === 2 ? [reason] : []),
                  {
                    type: "message" as const,
                    role: "assistant" as const,
                    status: "completed" as const,
                    content: [
                      {
                        type: "output_text" as const,
                        text: JSON.stringify({
                          outcome: "allow",
                          rationale: "Current source was read",
                        }),
                      },
                    ],
                  },
                ],
        };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const guardian = makeGuardian(reviewer, undefined, {});
  const read = () =>
    Effect.sync(() => {
      sourceReads++;
      return JSON.stringify({
        kind: "untrusted_source",
        path: pending.entrypoint,
        byteOffset: 0,
        source: "export default 1",
        nextOffset: 16,
        hasMore: false,
      });
    });
  await Effect.runPromise(guardian.review(pending, read));
  await Effect.runPromise(guardian.review({ ...pending, screenedInput: '{"day":2}' }, read));
  const other = makeGuardian(reviewer, undefined, {});
  await Effect.runPromise(other.review({ ...pending, invocationId: "other_mint" }, read));
  expect(sourceReads).toBe(3);
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
  expect(JSON.stringify(requests[2]?.input)).toContain("read_1");
  expect(JSON.stringify(requests[4]?.input)).not.toContain("opaque-first-review-reasoning");
});

const message = (outcome: "allow" | "deny" = "allow"): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: JSON.stringify({ outcome, rationale: "Fixture verdict" }) },
  ],
});
const call = (id: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: id,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path: pending.entrypoint, offset: 0 }),
});
const provide = (outputs: readonly ModelResponse["output"][], requests: ModelRequest[]) => {
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const output = outputs[requests.length - 1];
        if (!output) throw new Error("Synthetic provider interrupted");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
};
const readCurrent = () =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path: pending.entrypoint,
      byteOffset: 0,
      source: "export default 1",
      nextOffset: 16,
      hasMore: false,
    }),
  );

it("restores a completed review checkpoint but requires a fresh source read", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [reason, message()], [message()]], requests);
  let saved: typeof GuardianSessionSnapshot.Type | undefined;
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const first = makeGuardian(reviewer, undefined, {
    save: (snapshot) =>
      Effect.sync(() => {
        saved = Schema.decodeUnknownSync(GuardianSessionSnapshot)(
          JSON.parse(JSON.stringify(snapshot)),
        );
      }),
  });
  await Effect.runPromise(first.review(pending, readCurrent));
  expect(saved?.incomplete).toBe(false);
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(saved),
  });
  const result = await Effect.runPromise(
    Effect.either(replacement.review({ ...pending, attemptId: "takeover" }, readCurrent)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "SourceUnavailable" } });
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
});

it("keeps an interrupted model response and closes an unreturned source call on takeover", async () => {
  const requests: ModelRequest[] = [];
  provide([[reason, call("interrupted_source")]], requests);
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const checkpoints: (typeof GuardianSessionSnapshot.Type)[] = [];
  const first = makeGuardian(reviewer, undefined, {
    save: (snapshot) =>
      Effect.sync(() => {
        checkpoints.push(snapshot);
      }),
  });
  await Effect.runPromise(
    Effect.either(
      first.review(pending, () => Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))),
    ),
  );
  const snapshot = checkpoints.find(
    (checkpoint) =>
      JSON.stringify(checkpoint.history).includes("interrupted_source") &&
      !JSON.stringify(checkpoint.history).includes("function_call_result"),
  );
  expect(snapshot?.incomplete).toBe(true);
  const later: ModelRequest[] = [];
  provide([[call("fresh_source")], [message()]], later);
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(snapshot),
  });
  const reviewed = await Effect.runPromise(
    replacement.review({ ...pending, attemptId: "takeover" }, readCurrent),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(JSON.stringify(later[0]?.input)).toContain("opaque-first-review-reasoning");
  expect(JSON.stringify(later[0]?.input)).toContain("did not complete");
  const recoveredInput = later[0]?.input;
  expect(
    (Array.isArray(recoveredInput) ? recoveredInput : []).filter(
      (item) => item.type === "function_call_result" && item.callId === "interrupted_source",
    ),
  ).toHaveLength(1);
});

it("continues from provider compaction after takeover without replaying the older raw context", async () => {
  const requests: ModelRequest[] = [];
  const compact: ModelResponse["output"][number] = {
    type: "compaction",
    id: "cmp_one",
    encrypted_content: "opaque-compacted-context",
  };
  provide([[call("first")], [reason, compact, message()], [call("second")], [message()]], requests);
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const first = makeGuardian(reviewer, undefined, {});
  await Effect.runPromise(first.review(pending, readCurrent));
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(first.session?.snapshot()),
  });
  await Effect.runPromise(replacement.review({ ...pending, attemptId: "takeover" }, readCurrent));
  expect(requests[2]?.input[0]).toMatchObject({
    type: "compaction",
    encrypted_content: "opaque-compacted-context",
  });
  expect(JSON.stringify(requests[2]?.input)).not.toContain("opaque-first-review-reasoning");
  expect(requests[2]?.modelSettings.reasoning?.context).toBe("all_turns");
  expect(requests[2]?.modelSettings.providerData).toMatchObject({
    context_management: [{ type: "compaction", compact_threshold: 240000 }],
  });
});

it("serializes concurrent reviews without forking the conversation", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [reason, message()], [call("second")], [message()]], requests);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.all(
      [
        guardian.review(pending, readCurrent),
        guardian.review({ ...pending, screenedInput: '{"day":2}' }, readCurrent),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
});

it("does not return an allow when the conversation checkpoint cannot be saved", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [message()]], requests);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {
      save: (snapshot) =>
        snapshot.incomplete ? Effect.void : Effect.fail(new Error("Synthetic save failure")),
    },
  );
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(result).toMatchObject({ _tag: "Left", left: { reviewPhase: "diagnostic_retention" } });
});

it.each(["all_turns", "current_turn", undefined] as const)(
  "requests all-turn reasoning on the wire and reports provider mode %s without guessing",
  async (effective) => {
    const bodies: unknown[] = [];
    const reported: unknown[] = [];
    const client = new OpenAI({
      apiKey: "synthetic-key",
      maxRetries: 0,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_wire",
            object: "response",
            created_at: 1,
            status: "completed",
            model: lunaModel,
            ...(effective ? { reasoning: { context: effective } } : {}),
            output: [
              {
                type: "reasoning",
                id: "rs_wire",
                summary: [],
                encrypted_content: "opaque-wire-reasoning",
              },
              {
                type: "message",
                id: "msg_wire",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ outcome: "allow", rationale: "Synthetic recovery" }),
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    setDefaultModelProvider(new OpenAIProvider({ openAIClient: client }));
    const guardian = makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), undefined, {
      reportReasoning: (context) =>
        Effect.sync(() => {
          reported.push(context);
        }),
    });
    const result = await Effect.runPromise(
      Effect.either(guardian.reviewRecovery(pending, "Synthetic stalled browser", readCurrent)),
    );
    expect(bodies[0]).toMatchObject({
      model: lunaModel,
      store: false,
      reasoning: { context: "all_turns" },
      include: ["reasoning.encrypted_content"],
      context_management: [{ type: "compaction", compact_threshold: 240000 }],
    });
    expect(reported).toEqual([
      expect.objectContaining({
        requested: "all_turns",
        effective: effective ?? "not_reported",
        level: effective === "current_turn" ? "warning" : "info",
      }),
    ]);
    expect(Either.isRight(result)).toBe(true);
    expect(guardian.session?.snapshot().effectiveReasoningContext).toBe(
      effective ?? "not_reported",
    );
  },
);

it("cancellation releases the review permit and a late response cannot overwrite the next review", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lateFinished = yield* Deferred.make<void>();
        let calls = 0;
        setDefaultModelProvider({
          getModel: () => ({
            getResponse: async () => {
              calls++;
              if (calls === 1) {
                await Effect.runPromise(Deferred.succeed(requested, undefined));
                await Effect.runPromise(Deferred.await(release));
                await Effect.runPromise(Deferred.succeed(lateFinished, undefined));
                return { usage: new Usage(), output: [reason, message()] };
              }
              return { usage: new Usage(), output: calls === 2 ? [call("current")] : [message()] };
            },
            getStreamedResponse: () => {
              throw new Error("Unused stream");
            },
          }),
        });
        const guardian = makeGuardian(
          makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          undefined,
          {},
        );
        const old = yield* Effect.forkScoped(guardian.review(pending, readCurrent));
        yield* Deferred.await(requested);
        yield* Fiber.interrupt(old);
        const next = yield* guardian.review(
          { ...pending, screenedInput: '{"next":true}' },
          readCurrent,
        );
        expect(next.decision.outcome).toBe("allow");
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(lateFinished);
        yield* Effect.yieldNow();
        expect(JSON.stringify(guardian.session?.snapshot())).not.toContain(
          "opaque-first-review-reasoning",
        );
        expect(guardian.session?.snapshot().incomplete).toBe(false);
      }),
    ),
  );
});

it("a failed source-result checkpoint ends the review before a model can allow without that result", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("source")], [message()]], requests);
  let refused = false;
  const guardian = makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), undefined, {
    save: (snapshot) =>
      Effect.suspend(() => {
        if (!refused && JSON.stringify(snapshot.history).includes("function_call_result")) {
          refused = true;
          return Effect.fail(new Error("Synthetic source-result checkpoint failure"));
        }
        return Effect.void;
      }),
  });
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(Either.isLeft(result)).toBe(true);
  expect(requests).toHaveLength(1);
});

it("cancelling the final checkpoint leaves the review incomplete", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const saving = yield* Deferred.make<void>();
        const requests: ModelRequest[] = [];
        provide([[call("current")], [message()]], requests);
        const guardian = makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), undefined, {
          save: (snapshot) =>
            snapshot.incomplete
              ? Effect.void
              : Deferred.succeed(saving, undefined).pipe(Effect.zipRight(Effect.never)),
        });
        const reviewing = yield* Effect.forkScoped(guardian.review(pending, readCurrent));
        yield* Deferred.await(saving);
        yield* Fiber.interrupt(reviewing);
        expect(guardian.session?.snapshot().incomplete).toBe(true);
      }),
    ),
  );
});

it("preserves a provider quota failure through the Effect session boundary", async () => {
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async () => {
        throw Object.assign(new Error("Synthetic quota refusal"), { code: "insufficient_quota" });
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const guardian = makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), undefined, {});
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(result).toMatchObject({ _tag: "Left", left: { modelQuotaExhausted: true } });
});
