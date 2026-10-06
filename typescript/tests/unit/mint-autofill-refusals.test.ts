import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { autofillRefusalFailure } from "../../src/mint/sign-in-failure.js";
import { makeLiveAuthentication } from "../../src/standalone/authentication.js";
import { mintError } from "../../src/standalone/errors.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const site = "https://member.example.test";
const login = `${site}/login`;
const target = {
  ownerUrl: login,
  documentOrigin: site,
  actions: [`${site}/session`],
  methods: ["post"],
  submitMethod: "post",
  editable: true,
  control: "text",
} as const;
const described = {
  tag: "input",
  role: null,
  formMethod: "post",
  type: "password",
  name: "password",
  id: "password",
  autocomplete: "current-password",
  inputmode: null,
  label: "Password",
  placeholder: null,
  ariaLabel: null,
  text: null,
};
/** The synthetic password screen as the host's inspection finds it. */
const inspected = {
  fields: [{ target, described }],
  submit: {
    target,
    described: { ...described, tag: "button", type: "submit", name: null, id: "sign-in" },
  },
  buttons: ["Sign in"],
  url: login,
};
/** How the field answers the host's focus: it takes the focus, or an overlay keeps it. */
const focusAnswers = {
  typing_refused: { focused: true, url: login },
  not_focused: { focused: false, unfocused: { activeTag: "DIV" }, url: login },
} as const;

/**
 * A synthetic password screen behind the standalone host's sign-in: each authenticate inspects
 * it, then focuses the field. The page's own code swallows the inserted text, so the typing never
 * lands, or, for `not_focused`, an overlay keeps the focus.
 */
const passwordScreen = (refusals: readonly (keyof typeof focusAnswers)[]) => {
  const answers = refusals.flatMap((refusal) => [inspected, focusAnswers[refusal]]);
  const auth = makeLiveAuthentication({
    page: {
      targetId: "primary",
      execute: () => Effect.sync(() => answers.shift() ?? { error: "not_found", target: 0 }),
    },
    keyboard: { insertText: () => Effect.succeed("insertion_rejected" as const) },
    siteOrigin: site,
    authenticationOrigins: [],
    ask: (request) =>
      Effect.succeed(
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            { type: "secret" as const, value: "synthetic-password" },
          ]),
        ),
      ),
    registerSecret: () => {},
    review: () => Effect.void,
  });
  let executions = 0;
  return {
    executions: () => executions,
    reviewAndExecute: ((execution, beforeDispatch = Effect.void) =>
      Effect.gen(function* () {
        executions++;
        const signIn = "signInStep" in execution ? execution.signInStep : undefined;
        if (signIn === undefined || !("fields" in signIn))
          return yield* Effect.die("The test signs in by autofill only");
        const report = yield* auth.step(signIn, beforeDispatch);
        return {
          executionId: `sign_in_${executions}`,
          status: "completed" as const,
          effect: "possible" as const,
          observations: report,
        };
      }).pipe(Effect.mapError(mintError))) satisfies MintDependencies["reviewAndExecute"],
  };
};

const signInStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const authenticate = (callId: string): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name: "execute",
      callId,
      arguments: JSON.stringify({
        purpose: "authenticate",
        target: "liveBrowser",
        entrypoint: "src/tool.ts",
        fixtureRefs: [],
        caseFilter: [],
        maxWorkers: 1,
        timeoutSeconds: 30,
        intent: "Sign in to the synthetic member site",
        signInStep,
      }),
      status: "completed",
    },
  ],
});
const finalAnswer: ModelResponse = {
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The sign-in did not work." }],
    },
  ],
};

/** The execute answer the model read for `callId`. */
const answerTo = (request: ModelRequest | undefined, callId: string) => {
  const items = Array.isArray(request?.input) ? request.input : [];
  const item = items.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item?.type === "function_call_result" ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : output !== undefined && "text" in output
        ? output.text
        : "";
  return JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
};
/** The host's message to the model after its final answer, if any. */
const continuation = (request: ModelRequest | undefined) =>
  JSON.stringify(Array.isArray(request?.input) ? request.input.at(-1) : undefined);

it("routes a typing refusal on the password field to the unresolved sign-in, saying what was refused and why", async () => {
  const screen = passwordScreen(["typing_refused"]);
  const run = await fixture(
    (_request, index) => (index === 0 ? authenticate("sign_in_1") : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  const answer = answerTo(run.requests[1], "sign_in_1");
  expect(answer).toMatchObject({
    status: "authentication_unavailable",
    code: "AutofillRefused",
    nextStep: "authenticate",
    credentialSent: false,
    authentication: {
      code: "AutofillRefused",
      hostRefusal: { check: "typing_refused", field: 0, slot: "password" },
    },
  });
  // What was refused and why, by kind, with no value in it.
  expect(answer["notice"]).toContain("refused to type the password into field 1");
  expect(answer["notice"]).toContain("did not land in it");
  expect(JSON.stringify(answer)).not.toContain("synthetic-password");
  // A final answer then gets the unresolved sign-in's continuation, with the same notice.
  const guidance = continuation(run.requests[2]);
  expect(guidance).toContain("The last sign-in failed and nothing has resolved it yet");
  expect(guidance).toContain("did not land in it");
  expect(outcome.recoveryReason).toBeUndefined();
});

it("ends sign-in as unavailable after three identical refusals in a row", async () => {
  const screen = passwordScreen(["typing_refused", "typing_refused", "typing_refused"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(screen.executions()).toBe(3);
  expect(answerTo(run.requests[2], "sign_in_2")).toMatchObject({ nextStep: "authenticate" });
  // The third ends the build at once: the model is not asked again.
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
  expect(outcome.summary).toContain(
    "refused the same field of the same screen the same way 3 times",
  );
});

it("starts the count again when a different refusal breaks the run", async () => {
  const screen = passwordScreen(["typing_refused", "typing_refused", "not_focused"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(screen.executions()).toBe(3);
  const third = answerTo(run.requests[3], "sign_in_3");
  expect(third).toMatchObject({
    nextStep: "authenticate",
    authentication: { hostRefusal: { check: "not_focused", field: 0, slot: "password" } },
  });
  expect(third).not.toHaveProperty("buildOutcome");
  expect(third["notice"]).toContain("did not take the focus");
  expect(outcome.recoveryReason).not.toBe("sign_in_unavailable");
});

// A refusal whose sign-in cleanup the host could not confirm may have left the site signed in:
// the cleanup's own advice wins, and the agent is never told to sign in again.
it("keeps an unconfirmed cleanup's advice when the host also refused a field", async () => {
  let executions = 0;
  const run = await fixture(
    // The model follows the answer's next step: another authenticate only when it says so.
    (request, index) =>
      index === 0 || (index === 1 && answerTo(request, "sign_in_1")["nextStep"] === "authenticate")
        ? authenticate(`sign_in_${index + 1}`)
        : finalAnswer,
    {
      autofillSignIn: true,
      executionAvailability: () => "open",
      reviewAndExecute: (_execution, beforeDispatch = Effect.void) =>
        beforeDispatch.pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              executions++;
              const failure = autofillRefusalFailure(
                {
                  check: "typing_refused",
                  field: 0,
                  slot: "password",
                  screen: { fields: ["#password"], submit: "#sign-in" },
                },
                { nothingSubmitted: true },
              );
              return Effect.fail(
                new MintFailure({
                  ...failure,
                  authentication: {
                    ...(failure.authentication ?? {
                      phase: "credential_submit",
                      code: "AutofillRefused",
                    }),
                    cleanupCode: "StopUnconfirmed",
                  },
                }),
              );
            }),
          ),
        ),
    },
    { effect: "read", siteOrigin: site },
  );
  await run.run();
  expect(answerTo(run.requests[1], "sign_in_1")).toMatchObject({
    signInOutcome: "unknown",
    nextStep: "report_sign_in_unavailable",
  });
  expect(executions).toBe(1);
});
