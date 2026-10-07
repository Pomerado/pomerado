import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Clock, Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { signInUnavailableSummary } from "../../src/mint/sign-in-failure.js";
import { Deadline } from "../../src/runtime/deadline.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const prose = (text = "I stopped before publication."): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

const intentTools = new Set([
  "execute",
  "finish_build",
  "request_input",
  "report_blocked",
]);

/** One free-text question, as the agent asks it. */
const ask = (prompt: string) => ({ questions: [{ id: "report", type: "text", prompt }] });

const call = (name: string, input: unknown, id = name): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name,
      callId: id,
      arguments: JSON.stringify(
        intentTools.has(name) && typeof input === "object" && input !== null && !("intent" in input)
          ? { ...input, intent: `Synthetic ${name} purpose` }
          : input,
      ),
      status: "completed",
    },
  ],
});

const execution = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

it("asks in place, returns the answer to the model and continues to publication", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", {
          questions: [
            {
              id: "report",
              type: "choice",
              prompt: "Which public report?",
              options: [
                { id: "annual", label: "Annual" },
                { id: "quarterly", label: "Quarterly" },
              ],
            },
          ],
        }),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      askInput: () => Effect.succeed({ report: { type: "choice", value: "quarterly" } }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "published_revision" });
  // The answer reached the model as the tool result, and the same attempt went on.
  const answered = JSON.stringify(f.requests[1]?.input);
  expect(answered).toContain('\\"status\\":\\"answered\\"');
  expect(answered).toContain('\\"report\\":\\"quarterly\\"');
  expect(f.counts()).toMatchObject({ executed: 1, published: 1 });
  const inputTool = f.requests[0]?.tools?.find((candidate) => candidate.name === "request_input");
  expect(JSON.stringify(inputTool)).not.toContain('"credential"');
});

it("ends as no_response when the caller leaves a question unanswered", async () => {
  const f = await fixture((_request, index) =>
    index === 0 ? call("request_input", ask("Which public report?")) : prose(),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 1 });
  // The attempt ended with the unanswered question; the model was not asked again.
  expect(f.requests).toHaveLength(1);
});

it("cancels a continued model request within the original invocation", async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const controller = new AbortController();
  const f = await fixture((request, index) =>
    index === 0
      ? prose()
      : new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          entered.resolve();
        }),
  );
  const result = f.run(controller.signal).catch(() => undefined);
  await entered.promise;
  controller.abort();
  await result;
  expect(aborted).toBe(true);
  expect(f.requests).toHaveLength(2);
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
});

/** How many of the host's own messages in a model request's input name `code`. */
const hostMessagesNaming = (request: ModelRequest, code: string) =>
  (Array.isArray(request.input) ? request.input : []).filter(
    (item) =>
      typeof item === "object" &&
      "role" in item &&
      item.role === "user" &&
      typeof item.content === "string" &&
      item.content.includes(code),
  ).length;

// After a sign-in that sent nothing failed, an agent may give final answers without a tool call
// until the repeated-final guard ends the attempt. The first such answer gets the way
// past the failed sign-in back, once, and the guard still ends a model that keeps answering.
it("hands the first final answer after a failed sign-in its way past, once, before the guard ends the attempt", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "website_error" as const,
    providerReason:
      "Provider website_error: The login page returned an error; website said: 502 Bad Gateway nginx",
    nothingSubmitted: true as const,
  };
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" })
        : prose("An unchanged retry would fail the same way."),
    {
      reviewAndExecute: () => Effect.fail(new MintFailure({ code: "Unavailable", authentication })),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  // The execute, the answer that ended its segment, then three final answers in a row: the
  // guard still ends the attempt at the third.
  expect(f.requests).toHaveLength(5);
  // The host's own messages that carry the failed sign-in's root cause: only its guidance.
  expect(f.requests.map((request) => hostMessagesNaming(request, "website_error"))).toEqual([
    0, 0, 1, 1, 1,
  ]);
});

it("gives a final answer no sign-in guidance once the agent signs in again", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "website_error" as const,
    nothingSubmitted: true as const,
  };
  let attempts = 0;
  const f = await fixture(
    (_request, index) =>
      index <= 1
        ? call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            `authenticate_${index}`,
          )
        : prose(),
    {
      reviewAndExecute: () =>
        attempts++ === 0
          ? Effect.fail(new MintFailure({ code: "Unavailable", authentication }))
          : Effect.succeed({
              executionId: "authenticated",
              status: "completed" as const,
              effect: "not_sent" as const,
              authentication: { state: "authenticated" as const, effect: "verified" as const },
              observations: "Signed in.",
            }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests.map((request) => hostMessagesNaming(request, "website_error"))).toEqual(
    f.requests.map(() => 0),
  );
});

// A sign-in fails after the login was sent, then its one relogin fails too. Told to authenticate
// again, a model would get a bare refusal, and only the repeated-final guard would end the attempt.
// A failure with no sign-in left ends the build at once as sign-in unavailable, with its cause.
it("ends the build as sign_in_unavailable once a failed sign-in leaves none, never through the repeated-final guard", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  let signIns = 0;
  const f = await fixture(
    (_request, index) =>
      index <= 2
        ? call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            `authenticate_${index}`,
          )
        : prose("The site cannot be signed in."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication,
            ...(signIns++ === 0 ? {} : { spentSignIn: "relogin_spent" as const }),
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    summary: expect.stringContaining("flow_failed") as unknown,
  });
  // The two sign-ins, and the run ended with the second: no third call, no continuation prompt.
  expect(signIns).toBe(2);
  expect(f.requests).toHaveLength(2);
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

// Every sign-in verified, but the site lost its signed-in session on a page load, and the host
// could not sign in again. The build ends as sign-in unavailable on that cause, not a failed
// sign-in's, and the agent hears to report it rather than authenticate again.
it("ends the build as sign_in_unavailable when the site keeps no signed-in session", async () => {
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("execute", { ...execution, purpose: "test", target: "liveBrowser" }, "test"),
      ][index] ?? prose("The site does not keep its session."),
    {
      // The example completes; the live test finds the session gone for good.
      reviewAndExecute: (_submitted, beforeDispatch = Effect.void) =>
        executions++ === 0
          ? beforeDispatch.pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            )
          : Effect.fail(new MintFailure({ code: "Unavailable", sessionLoss: "session_not_kept" })),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
  // The owner's summary names the lost session, not a failed sign-in or a spent relogin.
  for (const other of [
    signInUnavailableSummary(undefined, undefined),
    signInUnavailableSummary(undefined, "relogin_spent"),
  ])
    expect(outcome.summary).not.toBe(other);
  const answer = JSON.stringify(f.requests[2]?.input);
  expect(answer).toContain("report_sign_in_unavailable");
  expect(answer).toContain('\\"sessionLoss\\":\\"session_not_kept\\"');
  expect(outcome.diagnostics.join("\n")).toContain('"sessionLoss":"session_not_kept"');
  expect(f.requests).toHaveLength(3);
});

// A task impossible as asked (the site does not offer the form, or the owner's constraints cannot
// be met) must not end only through the repeated-final guard as an unexplained failure. The
// minter ends it blocked, with a typed reason, at once.
it("ends the build blocked with its reason and explanation when the minter reports it, never through the repeated-final guard", async () => {
  const explanation = "The site offers no online form for this request; it takes it by phone only.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...execution, purpose: "explore" }),
        call("report_blocked", { reason: "site_lacks_capability", explanation }),
      ][index] ?? prose("The site does not offer this."),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability", explanation },
  });
  expect(outcome.hostFailure).toBeUndefined();
  // The blocked ending stopped the model: no continuation prompt followed it.
  expect(f.requests).toHaveLength(2);
  expect(f.counts()).toMatchObject({ published: 0 });
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

it("offers report_blocked on a build turn and never on the effect question turn", async () => {
  const question = await fixture(
    (_request, index) => (index === 0 ? call("request_input", effectQuestion()) : prose()),
    { askInput: () => Effect.succeed({ effect: { type: "choice", value: "read" } }) },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  await question.run();
  const build = await fixture(() => prose());
  await build.run();
  const offered = (requests: readonly ModelRequest[]) =>
    requests[0]?.tools?.map((tool) => tool.name) ?? [];
  expect(offered(question.requests)).not.toContain("report_blocked");
  expect(offered(build.requests)).toContain("report_blocked");
});

// Something the agent can still get past is not impossible as asked: the host refuses the blocked
// ending and says what to resolve first.
it("refuses report_blocked while a failed sign-in is unresolved", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" }),
        call("report_blocked", { reason: "policy", explanation: "The site refused the login." }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "login_poll",
              code: "AuthenticationFailed",
              providerAuthCode: "flow_failed",
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toBeUndefined();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("sign_in_unresolved");
});

it("refuses report_blocked while an unavailable review may still be resubmitted", async () => {
  let reviews = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("Which report?")),
        call("report_blocked", { reason: "policy", explanation: "Review is not available." }),
      ][index] ?? prose("Stopping."),
    {
      reviewQuestion: () =>
        reviews++ === 0
          ? Effect.fail(
              new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
            )
          : Effect.succeed({ outcome: "allow_business" as const, rationale: "Allowed." }),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toBeUndefined();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("review_unavailable_pending");
});

// A report Guardian's question review does not allow, or could not review, reaches the caller only
// as its reason.
it.each([
  {
    review: "reword",
    reviewQuestion: () =>
      Effect.succeed({ outcome: "reword" as const, rationale: "Website instructions." }),
  },
  {
    review: "unavailable",
    reviewQuestion: () =>
      Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" })),
  },
])(
  "records a blocked ending without its explanation when the review is $review",
  async ({ reviewQuestion }) => {
    const f = await fixture(
      (_request, index) =>
        index === 0
          ? call("report_blocked", {
              reason: "site_lacks_capability",
              explanation: "Call 555-0100 to finish this.",
            })
          : prose(),
      { reviewQuestion },
    );
    const outcome = await f.run();
    expect(outcome.blocked).toEqual({ reason: "site_lacks_capability" });
    expect(f.requests).toHaveLength(1);
  },
);

it("keeps a recoverable final answer on the continuation path, unblocked, through to publication", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        prose("The report may not be on this site."),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(outcome.blocked).toBeUndefined();
  expect(f.requests).toHaveLength(3);
});

// A build whose example already completed keeps it: once sign-in is unavailable, the outcome waits
// while the retained receipt may still publish, and a publication stands.
it("still publishes a retained receipt after sign-in becomes unavailable", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      reviewAndExecute: (submitted, beforeDispatch = Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication,
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch.pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const result = await f.run();
  expect(result).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(result).not.toHaveProperty("recoveryReason");
  // The model heard sign-in was unavailable, and its run went on to publish.
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[2]?.input)).toContain("report_sign_in_unavailable");
});

// A build holding a retained receipt waited for the repeated-final guard when the
// model declined to publish after sign-in became unavailable, three continuation prompts later.
// Its first final answer without a tool call ends the build with the sign-in outcome instead.
it("ends a build holding a retained receipt as sign_in_unavailable at the first final answer", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
      ][index] ?? prose("I will not publish; the site cannot be signed in."),
    {
      reviewAndExecute: (submitted, beforeDispatch = Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication,
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch.pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    summary: expect.stringContaining("flow_failed") as unknown,
  });
  // The example, the sign-in, the final answer: no continuation prompt followed it.
  expect(f.requests).toHaveLength(3);
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

// A login identity conflict at sign-in ends the build with the conflict's own status.
it("ends a build whose sign-in hits a login identity conflict as login_identity_conflict", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" })
        : prose(),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_resolve",
              code: "LoginIdentityConflict",
              nothingSubmitted: true,
            },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    recoveryReason: "login_identity_conflict",
  });
  expect(f.requests).toHaveLength(1);
});

// A sign-in whose cleanup the host could not confirm ends live work on its own
// terms, so it never says sign-in is unavailable, even beside a retained receipt.
it("gives no sign-in-unavailable ending to a sign-in whose cleanup is unconfirmed", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "ProviderUncertain" as const,
    cleanupCode: "StopUnconfirmed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
      ][index] ?? prose(),
    {
      reviewAndExecute: (submitted, beforeDispatch = Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(new MintFailure({ code: "Unavailable", authentication }))
          : beforeDispatch.pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("recoveryReason");
  expect(JSON.stringify(f.requests[2]?.input)).not.toContain("buildOutcome");
});

/**
 * An example receipt, then a sign-in that fails with none left, then the rest of the model's turns;
 * the host's own outcomes after the model stops keep their order.
 */
const receiptThenSpentSignIn = (
  later: readonly ModelResponse[],
  overrides: Partial<MintDependencies> = {},
  onRequest: (index: number) => void = () => undefined,
) =>
  fixture(
    (_request, index) => {
      onRequest(index);
      return (
        [
          call("execute", execution),
          call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            "authenticate",
          ),
          ...later,
        ][index] ?? prose()
      );
    },
    {
      reviewAndExecute: (submitted, beforeDispatch = Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication: {
                  phase: "login_poll",
                  code: "AuthenticationFailed",
                  providerAuthCode: "flow_failed",
                },
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch.pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
      ...overrides,
    },
  );

// Ending at the first final answer must not skip what the host settles after the
// model stops. A minter that left Guardian's input feedback unresolved still gets its last
// reviewed candidate published, privately and flagged.
it("still publishes the flagged input-feedback fallback when sign-in is unavailable", async () => {
  let fallbackPublications = 0;
  const f = await receiptThenSpentSignIn([call("finish_build", publication), prose()], {
    publish: () =>
      Effect.fail(
        new MintFailure({
          code: "ReviewDenied",
          review: {
            outcome: "escalate",
            reason: "input_feedback",
            reviewId: "review_one",
            rationale: "Correct the indicated input.",
            findings: [
              {
                path: "publication/definition.json",
                byteStart: 0,
                byteEnd: 1,
                category: "account_specific_enum",
              },
            ],
          },
        }),
      ),
    inputFeedbackFallback: {
      kept: () => true,
      outcome: () => "the host publishes it privately",
      flagPublished: Effect.void,
      publish: Effect.sync(() => {
        fallbackPublications++;
        return {
          publicationRef: "fallback-revision",
          diagnostics: [],
          categories: ["account_specific_enum"],
        };
      }),
    },
  });
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "fallback-revision",
  });
  expect(fallbackPublications).toBe(1);
  // The final answer after the feedback ended the model: no continuation prompt followed.
  expect(f.requests).toHaveLength(4);
});

// A host that becomes unavailable after the last tool call still ends with its own cause.
it("ends with the host's own cause when the host fails after sign-in became unavailable", async () => {
  let hostDown = false;
  const f = await receiptThenSpentSignIn(
    [prose()],
    { executionAvailability: () => (hostDown ? "host_unavailable" : "open") },
    (index) => {
      if (index === 2) hostDown = true;
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", hostFailure: "host_unavailable" });
  expect(outcome).not.toHaveProperty("recoveryReason");
});

it("preserves finite reconciliation errors through the actual SDK tool boundary", async () => {
  const f = await fixture((_request, index) =>
    index === 0
      ? call("execute", { ...execution, purpose: "residual" })
      : call("request_input", ask("Which report?")),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
  expect(JSON.stringify(f.requests[1]?.input)).toContain("ReconciliationRequired");
  expect(JSON.stringify(f.requests[1]?.input)).toContain("intent_input");
  expect(f.counts().executed).toBe(0);
});

// a read's live test may run an input the agent picks, as JSON text.
it("carries a live test's agent-chosen input through the actual SDK tool boundary", async () => {
  const received: unknown[] = [];
  const liveTest = { ...execution, purpose: "test", target: "liveBrowser" };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...liveTest, testInput: '{"amountMinor":12}' }, "agent_input"),
        call("execute", liveTest, "caller_input"),
      ][index] ?? prose(),
    {
      reviewAndExecute: (input, beforeDispatch = Effect.void) =>
        beforeDispatch.pipe(
          Effect.zipRight(
            Effect.sync(() => ({
              executionId: `execution_${received.push(input)}`,
              status: "completed" as const,
              effect: "verified" as const,
              observations: { value: "public" },
            })),
          ),
        ),
    },
  );
  await f.run();
  expect(received).toEqual([
    expect.objectContaining({ purpose: "test", testInput: '{"amountMinor":12}' }),
    expect.objectContaining({ purpose: "test" }),
  ]);
  expect(received[1]).not.toHaveProperty("testInput");
});

it("keeps installed skills readable and protected from editing after prose continuation", async () => {
  const read = { path: ".agents/core/SKILL.md", offset: null, limit: null };
  const f = await fixture(
    (_request, index) =>
      [
        prose(),
        call("read_source", read, "read_skill_before"),
        {
          usage: new Usage(),
          output: [
            {
              type: "apply_patch_call" as const,
              callId: "edit_skill",
              status: "completed" as const,
              operation: {
                type: "update_file" as const,
                path: ".agents/core/SKILL.md",
                diff: "@@\n-Publish through finish_build or request legitimate missing input.\n+UNAUTHORIZED replacement",
              },
            },
          ],
        },
        call("read_source", read, "read_skill_after"),
        call("request_input", ask("Which public report?")),
      ][index] ?? prose(),
  );
  const result = await f.run();
  expect(result.diagnostics).toEqual([]);
  expect(result).toMatchObject({ build: "incomplete", noResponse: { possibleCommit: false } });
  expect(f.requests).toHaveLength(5);
  const input = f.requests[4]?.input;
  if (!Array.isArray(input)) throw new Error("Missing continued history");
  expect(
    input.find((item) => item.type === "apply_patch_call_output" && item.callId === "edit_skill"),
  ).toMatchObject({ status: "failed" });
  const reads = input.filter(
    (item) =>
      item.type === "function_call_result" &&
      ["read_skill_before", "read_skill_after"].includes(item.callId),
  );
  expect(reads).toHaveLength(2);
  const [before, after] = reads.map((read) => ("output" in read ? read.output : undefined));
  expect(before).toBeDefined();
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain("UNAUTHORIZED replacement");
});

it.each([false, true])(
  "honors only the host repeatableRead receipt across continuation (enabled=%s)",
  async (repeatableRead) => {
    let executions = 0;
    const chosenId = repeatableRead ? "execution_two" : "execution_one";
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", execution, "first_read"),
          prose("Continue the source repair using the host receipt."),
          call("execute", execution, "second_read"),
          call("finish_build", { ...publication, executionId: chosenId }),
        ][index] ?? prose(),
      {
        repeatableRead,
        reviewAndExecute: (_input, beforeDispatch = Effect.void) =>
          beforeDispatch.pipe(
            Effect.zipRight(
              Effect.sync(() => {
                executions++;
                return {
                  executionId: executions === 1 ? "execution_one" : "execution_two",
                  status: "completed" as const,
                  effect: "verified" as const,
                  resultRef: `protected_${executions}`,
                  observations: { value: "public" },
                };
              }),
            ),
          ),
      },
    );
    expect(await f.run()).toMatchObject({ build: "published" });
    expect(executions).toBe(repeatableRead ? 2 : 1);
    expect(f.requests).toHaveLength(4);
    const continued = f.requests[2]?.input;
    if (!Array.isArray(continued)) throw new Error("Missing continued history");
    const receipt = continued.find(
      (item) => item.type === "function_call_result" && item.callId === "first_read",
    );
    expect(JSON.stringify(receipt)).toContain(`repeatableRead\\":${repeatableRead}`);
    if (!repeatableRead) expect(JSON.stringify(f.requests[3]?.input)).toContain("AlreadyExecuted");
  },
);

// A source-store or generic publication outage is offered back to the minter instead (see
// mint-harness.test.ts).
it.each([
  new MintFailure({ code: "PublicationUnavailable", reason: "executor_unavailable" }),
  new MintFailure({ code: "PublicationUnavailable", reason: "registry_publication" }),
])(
  "ends publication infrastructure failure once while retaining the example: $code/$reason",
  async (failure) => {
    let publications = 0;
    const f = await fixture(
      (_request, index) =>
        index === 0
          ? call("execute", execution)
          : call("finish_build", publication, `finish_${index}`),
      {
        repeatableRead: true,
        publish: () =>
          Effect.suspend(() => {
            publications++;
            return Effect.fail(failure);
          }),
      },
    );
    const result = await f.run();
    expect(result).toMatchObject({
      build: "incomplete",
      example: {
        executionId: "execution_one",
        status: "completed",
        effect: "verified",
        resultRef: "protected_result",
      },
    });
    expect(f.requests).toHaveLength(2);
    expect(publications).toBe(1);
    expect(f.counts().executed).toBe(1);
    expect(result.diagnostics).toContain(
      JSON.stringify({
        phase: "publication",
        code: failure.code,
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
      }),
    );
  },
);

it("continues actionable publication source repair and publishes without redispatch", async () => {
  let publications = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "finish_before_repair"),
        prose("The current source needs correction."),
        {
          usage: new Usage(),
          output: [
            {
              type: "apply_patch_call" as const,
              callId: "repair_source",
              status: "completed" as const,
              operation: {
                type: "update_file" as const,
                path: "src/tool.ts",
                diff: "@@\n-export default {};\n+export default { repaired: true };",
              },
            },
          ],
        },
        call("finish_build", publication, "finish_after_repair"),
      ][index] ?? prose(),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return publications === 1
            ? Effect.fail(
                new MintFailure({ code: "PublicationUnavailable", reason: "source_validation" }),
              )
            : Effect.succeed({ publicationRef: "repaired_publication", diagnostics: [] });
        }),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "repaired_publication",
  });
  expect(publications).toBe(2);
  expect(f.counts().executed).toBe(1);
  const source = await f.workspace.readFile?.({ path: "src/tool.ts" });
  const repaired = typeof source === "string" ? source : new TextDecoder().decode(source);
  expect(repaired).toContain("repaired: true");
  expect(JSON.stringify(f.requests[2]?.input)).toContain("source_validation");
});

it.each(["authentication", "reword"] as const)(
  "never asks the caller after Guardian question outcome %s",
  async (outcome) => {
    const reviewed: unknown[] = [];
    let loginRequests = 0;
    const f = await fixture(
      (_request, index) =>
        index === 0 ? call("request_input", ask("What is your password?")) : prose(),
      {
        reviewQuestion: (question) =>
          Effect.sync(() => {
            reviewed.push(question);
            return { outcome, rationale: "Use the host's sign-in or reword." };
          }),
        requestLogin: () =>
          Effect.sync(() => {
            loginRequests++;
            return "supplied" as const;
          }),
      },
      { siteOrigin: "https://site.invalid" },
    );
    await f.run();
    expect(reviewed).toEqual([ask("What is your password?")]);
    const feedback = JSON.stringify(f.requests[1]?.input);
    expect(feedback).toContain(
      outcome === "authentication" ? "login_request" : "question_rejected",
    );
    // Guardian's authentication outcome raises the host's own login request instead.
    expect(loginRequests).toBe(outcome === "authentication" ? 1 : 0);
    expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
  },
);

it("ends a question-review outage that outlasts its budget without creating input or continuing prose", async () => {
  const base = Clock.make();
  let now = 1_000_000;
  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => now,
    unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => base.sleep(duration),
  };
  const f = await fixture(
    (_request, index) => call("request_input", ask("Which report?"), `request_input_${index}`),
    {
      // Each review the host could not complete took six minutes of retries.
      reviewQuestion: () =>
        Effect.sync(() => {
          now += 6 * 60_000;
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
            ),
          ),
        ),
    },
  );
  expect(await f.run(undefined, clock)).toMatchObject({ build: "incomplete" });
  // Outages at 0, 6 and 12 minutes may be resubmitted; the one at 18 minutes ends the attempt.
  expect(f.requests).toHaveLength(4);
  expect(f.counts().asked).toBe(0);
});

it("waits for question approval before persisting pending input and respects cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const f = await fixture(() => call("request_input", ask("Which report?")), {
    reviewQuestion: () => Effect.sync(() => entered.resolve()).pipe(Effect.zipRight(Effect.never)),
  });
  const result = f.run(controller.signal).catch(() => undefined);
  await entered.promise;
  expect(f.counts().asked).toBe(0);
  controller.abort();
  await result;
  expect(f.counts().asked).toBe(0);
});

const effectQuestion = (options = ["write", "read"]) => ({
  questions: [
    {
      id: "effect",
      type: "choice",
      prompt: "This books a table. Should the tool change the site?",
      options: options.map((id) => ({ id, label: id === "read" ? "Look things up" : "Change it" })),
    },
  ],
});

it("offers only request_input on the effect question turn and records the owner's answer", async () => {
  const recorded: string[] = [];
  const f = await fixture(
    (_request, index) => (index === 0 ? call("request_input", effectQuestion()) : prose()),
    {
      askInput: () => Effect.succeed({ effect: { type: "choice", value: "write" } }),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["request_input"]);
  expect(recorded).toEqual(["write"]);
  expect(f.counts()).toMatchObject({ executed: 0, published: 0 });
});

it("refuses an effect question whose options are not read and write, then asks the corrected one", async () => {
  const recorded: string[] = [];
  const offered: string[][] = [];
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("request_input", effectQuestion(["book", "cancel"]), "wrong_options")
        : call("request_input", effectQuestion(), "read_write"),
    {
      askInput: (asked) =>
        Effect.sync(() => {
          offered.push(
            asked.questions.flatMap((question) =>
              question.type === "choice" ? question.options.map((option) => option.id) : [],
            ),
          );
          return { effect: { type: "choice" as const, value: "read" } };
        }),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  await f.run();
  expect(JSON.stringify(f.requests[1]?.input)).toContain("effect_question_shape");
  // Only the corrected question reached the owner.
  expect(offered).toEqual([["write", "read"]]);
  expect(recorded).toEqual(["read"]);
});

// Every tool but request_input is absent on this turn; one file tool shows nothing runs.
it("refuses a file tool call on the effect question turn without running it", async () => {
  const attempt = call(
    "apply_patch",
    { type: "create_file", path: "src/probe.ts", diff: "+probe" },
    "file_attempt",
  );
  const f = await fixture(
    (_request, index) => (index === 0 ? attempt : call("request_input", effectQuestion())),
    {},
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  const result = await f.run();
  // The SDK has no such tool this turn, so the attempt ends before anything runs or asks.
  expect(result).toMatchObject({ build: "incomplete", executions: [] });
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
  expect(await f.workspace.pathExists?.("src/probe.ts")).toBe(false);
});

it("keeps Guardian rationale and identity through a nested SDK error", async () => {
  const rationale = "The proposed request creates a second order; read the existing order instead.";
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", execution)
        : call("request_input", ask("Which existing order?")),
    {
      preflight: () =>
        Effect.die(
          new Error("private-password-canary", {
            cause: new MintFailure({
              code: "ReviewDenied",
              review: { outcome: "deny", reviewId: "review_nested", rationale },
            }),
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
  const feedback = JSON.stringify(f.requests[1]?.input);
  expect(feedback).toContain(rationale);
  expect(feedback).toContain("review_nested");
  expect(feedback).toContain("ReviewDenied");
  expect(feedback).not.toContain("private-password-canary");
  expect(f.counts().executed).toBe(0);
});

it("returns execution allow and publication correction explanations to the minter", async () => {
  const allowed = {
    reviewId: "review_allowed",
    outcome: "allow" as const,
    rationale: "This request only reads the caller's existing report.",
  };
  const correction =
    "The name promises every report but the retained result contains only one page.";
  let publications = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "first_publication"),
        call("finish_build", publication, "corrected_publication"),
      ][index] ?? prose(),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "execution_one",
          status: "completed",
          effect: "verified",
          resultRef: "protected_result",
          observations: { total: 1 },
          review: allowed,
        }),
      publish: () =>
        Effect.suspend(() =>
          ++publications === 1
            ? Effect.fail(
                new MintFailure({
                  code: "ReviewDenied",
                  review: {
                    outcome: "deny",
                    reviewId: "review_publication",
                    rationale: correction,
                  },
                }),
              )
            : Effect.succeed({
                publicationRef: "published_revision",
                diagnostics: [],
                review: { ...allowed, rationale: "The narrower claim matches the retained page." },
                shareability: {
                  visibility: "private",
                  reason: "tenant_specific",
                  rationale: "The hostname identifies one employer.",
                },
              }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(JSON.stringify(f.requests[1]?.input)).toContain(allowed.rationale);
  expect(JSON.stringify(f.requests[2]?.input)).toContain(correction);
});

/** An error shaped like the OpenAI SDK's, after its own retries. */
const providerError = (name: string, status?: number) =>
  Object.assign(new Error(`Synthetic ${name}`), {
    name,
    ...(status === undefined ? {} : { status }),
  });

const quickModelRetry = { delaysMs: [1] as [number], budgetMs: 60_000, reserveMs: 0 };

it("retries a model call the provider could not answer with the same request, then publishes", async () => {
  const f = await fixture(
    (_request, index) => {
      if (index === 0) throw providerError("InternalServerError", 500);
      if (index === 1) throw providerError("APIConnectionError");
      if (index === 2) throw providerError("RateLimitError", 429);
      return [call("execute", execution), call("finish_build", publication)][index - 3] ?? prose();
    },
    {},
    {},
    { modelRetry: quickModelRetry },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(f.requests).toHaveLength(5);
  // The host retried the same call from the same state: nothing the agent saw changed.
  expect(JSON.stringify(f.requests[3]?.input)).toBe(JSON.stringify(f.requests[0]?.input));
  expect(f.counts()).toEqual({ executed: 1, published: 1, asked: 0 });
});

it("does not retry a refused request", async () => {
  const f = await fixture(
    () => {
      throw providerError("BadRequestError", 400);
    },
    {},
    {},
    { modelRetry: quickModelRetry },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests).toHaveLength(1);
});

it("stops retrying a model outage when the attempt has too little time left to use it", async () => {
  const f = await fixture(
    () => {
      throw providerError("InternalServerError", 503);
    },
    { deadline: Deadline.after(5_000) },
    {},
    { modelRetry: { delaysMs: [1], budgetMs: 60_000, reserveMs: 10_000 } },
  );
  // The provider, not the agent, ended the attempt.
  expect(await f.run()).toMatchObject({ build: "incomplete", hostFailure: "model_unavailable" });
  expect(f.requests).toHaveLength(1);
});

it("tells the agent when its model calls near the attempt's capacity and how close the final-answer cap is", async () => {
  const f = await fixture(
    (_request, index) =>
      index < 8 ? call("read_source", { path: "src/tool.ts", offset: null, limit: null }) : prose(),
    {},
    {},
    { modelCallCapacity: 12, segmentTurns: 4 },
  );
  // Spending the model calls is the agent's own outcome, never the host's.
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete" });
  expect(outcome).not.toHaveProperty("hostFailure");
  const told = (index: number) => JSON.stringify(f.requests[index]?.input);
  // The segment that crosses into the last one's worth of calls carries the notice.
  expect(told(7)).not.toContain("of the 12 model calls");
  expect(told(8)).toContain("8 of the 12 model calls");
  expect(told(9)).toContain("1 of 3 times");
  expect(told(10)).toContain("2 of 3 times");
});
