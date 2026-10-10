// Failure modes covered: a question or task update review is asked for the execution outcomes
// (allow, deny or escalate) beside its own, so the model returns one its kind refuses; a review
// that returns an outcome its kind refuses is retried with backoff as an outage, from the same
// input, for as long as the retry budget lasts, instead of being told once which outcomes count;
// a write build's task update review reads its empty allowedEffects as a read-only build.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { guardianActions } from "../../src/guardian/review-contracts.js";
import { guardianOutcomes } from "../../src/guardian/review-layout.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type {
  GuardianDiagnostics,
  PendingExecution,
  ReviewFailure,
  ReviewRetry,
} from "../../src/guardian/review.js";
import type { PendingQuestion } from "../../src/guardian/question.js";
import type { PendingTaskUpdate } from "../../src/guardian/task-update.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };
const quickRetry: ReviewRetry = { delays: ["1 millis"], budget: "1 minute" };

const pending: PendingExecution = {
  invocationId: "outcome_job",
  attemptId: "outcome_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Order the plan the owner picks from the plans the site lists.",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_outcomes",
  allowedOrigins: ["https://plans.example.test"],
  allowedEffects: ["read"],
};
const question: PendingQuestion = {
  questions: [
    {
      id: "plan",
      type: "choice",
      prompt: "Which plan?",
      options: [{ label: "Basic" }, { label: "Plus" }],
    },
  ],
  credentialsAvailable: false,
};
const update: PendingTaskUpdate = {
  summary: "Order the Plus plan instead of the Basic plan.",
  changes: [{ setting: "input", values: { plan: "Plus" } }],
  recommend: "update",
  confirmation: [{ question: "Which plan?", answer: "Plus" }],
  effect: "read",
};
const source = JSON.stringify({
  kind: "untrusted_source",
  path: pending.entrypoint,
  byteOffset: 0,
  nextOffset: 22,
  hasMore: false,
  source: "export default () => 1;",
});
const readSource = () => Effect.succeed(source);

const decision = (outcome: string, action: string | null = null): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          outcome,
          rationale: `Synthetic ${outcome}.`,
          reason: null,
          findings: null,
          label: null,
          action,
        }),
      },
    ],
  },
];

const scripted = (responses: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        const output = responses[requests.length];
        requests.push(request);
        if (output === undefined) throw new Error("No scripted response");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};

/** The host's review request: the first user message, the JSON review input. */
const reviewRequest = (request: ModelRequest | undefined) => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of items) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as {
        trusted_review: { kind: string; policy: string; outcomes?: readonly string[] };
      };
  }
  throw new Error("No review request");
};

const recording = () => {
  const names: string[] = [];
  const record: GuardianDiagnostics["emit"] = (name) => Effect.sync(() => void names.push(name));
  const diagnostics: GuardianDiagnostics = {
    emit: record,
    retainModelTranscript: record,
    retainScreenedSource: () => Effect.void,
  };
  return { names, diagnostics };
};

type Guardian = ReturnType<typeof makeGuardian>;
type Review = (
  guardian: Guardian,
) => Effect.Effect<{ readonly decision: { readonly outcome: string } }, ReviewFailure>;

const kinds: Record<"question" | "update" | "execution", Review> = {
  question: (guardian) =>
    guardian.reviewQuestion(pending, question, readSource),
  update: (guardian) =>
    guardian.reviewTaskUpdate(pending, update, readSource),
  execution: (guardian) => guardian.review(pending, readSource),
};

const guardianWith = (diagnostics?: GuardianDiagnostics) =>
  makeGuardian(
    { ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), retry: quickRetry },
    diagnostics,
  );

it.each([
  ["question", "allow", "reword"],
  ["update", "deny", "clarify"],
  ["execution", "reword", "deny"],
] as const)(
  "tells a %s review once, in the same review, that %s is not its outcome, and takes the next",
  async (kind, refused, accepted) => {
    const requests = scripted([decision(refused), decision(accepted)]);
    const { names, diagnostics } = recording();
    const reviewed = await Effect.runPromise(kinds[kind](guardianWith(diagnostics)));
    expect(reviewed.decision).toMatchObject({ outcome: accepted });
    expect(requests).toHaveLength(2);
    expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
    expect(names).not.toContain("guardian.review_retried");
  },
);

it.each([
  ["question", "allow", "reword"],
  ["update", "escalate", "allow"],
  ["execution", "allow_business", "deny"],
] as const)(
  "ends a %s review that returns %s again after the correction, without reviewing again",
  async (kind, refused, accepted) => {
    // A third response the host would accept: reviewing again would reach it.
    const requests = scripted([decision(refused), decision(refused), decision(accepted)]);
    const { names, diagnostics } = recording();
    const result = await Effect.runPromise(Effect.either(kinds[kind](guardianWith(diagnostics))));
    expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
    expect(requests).toHaveLength(2);
    expect(names).not.toContain("guardian.review_retried");
    expect(names.filter((name) => name === "guardian.failed")).toHaveLength(1);
  },
);

// Outcomes that are only outcome names: `allow` is also a verb every policy uses, and
// `authentication` is also an execution's action label.
const outcomeNames = guardianOutcomes.filter(
  (outcome) => outcome !== "allow" && !(guardianActions as readonly string[]).includes(outcome),
);

it.each([
  ["question", "reword"],
  ["update", "clarify"],
  ["execution", "deny"],
] as const)("asks a %s review only for the outcomes the host accepts from it", async (kind, any) => {
  const requests = scripted([decision(any)]);
  await Effect.runPromise(kinds[kind](guardianWith()));
  const { outcomes: offered, policy } = reviewRequest(requests[0]).trusted_review;
  expect(offered?.length).toBeGreaterThan(0);
  for (const outcome of guardianOutcomes) {
    const answered = scripted([
      decision(outcome, kind === "execution" ? "read" : null),
      decision(outcome, kind === "execution" ? "read" : null),
    ]);
    const result = await Effect.runPromise(Effect.either(kinds[kind](guardianWith())));
    if (offered?.includes(outcome)) {
      expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome } } });
      expect(answered).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
      // The kind's own policy never names an outcome the host refuses from it.
      if (kind !== "execution" && outcomeNames.includes(outcome))
        expect(policy).not.toMatch(new RegExp(`\\b${outcome}\\b`));
    }
  }
});

// A write build confirming a page default before its first act step: the host gives the review
// the build's effect and an empty allowedEffects, and the policy says the empty list, like the
// read-only effects of earlier exploration reviews, says nothing about the build's effect.
it("tells a write build's task update review that its empty allowedEffects says nothing of its effect", async () => {
  const requests = scripted([decision("allow")]);
  const reviewed = await Effect.runPromise(
    guardianWith().reviewTaskUpdate(
      { ...pending, allowedEffects: [] },
      { ...update, effect: "write" },
      readSource,
    ),
  );
  expect(reviewed.decision).toMatchObject({ outcome: "allow" });
  const request = reviewRequest(requests[0]) as unknown as {
    trusted_review: { policy: string };
    trusted_authority: { allowedEffects: readonly string[] };
    update_review: { effect: string };
  };
  expect(request.trusted_authority.allowedEffects).toEqual([]);
  expect(request.update_review.effect).toBe("write");
  expect(request.trusted_review.policy).toContain(
    "The host sets update_review.effect, not the agent. When it is write, the build is already a write build: no change needs to make it one, and the confirmation need not cover the write. In a task update review, trusted_authority.allowedEffects is empty on purpose, because an update performs no action on the site. That empty list, and the read-only allowedEffects of earlier exploration reviews, say nothing about the build's effect.",
  );
});
