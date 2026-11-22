// Failure modes covered: a local build's publication ships its recipe beside or instead of its
// screens; a sign-in whose screen the recorder could not read, or that recorded no screens,
// publishes; screens that fail the sign-in version check publish; a one-time login URL the host
// already asked about is refused again as screens.
import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { appendSignInStates, signInStatesOf, type SignInStates } from "../../src/destinations/sign-in-states.js";
import type { SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { shippedSignIn } from "../../src/standalone/mint-publication.js";

const site = "https://www.example.com";
const step = {
  page: "https://www.example.com/login",
  fields: [{ selector: "#email", accepts: ["email" as const] }, { selector: "#password", slot: "password" as const }],
  submit: "button[type=submit]",
};
const recipe: SignInRecipe = { version: 1, steps: [step], signedIn: { selector: "#account-menu" } };
const screens = (submit = step.submit): SignInStates => {
  const appended = appendSignInStates(signInStatesOf({}, []), {
    states: [
      {
        fingerprint: {
          top: site,
          boxes: [
            { frame: site, kind: "identifier" },
            { frame: site, kind: "password" },
          ],
          submit: true,
        },
        step: { ...step, submit },
      },
    ],
    signedIn: recipe.signedIn,
  });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};
const entryUrl = "https://www.example.com/login";
const ship = (signIn: Parameters<typeof shippedSignIn>[0], asked: ReadonlySet<string> = new Set()) =>
  Effect.runPromise(Effect.either(shippedSignIn(signIn, site, asked)));

it("ships a sign-in's screens and its entry URL, never its recipe", async () => {
  const states = screens();
  expect(await ship({ recipe, states, entryUrl })).toEqual(Either.right({ entryUrl, states }));
});

it("refuses a sign-in with no screens, as one whose screen could not be read, and never ships its recipe", async () => {
  const refusal = Either.left(
    expect.objectContaining({
      code: "PublicationUnavailable",
      reason: "sign_in_version_refused",
      publicationFeedback: { signInFindings: [{ rule: "invalid_recipe", part: "states.states" }] },
    }),
  );
  expect(await ship({ recipe, entryUrl, unreadable: true })).toEqual(refusal);
  expect(await ship({ recipe, entryUrl })).toEqual(refusal);
});

it("refuses screens the sign-in version check refuses, every time, naming each part", async () => {
  const signIn = { recipe, states: screens("#sign-out"), entryUrl };
  for (const attempt of [1, 2])
    expect(await ship(signIn), `attempt ${attempt}`).toEqual(
      Either.left(
        expect.objectContaining({
          reason: "sign_in_version_refused",
          publicationFeedback: { signInFindings: [{ rule: "sign_out", part: "states.states[0].step.submit" }] },
        }),
      ),
    );
});

it("passes a one-time login URL the host already asked about, and refuses it unasked", async () => {
  const oneTime = "https://www.example.com/login?state=af0ifjsldkj81d2c9b7e";
  const signIn = { recipe, states: screens(), entryUrl: oneTime };
  expect(await ship(signIn)).toMatchObject(
    Either.left({ publicationFeedback: { signInFindings: [{ rule: "one_time_url", part: "entryUrl" }] } }),
  );
  expect(Either.isRight(await ship(signIn, new Set([oneTime])))).toBe(true);
});
