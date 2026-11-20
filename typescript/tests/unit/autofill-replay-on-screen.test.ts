import { Data, Effect, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A host hears each recorded screen the replay acts on, once its checks passed and just before it
// fills, presses or asks for an approval there, so it can read the page as that screen's state.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const page = `${origin}/login`;
const signedIn = { selector: "#identity" };
const username = { page, fields: [{ selector: "#username", accepts: ["username" as const] }], submit: "#next" };
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/**
 * A replay of `recipe` on a site that signs in once `clicksToSignIn` fills clicked; the order the
 * host heard screens, fills and questions in. With `codeBox`, a code box shows in place of the
 * login once it was pressed, and the owner gives that code, or none for null. With
 * `disabledSubmit`, the first press of that submit finds it disabled.
 */
const replay = async (
  recipe: AutofillRecipe,
  options: {
    readonly credentials?: WebsiteCredentials;
    readonly clicksToSignIn?: number;
    readonly codeBox?: string | null;
    readonly disabledSubmit?: string;
  } = {},
) => {
  const heard: string[] = [];
  let clicks = 0;
  let disabled = options.disabledSubmit;
  const signsIn = () => clicks >= (options.clicksToSignIn ?? 2);
  // The page moves to the account once the site signed in, as an approval it skipped does.
  const inspection = (inspected: AutofillStep) => ({
    page: signsIn() ? `${origin}/account` : page,
    siteOrigin: origin,
    authenticationOrigins: [],
    targets: {
      fields: inspected.fields.map(() => target),
      submit: { ...target, control: "other" as const },
    },
    screen: { origin, fields: [], submit: null, buttons: ["Continue"] },
  });
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () =>
      Effect.sync(() =>
        signsIn()
          ? { signedIn: true as const, url: `${origin}/account` }
          : { signedIn: false as const, failed: "indicator_not_visible" as const, url: page },
      ),
    confirm: () => Effect.succeed({ signedIn: true as const, url: `${origin}/account` }),
    inspect: (inspected) =>
      Effect.sync(() =>
        options.codeBox !== undefined &&
        clicks >= 1 &&
        inspected.fields.some((field) => field.selector === "#username")
          ? { outcome: "refused" as const, reason: "not_found" as const, target: 0 }
          : inspection(inspected),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        const code = step.fields.some((field) => field.slot === "code");
        heard.push(`fill ${code ? "code" : (step.submit ?? "")}`);
        const stayedDisabled = disabled !== undefined && step.submit === disabled;
        if (stayedDisabled) disabled = undefined;
        else clicks += 1;
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: stayedDisabled ? ("stayed_disabled" as const) : ("clicked" as const),
          url: page,
        };
      }),
  };
  const outcome = await Effect.runPromise(
    replayAutofillRecipe({
      recipe,
      hooks,
      entryUrl: page,
      credentials: options.credentials,
      ask: makeInputAsker((request) =>
        Effect.sync(() =>
          Object.fromEntries(
            request.questions.flatMap((question): [string, unknown][] => {
              heard.push(`ask ${question.type}`);
              if (question.id === "code")
                return options.codeBox === null || options.codeBox === undefined
                  ? []
                  : [[question.id, options.codeBox]];
              clicks += 1;
              return [[question.id, { confirmed: true }]];
            }),
          ),
        ),
      ),
      broker: {
        register: () => Effect.void,
        registeredSecretMatches: () => Effect.succeed([]),
      },
      site: "example.test",
      correlation: { jobId: "job", attemptId: "attempt" },
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "BrowserUnavailable" }),
        unavailable: () => new TestFailure({ code: "BrowserUnavailable" }),
      },
      timing: { stepWaitMs: 1_000, pollMs: 250 },
      sent: { current: false },
      onScreen: (recorded) =>
        Effect.sync(() => {
          heard.push(`screen ${recorded.submit ?? recorded.approval ?? ""}`);
        }),
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );
  return { outcome, heard };
};

const login = { username: "synthetic-user" };

it("tells the host each screen just before the replay fills or presses it", async () => {
  const { outcome, heard } = await replay(
    { version: 2, steps: [username, { page, fields: [], submit: "#confirm" }], signedIn },
    { credentials: login },
  );

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(heard).toEqual(["screen #next", "fill #next", "screen #confirm", "fill #confirm"]);
});

it("tells the host an approval screen just before its question, and none the page already passed", async () => {
  const approval = { page, fields: [], approval: "device" as const };
  const asked = await replay(
    { version: 2, steps: [username, approval], signedIn },
    { credentials: login },
  );
  expect(asked.outcome).toMatchObject({ outcome: "signed_in" });
  expect(asked.heard).toEqual(["screen #next", "fill #next", "screen device", "ask confirm"]);

  const passed = await replay(
    { version: 2, steps: [username, approval], signedIn },
    { credentials: login, clicksToSignIn: 1 },
  );
  expect(passed.outcome).toMatchObject({ outcome: "signed_in" });
  expect(passed.heard).toEqual(["screen #next", "fill #next"]);
});

// A code box where an emailed link's screen was recorded is a code screen the recipe never
// recorded: the host hears no link screen when its code goes in, and hears it once nobody gave
// the code, before the replay asks for the link there.
it("tells the host of an emailed link's screen only when its code box got no code", async () => {
  const approval = { page, fields: [], approval: "email_link" as const };
  const typed = await replay(
    { version: 2, steps: [username, approval], signedIn },
    { credentials: login, codeBox: "123456" },
  );
  expect(typed.outcome).toMatchObject({ outcome: "signed_in" });
  expect(typed.heard).toEqual(["screen #next", "fill #next", "ask secret", "fill code"]);

  const unanswered = await replay(
    { version: 2, steps: [username, approval], signedIn },
    { credentials: login, codeBox: null },
  );
  expect(unanswered.outcome).toMatchObject({ outcome: "signed_in" });
  expect(unanswered.heard).toEqual([
    "screen #next",
    "fill #next",
    "ask secret",
    "screen email_link",
    "ask confirm",
  ]);
});

it("tells the host a screen once, though its submit stayed disabled on the first press", async () => {
  const { outcome, heard } = await replay(
    { version: 2, steps: [username, { page, fields: [], submit: "#confirm" }], signedIn },
    { credentials: login, disabledSubmit: "#confirm" },
  );

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(heard).toEqual([
    "screen #next",
    "fill #next",
    "screen #confirm",
    "fill #confirm",
    "fill #confirm",
  ]);
});

it("tells the host nothing in a value-free replay", async () => {
  const { outcome, heard } = await replay({
    version: 2,
    steps: [
      { page, fields: [], submit: "#continue" },
      { page, fields: [], submit: "#confirm" },
    ],
    signedIn,
  });

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(heard).toEqual(["fill #continue", "fill #confirm"]);
});
