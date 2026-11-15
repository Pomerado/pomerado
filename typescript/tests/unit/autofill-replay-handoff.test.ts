import { Data, Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import {
  AutofillRecipe,
  HandOffAutofillRecipe,
} from "../../src/destinations/autofill-recipe.js";
import type { AutofillInspection } from "../../src/destinations/autofill-step.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A sign-in a person makes in the browser handed to them: the recipe records the sign-in page as a
// hand-off screen with no fields. A run's check without values stops there, and the replay that
// may hand off asks once, then checks the marker, typing nothing and asking for no login. A saved
// session that shows the marker asks nothing.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const account = `${origin}/account`;
const recipe = signInRecipe([{ page: login, fields: [], approval: "handoff" }], {
  selector: "#account",
});

it("writes a hand-off sign-in as version 15, which no older version carries", () => {
  expect(recipe).toEqual({
    version: 15,
    steps: [{ page: login, fields: [], approval: "handoff" }],
    signedIn: { selector: "#account" },
  });
  expect(decodeSignInRecipe(signInRecipeText(recipe))).toEqual(recipe);
  // An older host knows none of version 15, and no version it knows takes a hand-off.
  const older = Schema.Union(
    ...AutofillRecipe.members.filter((member) => member !== HandOffAutofillRecipe),
  );
  expect(Either.isLeft(Schema.decodeUnknownEither(older)(recipe))).toBe(true);
  for (const version of [2, 14])
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version }))).toBe("invalid");
});

/** A site whose sign-in page a person signs in on, and the run's page loads, asks and fills. */
const replay = (options: { readonly signedIn: boolean; readonly handOff?: true }) => {
  const state = { signedIn: options.signedIn, page: login };
  const trace: string[] = [];
  const prompts: string[] = [];
  const check = () =>
    Effect.sync(() =>
      state.signedIn
        ? ({ signedIn: true, url: state.page } as const)
        : ({ signedIn: false, failed: "indicator_not_visible", url: state.page } as const),
    );
  const inspection = (): AutofillInspection => ({
    page: state.page,
    siteOrigin: origin,
    authenticationOrigins: [],
    targets: { fields: [], submit: null },
    screen: { origin, fields: [], submit: null, buttons: [] },
  });
  const hooks: AutofillHooks<TestFailure> = {
    open: () =>
      Effect.sync(() => {
        trace.push("open");
        state.page = state.signedIn ? account : login;
      }),
    check,
    confirm: check,
    // A step with no fields and no submit shows on any page, as a real page's inspection does.
    inspect: (step) =>
      Effect.sync(() =>
        step.fields.length === 0 && step.submit === undefined
          ? inspection()
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: () => Effect.dieMessage("A hand-off types nothing"),
    startedEmpty: true,
  };
  const ask = makeInputAsker((request) =>
    Effect.sync(() =>
      Object.fromEntries(
        request.questions.map((question) => {
          trace.push(`ask:${question.type}`);
          prompts.push(question.prompt);
          // The person signs in in the browser, then marks it done.
          state.signedIn = true;
          state.page = account;
          return [question.id, { done: true }];
        }),
      ),
    ),
  );
  return Effect.runPromise(
    replayAutofillRecipe({
      recipe,
      hooks,
      entryUrl: login,
      credentials: undefined,
      ...(options.handOff === undefined ? {} : { handOff: options.handOff }),
      ask,
      broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
      site: "example.test",
      correlation: undefined,
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "Unanswered" }),
        unavailable: () => new TestFailure({ code: "Unavailable" }),
      },
      timing: { stepWaitMs: 60, pollMs: 2 },
      sent: { current: false },
    }).pipe(Effect.scoped),
  ).then((outcome) => ({ outcome, trace, prompts }));
};

it("stops the check without values at a hand-off, then hands off once and checks the marker", async () => {
  const check = await replay({ signedIn: false });
  expect(check.outcome).toEqual({ outcome: "unsent", reason: "values_needed" });
  expect(check.trace).toEqual(["open"]);

  const handedOff = await replay({ signedIn: false, handOff: true });
  expect(handedOff.outcome).toEqual({
    outcome: "signed_in",
    alreadySignedIn: false,
    loginProved: false,
    handedOff: true,
  });
  expect(handedOff.trace).toEqual(["open", "ask:browser_handoff"]);
  expect(handedOff.prompts).toEqual(["Sign in to example.test in this browser, then mark it done."]);

  // A saved session shows the marker: nothing is asked, with or without a hand-off.
  for (const handOff of [undefined, true] as const) {
    const warm = await replay({ signedIn: true, ...(handOff === undefined ? {} : { handOff }) });
    expect(warm.outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
    expect(warm.trace).toEqual(["open"]);
  }
});
