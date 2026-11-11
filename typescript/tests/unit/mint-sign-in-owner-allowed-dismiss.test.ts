import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import {
  hostAuthentication,
  type MintDependencies,
  type SignInStep,
} from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { reviewDenied } from "../../src/mint/review-context.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { mintError } from "../../src/standalone/errors.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * A notice that is not a cookie banner covers a read build's sign-in, and its only control accepts
 * updated terms. The owner said yes to accepting it, and the sign-in step names that control as
 * `dismiss` and cites the answer in `confirmedBy`: the step reaches review with the cite, the host
 * clicks the control and signs in, and the build stays a read. The recipe leaves that dismiss out,
 * so runs never accept the notice. A cite of a question this build has no answer to, or one the
 * owner declined, is refused before review, with nothing typed. Each scenario runs the real minter
 * loop on recorded model responses, with the standalone host's sign-in recorder over a synthetic
 * site and a recorded review.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const origin = "https://member.example.test";
const login = { username: "synthetic-owner", password: "synthetic-password" };
const accept = "#terms-accept";
const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/session`],
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
  name: null,
  id: null,
  autocomplete: null,
  inputmode: null,
  label: "Password",
  placeholder: null,
  ariaLabel: null,
  text: null,
};

/**
 * A synthetic site whose terms notice covers the sign-in submit until its accept control is
 * clicked. `review` stands for Guardian's review of each sign-in step, which `reviewed` records.
 */
const coveredSite = (
  review: (step: AutofillStep) => Effect.Effect<void, Error> = () => Effect.void,
) => {
  let fills = 0;
  let resubmits = 0;
  let covered = true;
  let signedIn = false;
  const reviewed: AutofillStep[] = [];
  const click = (step: AutofillStep): AutofillStepReport => {
    if (step.dismiss === accept) covered = false;
    const fields = step.fields.map((field) => ({ slot: field.slot, status: "filled" as const }));
    if (covered)
      return {
        outcome: "filled",
        fields,
        submit: "blocked",
        blockedBy: { tag: "div", role: "dialog" },
        url: `${origin}/login`,
      };
    signedIn = true;
    return { outcome: "filled", fields, submit: "clicked", url: `${origin}/account` };
  };
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step: AutofillStep) =>
        Effect.succeed<AutofillInspection>({
          url: `${origin}/login`,
          page: `${origin}/login`,
          targets: { fields: step.fields.map(() => target), submit: target },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({ ...described, slot: field.slot })),
            submit: described,
            buttons: [],
          },
        }),
      fill: ({ step }) =>
        Effect.sync(() => {
          fills += 1;
          return click(step);
        }),
      resubmit: ({ step }) =>
        Effect.sync(() => {
          resubmits += 1;
          return click(step);
        }),
      confirm: () =>
        Effect.sync(
          (): AutofillSignedInCheck =>
            signedIn
              ? { signedIn: true, url: `${origin}/account` }
              : { signedIn: false, failed: "indicator_not_visible", url: `${origin}/login` },
        ),
      authenticationOrigins: [],
      open: () => Effect.void,
      markerVisible: () => Effect.succeed(false),
    },
    login: {
      held: () => login,
      values: Effect.succeed(login),
      correct: () => Effect.succeed(login),
    },
    ask: () => Effect.dieMessage("The test asks the owner nothing through the sign-in"),
    secrets: { register: () => {}, assertAbsent: () => Effect.void },
    review: (step) => {
      reviewed.push(step);
      return review(step);
    },
    site: "member.example.test",
    signedOutPages: () => [],
  });
  let executions = 0;
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    execution,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      executions += 1;
      const signIn = "signInStep" in execution ? execution.signInStep : undefined;
      if (signIn === undefined) return yield* Effect.die("The test signs in by autofill only");
      const step = yield* recorder.step(
        signIn,
        `${origin}/login`,
        beforeDispatch(hostAuthentication),
      );
      return {
        executionId: `sign_in_${executions}`,
        status: "completed" as const,
        effect: "possible" as const,
        observations: { step: step.report, ...step.result },
      };
    }).pipe(Effect.mapError(mintError));
  return {
    fills: () => fills,
    resubmits: () => resubmits,
    reviewed,
    published: () => recorder.published(),
    dependencies: {
      autofillSignIn: true,
      reviewAndExecute,
      signInRefillRefused: () => recorder.passwordRefillRefused(),
    } satisfies Partial<MintDependencies>,
  };
};

/** The owner's answer to the minter's `accept_terms` question; undefined leaves it unanswered. */
const owner = (confirmed?: boolean): Partial<MintDependencies> =>
  confirmed === undefined
    ? {}
    : {
        askInput: () =>
          Effect.succeed({ accept_terms: { type: "confirm" as const, value: { confirmed } } }),
      };

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, callId: string, input: object): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});
const askAcceptTerms = call("request_input", "ask", {
  questions: [
    {
      id: "accept_terms",
      type: "confirm",
      prompt:
        "The site's updated terms cover its Sign In button, and the only way past is to accept them for this account. Accept them?",
    },
  ],
});
const passwordScreen: SignInStep = {
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const cited = (confirmedBy: readonly string[]) =>
  ({ ...passwordScreen, dismiss: accept, confirmedBy }) as SignInStep;
const authenticate = (callId: string, signInStep: SignInStep) =>
  call("execute", callId, {
    purpose: "authenticate",
    target: "liveBrowser",
    entrypoint: "src/tool.ts",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 30,
    signInStep,
  });
const check = authenticate("check", { signedIn: { selector: "#account" } });
const stop: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Stopping." }],
    },
  ],
};

/** The host's answer to `callId`, as the minter read it in `request`. */
const answerOf = (request: ModelRequest | undefined, callId: string) => {
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
/** What a sign-in step's answer for `callId` observed: the screen's report and the next step. */
const stepAnswer = (request: ModelRequest | undefined, callId: string) => {
  const { observations } = answerOf(request, callId);
  return typeof observations === "string" ? (JSON.parse(observations) as unknown) : observations;
};

it("a sign-in step that cites the owner's yes reaches review with the cite, clicks the notice's accept control, signs in, and publishes no dismiss", async () => {
  const site = coveredSite();
  const run = await fixture(
    (_request, index) =>
      [askAcceptTerms, authenticate("accept", cited(["accept_terms"])), check][index] ?? stop,
    { ...site.dependencies, ...owner(true) },
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  expect(site.reviewed).toEqual([
    expect.objectContaining({ dismiss: accept, confirmedBy: ["accept_terms"] }),
  ]);
  expect(stepAnswer(run.requests[2], "accept")).toMatchObject({
    step: { outcome: "filled", submit: "clicked" },
  });
  expect(stepAnswer(run.requests[3], "check")).toMatchObject({ signedIn: true });
  expect(site.fills()).toBe(1);
  // Runs never accept the notice: a run that meets it fails its sign-in as it does today.
  const steps = site.published()?.recipe.steps ?? [];
  expect(steps).toEqual([expect.objectContaining({ submit: "#sign-in", submittedBy: "host" })]);
  expect(steps[0]).not.toHaveProperty("dismiss");
});

it("a blocked screen sent again with the notice's accept control and the owner's yes cited is reviewed with the cite and publishes no dismiss", async () => {
  const site = coveredSite();
  const run = await fixture(
    (_request, index) =>
      [
        askAcceptTerms,
        authenticate("fill", passwordScreen),
        authenticate("again", cited(["accept_terms"])),
        check,
      ][index] ?? stop,
    { ...site.dependencies, ...owner(true) },
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  expect(stepAnswer(run.requests[2], "fill")).toMatchObject({
    step: { outcome: "filled", submit: "blocked" },
  });
  expect(site.reviewed.at(-1)).toMatchObject({ dismiss: accept, confirmedBy: ["accept_terms"] });
  expect(stepAnswer(run.requests[4], "check")).toMatchObject({ signedIn: true });
  expect(site.fills()).toBe(1);
  expect(site.resubmits()).toBe(1);
  const steps = site.published()?.recipe.steps ?? [];
  expect(steps).toHaveLength(1);
  expect(steps[0]).not.toHaveProperty("dismiss");
});

for (const [named, answered, cites] of [
  ["a question the owner left unanswered", undefined, ["accept_terms"]],
  ["a question the owner declined", false, ["accept_terms"]],
  ["a question this build never asked", true, ["accept_terms", "earlier_build_terms"]],
] as const)
  it(`a sign-in step whose dismiss cites ${named} is refused before review, with nothing typed`, async () => {
    const site = coveredSite();
    const run = await fixture(
      (_request, index) => [askAcceptTerms, authenticate("accept", cited(cites))][index] ?? stop,
      { ...site.dependencies, ...owner(answered) },
      { effect: "read", siteOrigin: origin },
    );
    await run.run();
    expect(answerOf(run.requests[2], "accept")).toMatchObject({
      status: "tool_failed",
      code: "InvalidRequest",
    });
    expect(site.reviewed).toEqual([]);
    expect(site.fills()).toBe(0);
    expect(site.published()).toBeUndefined();
  });

it("a sign-in step whose dismiss accepts the notice with no cite reaches review without one, and that review's denial types nothing", async () => {
  const site = coveredSite(() =>
    Effect.fail(
      reviewDenied("review_terms", {
        outcome: "deny",
        rationale:
          "The dismiss control accepts updated terms; it is not a cookie or tracking consent banner control.",
        refusal: "correctable",
      }),
    ),
  );
  const run = await fixture(
    (_request, index) =>
      [askAcceptTerms, authenticate("accept", { ...passwordScreen, dismiss: accept })][index] ??
      stop,
    { ...site.dependencies, ...owner(true) },
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  expect(site.reviewed).toHaveLength(1);
  expect(site.reviewed[0]).not.toHaveProperty("confirmedBy");
  expect(answerOf(run.requests[2], "accept")).toMatchObject({
    status: "review_rejected",
    code: "ReviewDenied",
  });
  expect(site.fills()).toBe(0);
  expect(site.published()).toBeUndefined();
});
