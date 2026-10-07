// Failure modes covered: the question review lacks the execution review's trusted context or
// screened evidence tool; its evidence reads are unbounded; a question review demands an
// entrypoint read; rewording never ends; answers, credential values or full account-specific
// labels reach the reviewer.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { answersForReview, questionForReview } from "../../src/guardian/question.js";
import type { PendingQuestion } from "../../src/guardian/question.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer, ReviewTurn } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import type { InputRequest } from "../../src/runtime/input-request.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const observedPath = `/search?term=${"blue".repeat(700)}#results`;
const pending: PendingExecution = {
  invocationId: "question_job",
  attemptId: "question_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Book the cheapest plan the site offers for my team.",
  screenedInput: '{"team":"[private field withheld]"}',
  screenedObservations: "Entry page loaded.",
  accountScope: "account_a",
  allowedOrigins: ["https://plans.example.test"],
  allowedEffects: ["read plans"],
  mintContext: {
    repeatableRead: false,
    operationSources: ["operation/operation.mjs"],
    browser: "active",
    captureIndex: "captures/index.json",
    currentPage: {
      origin: "https://plans.example.test",
      path: observedPath,
      capture: "captures/pricing/capture.json",
    },
    executions: [
      {
        executionId: "explore_1",
        attempt: "current",
        purpose: "explore",
        target: "liveBrowser",
        status: "completed",
        effect: "verified",
      },
    ],
  },
};
const question: PendingQuestion = {
  questions: [
    {
      id: "plan",
      type: "choice",
      prompt: "Which plan?",
      options: [{ label: "Team" }, { label: "Business" }],
    },
    { id: "seats", type: "text", prompt: "How many seats?" },
  ],
  credentialsAvailable: false,
};

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
/** The host's JSON review input, the first user message of a request. */
const userText = (request: ModelRequest | undefined): string => {
  const input = request?.input;
  if (typeof input === "string") return input;
  const first = input?.find((item) => "role" in item && item.role === "user");
  const content = first !== undefined && "content" in first ? first.content : undefined;
  if (typeof content === "string") return content;
  throw new Error("No user input");
};
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

it("reviews a question with the execution context and the bounded capture reader", async () => {
  // Larger than one 64 KiB chunk: the reader must return a bounded first chunk.
  const capture = JSON.stringify({ plans: "Team $10 Business $20 ".repeat(5_000) });
  const captures = new Map([
    ["captures/index.json", '{"manifests":["captures/pricing/capture.json"]}'],
    ["captures/pricing/capture.json", capture],
  ]);
  const inspector = makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const source = captures.get(path);
        return source === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(source));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
  const reads: string[] = [];
  const requests = scripted([
    [
      {
        type: "function_call",
        callId: "call_1",
        name: "read_source",
        arguments: JSON.stringify({ path: "captures/pricing/capture.json", offset: 0 }),
        status: "completed",
      },
    ],
    [message({ outcome: "allow_business", rationale: "Plan choice needs the user." })],
  ]);
  const result = await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      (path, offset) =>
        inspector(path, offset).pipe(Effect.tap((chunk) => Effect.sync(() => reads.push(chunk)))),
    ),
  );
  expect(result.decision).toEqual({
    outcome: "allow_business",
    rationale: "Plan choice needs the user.",
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["read_source"]);
  const input: unknown = JSON.parse(userText(requests[0]));
  expect(input).toMatchObject({
    trusted_authority: { allowedOrigins: ["https://plans.example.test"] },
    trusted_execution_context: {
      captureIndex: "captures/index.json",
      currentPage: {
        origin: "https://plans.example.test",
        path: observedPath,
        capture: "captures/pricing/capture.json",
      },
      executions: [{ executionId: "explore_1", status: "completed" }],
    },
    question_review: {
      request: { questions: question.questions },
      credentialsAvailable: false,
    },
  });
  // No entrypoint read was needed, and the one evidence read stayed within one chunk.
  expect(reads).toHaveLength(1);
  const chunk: unknown = JSON.parse(reads[0] ?? "");
  expect(chunk).toMatchObject({ hasMore: true, nextOffset: 64 * 1024 });
  expect(JSON.stringify(requests[1]?.input)).toContain("Team $10");
});

const decisions = (outcomes: readonly string[]) => {
  const seen: boolean[] = [];
  const reviewer: Reviewer = {
    run: (turn: ReviewTurn) =>
      Effect.sync(() => {
        seen.push(turn.pending.questionCandidate !== undefined);
        return { outcome: outcomes[seen.length - 1], rationale: "Scripted." };
      }),
  };
  return { reviewer, seen };
};
const unreadable: ReviewTurn["readSource"] = () =>
  Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }));

// Guardian's continuing conversation carries host sign-in rules from earlier reviews, which it
// then quoted as the owner forbidding sign-in when the minter asked which sign-in method to use.
it("tells the question review that host sign-in rules are never an owner's prohibition", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  const input = JSON.parse(userText(requests[0])) as { trusted_review: { policy: string } };
  expect(input.trusted_review.policy).toContain(
    "Other questions about signing in follow the rules above.\nHost policy about signing in, including text from an earlier review in this conversation, is never an owner's prohibition. Only trusted intent or an owner's answer can forbid signing in. That sign-in is not yet proven required is no reason to reword a sign-in method or account question whose choices match the page.\n",
  );
});

it("rejects a question candidate smuggled into an execution review", async () => {
  const { reviewer, seen } = decisions(["allow"]);
  const result = await Effect.runPromise(
    makeGuardian(reviewer)
      .review({ ...pending, questionCandidate: question }, unreadable)
      .pipe(Effect.either),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  expect(seen).toEqual([]);
});

it("reviews every string the caller will see, screened, but no host-held login detail", async () => {
  const request: Pick<InputRequest, "notice" | "questions"> = {
    notice: "Approve the sign-in on your phone.",
    questions: [
      {
        id: "card",
        type: "choice",
        prompt: "Which saved card?",
        options: [
          {
            id: "c1",
            label: "Visa ending 4242 for Jane Doe",
            accountSpecific: true,
            maskedLabel: "Visa ••42",
          },
          { id: "c2", label: "New card" },
        ],
      },
      {
        id: "dialog",
        type: "confirm",
        prompt: "Rename the report?",
        followUp: { prompt: "New name", defaultText: "Quarterly report" },
      },
      {
        id: "code",
        type: "secret",
        prompt: "Enter the code we texted",
        secretKind: "one_time_code",
      },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in",
        fields: "password",
        reason: "invalid_credentials",
        username: "PRIVATE_USERNAME",
        allowSave: true,
        siteOrigin: "https://PRIVATE_ORIGIN.example.test",
      },
    ],
  };
  const screened = await Effect.runPromise(
    questionForReview(request, { credentialsAvailable: true }, (text) =>
      Effect.succeed(`screened(${text})`),
    ),
  );
  // Every string the caller will see went through the screen; ids and types stay as they were.
  const strings = (value: unknown, key = ""): Array<readonly [string, string]> =>
    typeof value === "string"
      ? [[key, value]]
      : Array.isArray(value)
        ? value.flatMap((item) => strings(item, key))
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([name, item]) => strings(item, name))
          : [];
  const structural = new Set(["id", "type", "fields", "secretKind"]);
  const shown = strings(screened).filter(([key]) => !structural.has(key));
  expect(shown.filter(([, text]) => !text.startsWith("screened("))).toEqual([]);
  // The notice, four prompts, three option labels, the follow-up prompt and its default text.
  expect(shown).toHaveLength(10);
  expect(screened.questions.map((question) => [question.id, question.type])).toEqual([
    ["card", "choice"],
    ["dialog", "confirm"],
    ["code", "secret"],
    ["login", "credential"],
  ]);
  expect(screened.credentialsAvailable).toBe(true);
  // A host-raised login's username, site, reason and save choice never reach Guardian.
  expect(Object.keys(screened.questions[3] ?? {}).sort()).toEqual([
    "fields",
    "id",
    "prompt",
    "type",
  ]);
  expect(JSON.stringify(screened)).not.toContain("PRIVATE_");
  const requests = scripted([[message({ outcome: "authentication", rationale: "Login." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      screened,
      unreadable,
    ),
  );
  const sent = userText(requests[0]);
  expect(sent).toContain("screened(New name)");
  expect(sent).toContain("screened(Quarterly report)");
  expect(sent).toContain("screened(Visa ending 4242 for Jane Doe)");
  expect(sent).toContain("screened(Visa ••42)");
  expect(sent).not.toMatch(/PRIVATE_/u);
});

// Later reviews hear each plain answer with its question, as the minter does, and
// never a protected one, which only the broker or the credential store holds.
it("gives a review every plain answer, screened and masked, and no secret, login or notice confirm", async () => {
  const request: Pick<InputRequest, "questions"> = {
    questions: [
      {
        id: "plan",
        type: "choice",
        prompt: "Which plan?",
        options: [
          { id: "basic", label: "Basic" },
          {
            id: "team",
            label: "Team plan on account 4417",
            accountSpecific: true,
            maskedLabel: "Team plan",
          },
        ],
      },
      {
        id: "size",
        type: "choice",
        prompt: "Which size?",
        allowOther: true,
        options: [{ id: "small", label: "Small" }],
      },
      {
        id: "tier",
        type: "choice",
        prompt: "Which tier?",
        allowOther: true,
        options: [
          { id: "pro_monthly", label: "Pro" },
          { id: "pro_yearly", label: "Pro" },
        ],
      },
      {
        id: "extras",
        type: "multi_choice",
        prompt: "Which extras?",
        minSelections: 0,
        maxSelections: 2,
        options: [
          { id: "sso", label: "Single sign-on" },
          { id: "audit", label: "Audit log" },
        ],
      },
      {
        id: "go",
        type: "confirm",
        prompt: "Continue?",
        followUp: { prompt: "Team name?" },
      },
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "Code?" },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in",
        fields: "username_password",
        reason: "missing_credentials",
        allowSave: false,
        siteOrigin: "https://plans.example.test",
      },
    ],
  };
  const reviewed = await Effect.runPromise(
    answersForReview(
      request,
      {
        plan: { type: "choice", value: "team" },
        size: { type: "choice", value: { other: "Twelve seats" } },
        // Own text repeating a label two options share stays text, but the agent wrote it.
        tier: { type: "choice", value: { other: "Pro" } },
        extras: { type: "multi_choice", value: ["audit", "sso"] },
        go: { type: "confirm", value: { confirmed: true, text: "Platform" } },
        code: { type: "secret", value: "secret-canary-2718" },
        login: {
          type: "credential",
          value: { username: "owner@example.test", password: "password-canary", saveLogin: false },
        },
      },
      (text) => Effect.succeed(`<${text}>`),
    ),
  );
  expect(reviewed).toEqual([
    { question: "<Which plan?>", answer: "<Team plan>" },
    { question: "<Which size?>", answer: "<Twelve seats>", typed: true },
    { question: "<Which tier?>", answer: "<Pro>" },
    { question: "<Which extras?>", answer: ["<Audit log>", "<Single sign-on>"] },
    { question: "<Continue?>", answer: { confirmed: true, text: "<Platform>" }, typed: true },
  ]);
  const notice = await Effect.runPromise(
    answersForReview(
      {
        notice: "Approve the sign-in on your phone.",
        questions: [{ id: "done", type: "confirm", prompt: "Did you do it?" }],
      },
      { done: { type: "confirm", value: { confirmed: true } } },
      Effect.succeed,
    ),
  );
  expect(notice).toEqual([]);
});

it("gives a review the owner's own option and note beside their picks, as the owner's own words", async () => {
  const request: Pick<InputRequest, "questions"> = {
    questions: [
      {
        id: "store",
        type: "choice",
        prompt: "Which store?",
        allowOther: true,
        allowNote: true,
        options: [{ id: "main", label: "Main store at https://main.example.test" }],
      },
      {
        id: "regions",
        type: "multi_choice",
        prompt: "Which regions?",
        minSelections: 0,
        maxSelections: 1,
        allowOther: true,
        allowNote: true,
        options: [{ id: "north", label: "North" }],
      },
    ],
  };
  const reviewed = await Effect.runPromise(
    answersForReview(
      request,
      {
        store: {
          type: "choice",
          value: { option: "main", note: "Orders live at https://orders.tenant.example.org" },
        },
        regions: {
          type: "multi_choice",
          value: {
            options: ["north"],
            other: "Islands at https://islands.example.net",
            note: "Weekdays only",
          },
        },
      },
      (text) => Effect.succeed(`<${text}>`),
    ),
  );
  expect(reviewed).toEqual([
    {
      question: "<Which store?>",
      answer: "<Main store at https://main.example.test>",
      note: "<Orders live at https://orders.tenant.example.org>",
    },
    {
      question: "<Which regions?>",
      answer: ["<North>"],
      other: "<Islands at https://islands.example.net>",
      note: "<Weekdays only>",
      typed: true,
    },
  ]);
  // A later review carries both to Guardian, and their links name where the owner's work lives.
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      { ...pending, answeredQuestions: reviewed },
      question,
      unreadable,
    ),
  );
  const input: unknown = JSON.parse(userText(requests[0]));
  expect(input).toMatchObject({
    trusted_authority: {
      answeredQuestions: [
        { answer: "<Main store at https://main.example.test>", note: reviewed[0]?.note },
        { answer: ["<North>"], other: reviewed[1]?.other, note: "<Weekdays only>" },
      ],
      ownerNamedOrigins: ["https://orders.tenant.example.org", "https://islands.example.net"],
    },
  });
});

it("never takes an option label the owner typed back as a note or an own option for the owner's words", async () => {
  const label = "Main store at https://main.example.test";
  const reviewed = await Effect.runPromise(
    answersForReview(
      {
        questions: [
          {
            id: "store",
            type: "choice",
            prompt: "Which store?",
            allowOther: true,
            allowNote: true,
            options: [
              { id: "main", label },
              { id: "outlet", label: "Outlet" },
            ],
          },
          {
            id: "stores",
            type: "multi_choice",
            prompt: "Which stores?",
            minSelections: 0,
            maxSelections: 2,
            allowOther: true,
            allowNote: true,
            options: [
              { id: "main", label },
              { id: "outlet", label: "Outlet" },
            ],
          },
        ],
      },
      {
        store: { type: "choice", value: { option: "outlet", note: ` ${label.toUpperCase()} ` } },
        stores: { type: "multi_choice", value: { options: ["outlet"], other: label } },
      },
      Effect.succeed,
    ),
  );
  expect(reviewed).toEqual([
    { question: "Which store?", answer: "Outlet" },
    { question: "Which stores?", answer: ["Outlet"], other: label },
  ]);
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      { ...pending, answeredQuestions: reviewed },
      question,
      unreadable,
    ),
  );
  const input: unknown = JSON.parse(userText(requests[0]));
  expect(input).toMatchObject({ trusted_authority: { answeredQuestions: reviewed } });
  expect(input).not.toMatchObject({ trusted_authority: { ownerNamedOrigins: expect.anything() } });
});
