import { Data, Effect, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
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

/**
 * A replay of `recipe` on a site that signs in once `clicksToSignIn` fills clicked; the order the
 * host heard screens, fills and questions in.
 */
const replay = async (
  recipe: AutofillRecipe,
  options: { readonly credentials?: WebsiteCredentials; readonly clicksToSignIn?: number } = {},
) => {
  const heard: string[] = [];
  let clicks = 0;
  const target = {
    ownerUrl: null,
    documentOrigin: origin,
    actions: [`${origin}/session`],
    methods: ["post"],
    editable: true,
    control: "text" as const,
  };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () =>
      Effect.sync(() =>
        clicks >= (options.clicksToSignIn ?? 2)
          ? { signedIn: true as const, url: `${origin}/account` }
          : { signedIn: false as const, failed: "indicator_not_visible" as const, url: page },
      ),
    confirm: () => Effect.succeed({ signedIn: true as const, url: `${origin}/account` }),
    // The page moves to the account once the site signed in, as an approval it skipped does.
    inspect: (inspected) =>
      Effect.sync(() => ({
        page: clicks >= (options.clicksToSignIn ?? 2) ? `${origin}/account` : page,
        siteOrigin: origin,
        authenticationOrigins: [],
        targets: {
          fields: inspected.fields.map(() => target),
          submit: { ...target, control: "other" as const },
        },
        screen: { origin, fields: [], submit: null, buttons: ["Continue"] },
      })),
    fill: ({ step }) =>
      Effect.sync(() => {
        heard.push(`fill ${step.submit ?? ""}`);
        clicks += 1;
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
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
        Effect.sync(() => {
          clicks += 1;
          return Object.fromEntries(
            request.questions.map((question) => {
              heard.push(`ask ${question.type}`);
              return [question.id, { confirmed: true }];
            }),
          );
        }),
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
