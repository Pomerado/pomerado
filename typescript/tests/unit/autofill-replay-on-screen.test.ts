import { Data, Effect, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A host hears each recorded screen once it shows, just before the replay acts on it, so it can
// read the page as that screen's state.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const page = `${origin}/login`;

/** A replay of `recipe` on a site that signs in once two fills clicked; the order it heard. */
const replay = async (recipe: AutofillRecipe) => {
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
        clicks >= 2
          ? { signedIn: true as const, url: `${origin}/account` }
          : { signedIn: false as const, failed: "indicator_not_visible" as const, url: page },
      ),
    confirm: () => Effect.succeed({ signedIn: true as const, url: `${origin}/account` }),
    inspect: (inspected) =>
      Effect.succeed({
        page,
        siteOrigin: origin,
        authenticationOrigins: [],
        targets: {
          fields: inspected.fields.map(() => target),
          submit: { ...target, control: "other" as const },
        },
        screen: { origin, fields: [], submit: null, buttons: ["Continue"] },
      }),
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
      credentials: undefined,
      ask: () => Effect.dieMessage("Unexpected question"),
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
          heard.push(`screen ${recorded.submit ?? ""}`);
        }),
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );
  return { outcome, heard };
};

it("tells the host each recorded screen as it shows, before the replay acts on it", async () => {
  const { outcome, heard } = await replay({
    version: 2,
    steps: [
      { page, fields: [], submit: "#continue" },
      { page, fields: [], submit: "#confirm" },
    ],
    signedIn: { selector: "#identity" },
  });

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(heard).toEqual(["screen #continue", "fill #continue", "screen #confirm", "fill #confirm"]);
});
