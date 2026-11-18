import { Data, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { SignInMethodOption } from "../../src/runtime/autofill-replay-steps.js";
import { unrecordedCodeStep } from "../../src/runtime/autofill-unrecorded-code.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";

// A sign-in replay whose site shows its recorded screens out of order: where the next recorded
// screen never shows, the replay may go on from another recorded screen the page shows. These
// cases pin what it never does on the way.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const code = "246810";
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const codeField = unrecordedCodeStep.fields[0]?.selector ?? "";

/** A site screen: its page's path and the selectors of the controls it shows. */
interface Screen {
  readonly path: string;
  readonly controls: readonly string[];
}

/**
 * A scripted site on fixture hooks: `next` says the screen a fill of a screen goes to, with the
 * control it clicked; `home` signs in. A fill with no submit reports no send. The first full
 * sign-in check finds the site on `checked`, when given, as a page that changes late does.
 */
const scriptedSite = (
  screens: Readonly<Record<string, Screen>>,
  next: (screen: string, clicked: string | undefined) => string | undefined,
  checked?: string,
) => {
  const state = { screen: "sign-in" };
  const clicks: string[] = [];
  const shown = () => screens[state.screen] ?? { path: "/home", controls: [] };
  const page = () => `${origin}${shown().path}`;
  const here = (): AutofillSignedInCheck =>
    state.screen === "home"
      ? { signedIn: true, url: page() }
      : { signedIn: false, failed: "indicator_not_visible", url: page() };
  const hooks: AutofillHooks<TestFailure> = {
    open: () =>
      Effect.sync(() => {
        state.screen = "sign-in";
      }),
    check: () => Effect.sync(here),
    confirm: () =>
      Effect.sync(() => {
        if (checked !== undefined) state.screen = checked;
        return here();
      }),
    markerVisible: () => Effect.succeed(false),
    inspect: (step) =>
      Effect.sync((): AutofillInspection | AutofillRefusal => {
        const shows = (selector: string) => shown().controls.includes(selector);
        const missing = step.fields.findIndex((field) => !shows(field.selector));
        if (missing >= 0) return { outcome: "refused", reason: "not_found", target: missing };
        if (step.submit !== undefined && !shows(step.submit))
          return { outcome: "refused", reason: "not_found", target: "submit" };
        return {
          url: page(),
          page: page(),
          targets: {
            fields: step.fields.map(() => target),
            submit: step.submit === undefined ? null : target,
          },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({
              tag: "input",
              role: null,
              formMethod: "post",
              type: "text",
              name: null,
              id: null,
              autocomplete: null,
              inputmode: null,
              label: null,
              placeholder: null,
              ariaLabel: null,
              text: null,
              slot: field.slot,
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step }) =>
      Effect.sync((): AutofillStepReport => {
        clicks.push(step.submit ?? "none");
        const to = next(state.screen, step.submit);
        if (to !== undefined) state.screen = to;
        return {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submit === undefined ? "none" : "clicked",
          url: page(),
        };
      }),
  };
  return { hooks, clicks };
};

/** Replays `recipe` with `password` (none by default), each code asked answered with `code`. */
const replay = (
  recipe: SignInRecipe,
  hooks: AutofillHooks<TestFailure>,
  options: {
    readonly password?: string;
    readonly method?: (methods: readonly SignInMethodOption[]) => SignInMethodOption | undefined;
  } = {},
) => {
  const events: Readonly<Record<string, unknown>>[] = [];
  const asked: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push(question.id);
            return [question.id, code];
          }),
        ) as InputAnswers,
    ),
  );
  return Effect.runPromise(
    Effect.either(
      replayAutofillRecipe({
        recipe,
        hooks,
        entryUrl: `${origin}/sign-in`,
        credentials: {
          username: "owner@example.test",
          ...(options.password === undefined ? {} : { password: options.password }),
        },
        ask,
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "example.test",
        correlation: undefined,
        emit: (event) => Effect.sync(() => void events.push(event)),
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        ...(options.method === undefined
          ? {}
          : { hosted: { method: (methods) => Effect.succeed(options.method?.(methods)) } }),
        timing: { stepWaitMs: 60, pollMs: 2 },
        sent: { current: false },
      }).pipe(Effect.scoped),
    ),
  ).then((outcome) => ({
    reason: Either.isRight(outcome) ? Reflect.get(outcome.right, "reason") ?? "signed_in" : "error",
    restarts: events.filter((event) => event["reason"] === "recorded_screen_showing"),
    asked,
  }));
};

const recipeOf = (...steps: readonly object[]): SignInRecipe =>
  ({ version: 14, steps, signedIn: { selector: "#account" } }) as SignInRecipe;
const email = { page: `${origin}/sign-in`, fields: [{ selector: "#email", accepts: ["email" as const] }], submit: "#next" };
const password = { page: `${origin}/password`, fields: [{ selector: "#password", slot: "password" as const }], submit: "#go" };
const codeAt = (path: string, box: string) => ({
  page: `${origin}${path}`,
  fields: [{ selector: box, slot: "code" as const }],
  submit: "#verify",
});
const keepAt = (path: string) => ({ page: `${origin}${path}`, fields: [], submit: "#keep" });

it("goes on from an earlier recorded screen the page shows once the next never shows, and says so", async () => {
  const site = scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      code: { path: "/verify", controls: ["#code", "#verify"] },
      password: { path: "/password", controls: ["#password", "#go"] },
      keep: { path: "/keep", controls: ["#keep"] },
    },
    (screen) => ({ "sign-in": "code", code: "password", password: "keep", keep: "home" })[screen],
  );
  const outcome = await replay(
    recipeOf(email, password, codeAt("/verify", "#code"), keepAt("/keep")),
    site.hooks,
    { password: "synthetic-password" },
  );
  expect(outcome.reason).toBe("signed_in");
  expect(site.clicks).toEqual(["#next", "#verify", "#go", "#keep"]);
  expect(outcome.restarts).toEqual([
    { stage: "skipped", reason: "recorded_screen_showing", nextStep: 1 },
  ]);
});

it("never takes a lone button on the page of the screen it waited for as another recorded screen", async () => {
  // The password screen never shows: the page keeps a Continue button a later recorded screen
  // on the same page also has.
  const site = scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      unknown: { path: "/sign-in", controls: ["#keep"] },
    },
    (screen) => (screen === "sign-in" ? "unknown" : undefined),
  );
  const outcome = await replay(
    recipeOf(email, { ...password, page: `${origin}/sign-in` }, keepAt("/sign-in")),
    site.hooks,
    { password: "synthetic-password" },
  );
  expect(outcome.reason).toBe("not_found");
  expect(site.clicks).toEqual(["#next"]);
  expect(outcome.restarts).toEqual([]);
});

it("refuses a second code on a restart, as on any recorded code screen the recipe plans no refill for", async () => {
  const site = scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      first: { path: "/verify", controls: ["#code", "#verify"] },
      password: { path: "/password", controls: ["#password", "#go"] },
      second: { path: "/verify-again", controls: ["#code-again", "#verify"] },
    },
    (screen) => ({ "sign-in": "first", first: "password", password: "second" })[screen],
  );
  const outcome = await replay(
    recipeOf(email, password, codeAt("/verify", "#code"), codeAt("/verify-again", "#code-again")),
    site.hooks,
    { password: "synthetic-password" },
  );
  expect(outcome.reason).toBe("credential_already_filled");
  expect(outcome.asked).toEqual(["code"]);
  expect(site.clicks).toEqual(["#next", "#verify", "#go"]);
});

it("ends as before once the sign-in check has a verdict on the login, after a recorded code screen that never showed", async () => {
  // The password screen comes back late after its submit, beside a screen the replay passed over.
  const site = scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      password: { path: "/password", controls: ["#password", "#go"] },
      blank: { path: "/wait", controls: [] },
      again: { path: "/keep", controls: ["#password", "#go", "#keep"] },
    },
    (screen) => ({ "sign-in": "password", password: "blank" })[screen],
    "again",
  );
  const outcome = await replay(
    recipeOf(email, keepAt("/keep"), password, codeAt("/verify", "#code")),
    site.hooks,
    { password: "synthetic-password" },
  );
  expect(outcome.reason).toBe("not_found");
  expect(site.clicks).toEqual(["#next", "#go"]);
  expect(outcome.restarts).toEqual([]);
});

it("stops at a code it typed and never sent, as before, rather than going on from another recorded screen", async () => {
  // The code box the recipe never recorded sends nothing by itself, beside a recorded Continue
  // the replay passed over.
  const site = scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      password: { path: "/password", controls: ["#password", "#go"] },
      code: { path: "/keep", controls: [codeField, "#keep"] },
    },
    (screen) => ({ "sign-in": "password", password: "code" })[screen],
  );
  const outcome = await replay(recipeOf(email, keepAt("/keep"), password), site.hooks, {
    password: "synthetic-password",
  });
  expect(outcome.reason).toBe("sign_in_check_failed");
  expect(site.clicks).toEqual(["#next", "#go", "none"]);
  expect(outcome.restarts).toEqual([]);
});

const ways = (...methods: { readonly method: string; readonly selector: string }[]) => ({
  page: `${origin}/ways`,
  fields: [],
  submit: "#with-password",
  methods: [{ method: "password", selector: "#with-password" }, ...methods],
});
const waysSite = () =>
  scriptedSite(
    {
      "sign-in": { path: "/sign-in", controls: ["#email", "#next"] },
      ways: { path: "/ways", controls: ["#with-password", "#with-email", "#with-text", "#with-recovery"] },
      code: { path: "/verify", controls: ["#code", "#verify"] },
    },
    (screen, clicked) => (screen === "sign-in" ? "ways" : screen === "ways" && clicked !== "#with-password" ? "code" : screen === "code" ? "home" : undefined),
  );

it("takes the host's method among two code methods for a login with no password at a choice recorded with the password", async () => {
  const site = waysSite();
  const outcome = await replay(
    recipeOf(
      email,
      ways({ method: "email", selector: "#with-email" }, { method: "sms", selector: "#with-text" }),
      password,
      codeAt("/verify", "#code"),
    ),
    site.hooks,
    { method: (methods) => methods.find((method) => method.method === "sms") },
  );
  expect(outcome.reason).toBe("signed_in");
  expect(site.clicks).toEqual(["#next", "#with-text", "#verify"]);
});

it("keeps the recorded password way for a login with no password where the choice's other way is no code", async () => {
  const site = waysSite();
  const outcome = await replay(
    recipeOf(email, ways({ method: "recovery_code", selector: "#with-recovery" }), password),
    site.hooks,
  );
  expect(site.clicks.slice(0, 2)).toEqual(["#next", "#with-password"]);
  expect(outcome.asked).not.toContain("method");
});
