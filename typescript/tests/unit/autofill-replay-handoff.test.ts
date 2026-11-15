import { Data, Duration, Effect, Either, Schema } from "effect";
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

/**
 * A site whose sign-in page a person signs in on, and the run's page loads, asks and fills: a cold
 * browser lands on `landing`, the login page by default, a signed-in one on `home`, the account page
 * by default, and a `read` may end where it can't tell. Only the account page shows the marker.
 */
const replay = (options: {
  readonly signedIn: boolean;
  readonly handOff?: true;
  readonly recipe?: typeof recipe;
  readonly landing?: string;
  readonly home?: string;
  readonly read?: true;
  readonly timing?: { readonly stepWaitMs: number; readonly pollMs: number };
}) => {
  const state = { signedIn: options.signedIn, page: login };
  const trace: string[] = [];
  const prompts: string[] = [];
  // A check that names the marker's account page opens it first.
  const check = (indicator: { readonly openPath?: string | undefined }) =>
    Effect.sync(() => {
      if (indicator.openPath !== undefined) state.page = `${origin}${indicator.openPath}`;
      return state.signedIn && state.page === account
        ? ({ signedIn: true, url: state.page } as const)
        : ({ signedIn: false, failed: "indicator_not_visible", url: state.page } as const);
    });
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
        state.page = state.signedIn ? (options.home ?? account) : (options.landing ?? login);
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
    ...(options.read === undefined ? { startedEmpty: true } : { confirmCantTell: () => Effect.void }),
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
      recipe: options.recipe ?? recipe,
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
      timing: {
        ...(options.timing ?? { stepWaitMs: 60, pollMs: 2 }),
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
      },
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

// A site that sends a signed-out browser straight on to an identity provider, whose page changes
// from one sign-in to the next: a cold run hands off on whatever page settles without the marker,
// and never reads that page as signed in, even for a read in a reused profile.
it("hands off on the page a cold run settles on, though the recorded page moved", async () => {
  const provider = "https://id.example.test";
  const moved = signInRecipe(
    [{ page: `${provider}/signin/identify`, fields: [], approval: "handoff" }],
    { selector: "#account" },
  );
  const cold = {
    signedIn: false,
    recipe: moved,
    landing: `${provider}/signin/resume/x7Kq?step=2`,
    read: true,
    timing: { stepWaitMs: 3_000, pollMs: 20 },
  } as const;
  const check = await replay(cold);
  expect(check.outcome).toEqual({ outcome: "unsent", reason: "values_needed" });
  expect(check.trace).toEqual(["open"]);
  const handedOff = await replay({ ...cold, handOff: true });
  expect(handedOff.outcome).toEqual({
    outcome: "signed_in",
    alreadySignedIn: false,
    loginProved: false,
    handedOff: true,
  });
  expect(handedOff.trace).toEqual(["open", "ask:browser_handoff"]);
}, 15_000);

// A saved session whose landing page shows no marker: the recipe checks its account page, which the
// check opens. Nothing is asked, with or without a hand-off.
it("signs a saved session in through the marker's account page, asking nothing", async () => {
  const opened = signInRecipe([{ page: login, fields: [], approval: "handoff" }], {
    selector: "#account",
    openPath: "/account",
  });
  for (const handOff of [undefined, true] as const) {
    const warm = await replay({
      signedIn: true,
      recipe: opened,
      home: `${origin}/home`,
      timing: { stepWaitMs: 3_000, pollMs: 20 },
      ...(handOff === undefined ? {} : { handOff }),
    });
    expect(warm.outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
    expect(warm.trace).toEqual(["open"]);
  }
}, 20_000);
