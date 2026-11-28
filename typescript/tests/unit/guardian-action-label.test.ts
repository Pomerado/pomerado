// Failure modes covered: an execution allow without an action label is taken as a decision
// instead of a malformed review; a write label on a step without write authority is allowed; a
// step with write authority loses its write label.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const pending: PendingExecution = {
  invocationId: "label_job",
  attemptId: "label_attempt",
  entrypoint: "operation/save.mjs",
  screenedIntent: "Save the synthetic note",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_label",
  allowedOrigins: ["https://notes.example.test"],
  allowedEffects: ["Synthetic step authority"],
};
const reader = makeSourceInspector(
  (path) =>
    path === "operation/save.mjs"
      ? Effect.succeed(new TextEncoder().encode("export default 'click save';"))
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

const decision = (value: Record<string, unknown>): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({ reason: null, findings: null, label: null, action: null, ...value }),
      },
    ],
  },
];
/** Guardian's model, answering each request with the next scripted output. */
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
const guardian = (diagnostics?: GuardianDiagnostics) =>
  makeGuardian(
    {
      ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
        executionEnvironment: nativeExecutionEnvironment,
      }),
      retry: { delays: ["1 millis"], budget: "1 minute" },
    },
    diagnostics,
  );

it("asks once, in the same review, for the action label an execution allow lacks", async () => {
  const requests = scripted([
    decision({ outcome: "allow", rationale: "Clicks save." }),
    decision({ outcome: "allow", rationale: "Clicks save.", action: "read" }),
  ]);
  const names: string[] = [];
  const record: GuardianDiagnostics["emit"] = (name) => Effect.sync(() => void names.push(name));
  const reviewed = await Effect.runPromise(
    guardian({
      emit: record,
      retainModelTranscript: record,
      retainScreenedSource: () => Effect.void,
    }).review(pending, reader),
  );
  expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
  expect(names).not.toContain("guardian.review_retried");
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Clicks save.",
    action: "read",
  });
  expect(requests).toHaveLength(2);
});

it("denies a write label on a step without write authority, as a read build's", async () => {
  scripted([decision({ outcome: "allow", rationale: "Saves the note.", action: "write" })]);
  const reviewed = await Effect.runPromise(guardian().review(pending, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: expect.stringContaining("Out of authority") as unknown,
    action: "write",
  });
});

it("allows a write label on a write build's write step", async () => {
  scripted([decision({ outcome: "allow", rationale: "Saves the note.", action: "write" })]);
  const reviewed = await Effect.runPromise(
    guardian().review({ ...pending, writeAuthority: true }, reader),
  );
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Saves the note.",
    action: "write",
  });
});

// A read build's step the site requires before the task, which an applied update the owner
// confirmed names, may run as the build's one write once Guardian allows it as a write. Without
// that confirmation, once a write is on record, or in a write build outside its write session
// (no repeatable read), the label stays out of authority.
const siteRequiredUpdate = {
  revision: 1,
  summary: "Finish the profile form the site requires before the search.",
  changes: [
    {
      setting: "requirement" as const,
      change: "add" as const,
      text: "Submit the site's required profile form with the name the owner gave.",
    },
  ],
  confirmation: [
    {
      id: "profile",
      question: "May the build submit the profile form the site requires?",
      answer: { confirmed: true },
    },
  ],
};
const siteRequiredContext = {
  repeatableRead: true,
  operationSources: ["operation/save.mjs"],
  currentExecution: { purpose: "explore" as const, target: "liveBrowser" as const },
  browser: "active" as const,
  executions: [],
};
const siteRequired: PendingExecution = {
  ...pending,
  taskUpdates: [siteRequiredUpdate],
  mintContext: siteRequiredContext,
};
it.each([
  { case: "an applied update the owner confirmed", step: siteRequired, allowed: true },
  {
    case: "an update nobody confirmed",
    step: { ...siteRequired, taskUpdates: [{ ...siteRequiredUpdate, confirmation: [] }] },
    allowed: false,
  },
  {
    case: "a write build's explore step",
    step: { ...siteRequired, mintContext: { ...siteRequiredContext, repeatableRead: false } },
    allowed: false,
  },
  {
    case: "a write already on record",
    step: {
      ...siteRequired,
      mintContext: {
        ...siteRequiredContext,
        writes: [{ executionId: "exec_profile", purpose: "explore", outcome: "done" as const }],
      },
    },
    allowed: false,
  },
])("decides a site-required step's write allow with $case: allowed $allowed", async ({ step, allowed }) => {
  scripted([decision({ outcome: "allow", rationale: "Submits the profile.", action: "write" })]);
  const reviewed = await Effect.runPromise(guardian().review(step, reader));
  expect(reviewed.decision).toMatchObject({
    outcome: allowed ? "allow" : "deny",
    action: "write",
  });
});
