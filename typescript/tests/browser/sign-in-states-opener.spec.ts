import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import {
  appendSignInStates,
  type SignInStates,
  signInStatesOf,
  type StateFingerprint,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A library of sign-in states that learned an opener after it was recorded: a sign-in that stopped
// before it signed in appends the opener it pressed, leading to the identifier state the library
// already knows, and a replay from the opener's page signs in on local Chromium with the host's
// own scan, inspection and fill. Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.com";
const username = "ada-owner";
const password = "synthetic-password";
const marker = { selector: "#account", openPath: "/home" };

test.describe.configure({ timeout: 120_000 });

/**
 * The site: a link at /login that opens the identifier form at /login/identifier, the password at
 * /login/password, then /home with the account marker. Each path a value was sent to.
 */
const serve = async (page: Page) => {
  const sent: string[] = [];
  let typed = "";
  await page.route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      const value = new URLSearchParams(request.postData() ?? "").get("value") ?? "";
      sent.push(url.pathname);
      if (url.pathname === "/login/identifier") typed = value;
      const next =
        url.pathname === "/login/identifier"
          ? "/login/password"
          : value === password && typed === username
            ? "/home"
            : "/login/password";
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next)})</script>` });
      return;
    }
    const body =
      url.pathname === "/login"
        ? '<main><h1>Welcome</h1><a id="open-sign-in" href="/login/identifier">Sign in</a></main>'
        : url.pathname === "/login/identifier"
          ? '<form method="post" action="/login/identifier"><label>Username<input id="username" name="value"></label><button id="next">Next</button></form>'
          : url.pathname === "/login/password"
            ? '<form method="post" action="/login/password"><label>Password<input id="password" name="value" type="password"></label><button id="sign-in">Sign in</button></form>'
            : url.pathname === "/home" && typed !== ""
              ? '<p id="account">Your account</p>'
              : "<p>Not found</p>";
    await route.fulfill({ contentType: "text/html", body });
  });
  return sent;
};

/** The host's hooks and its scan on `page`, as a host gives them to a replay. */
const hostOn = async (page: Page) => {
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  const hooks: AutofillHooks<TestFailure> = {
    inspect: (step) => browser.inspect(step),
    fill: (input) => browser.fill(input),
    check: (indicator, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    confirm: (indicator, _identifiers, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin),
    open: (url) => browser.open(url).pipe(Effect.mapError(() => new TestFailure({ code: "open" }))),
    markerVisible: (selector, screenPage, popup) =>
      browser.markerVisible(selector, screenPage, popup).pipe(Effect.mapError(() => new TestFailure({ code: "marker" }))),
  };
  const observe = observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [], identifiers: [username] });
  return { host, hooks, observe };
};

/** The page as the host's scan reads it at `path`, as a sign-in notes each state it acts in. */
const scanAt = async (page: Page, path: string) => {
  await page.goto(`${site}${path}`);
  const { observe } = await hostOn(page);
  const state = await Effect.runPromise(observe);
  if (state === undefined) throw new Error("The scan read nothing");
  return state.fingerprint;
};

/** The appended library, failing the test on a refusal. */
const appended = (result: ReturnType<typeof appendSignInStates>) => {
  if ("refused" in result) throw new Error(result.refused);
  return result;
};

const signIn = async (page: Page, library: SignInStates) => {
  const { host, hooks, observe } = await hostOn(page);
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe,
        hooks,
        entryUrl: `${site}/login`,
        credentials: { username, password },
        ask: makeInputAsker(() => Effect.succeed({} as InputAnswers)),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "app.example.com",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 8_000, pollMs: 250 },
        sent: { current: false },
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  expectNotCarried(host.calls, password);
  return ended.right;
};

test("a library that appends an opener leading to a state it knows signs in from the opener's page", async ({ page }) => {
  const sent = await serve(page);
  const identifier = await scanAt(page, "/login/identifier");
  const secret = await scanAt(page, "/login/password");
  const opener = await scanAt(page, "/login");
  const notFound = await scanAt(page, "/missing");
  const steps: readonly AutofillRecipeStep[] = [
    { page: `${site}/login/identifier`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" },
    { page: `${site}/login/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
  ];
  const recorded = appended(
    appendSignInStates(signInStatesOf({}, []), {
      states: [identifier, secret].map((fingerprint: StateFingerprint, index) => ({ fingerprint, step: steps[index] as AutofillRecipeStep })),
      signedIn: marker,
    }),
  ).library;
  const [identifierState] = recorded.states;
  const openerStep: AutofillRecipeStep = { page: `${site}/login`, fields: [], submit: "#open-sign-in" };

  // The opener, then the page it led to, read as the identifier state the library knows.
  const learned = appended(
    appendSignInStates(recorded, { states: [{ fingerprint: opener, step: openerStep }], to: identifier, signedIn: marker }),
  );
  const [openerState] = learned.added;
  expect(learned.added.map((entry) => entry.kind)).toEqual(["state", "transition"]);
  expect(learned.added[1]).toMatchObject({ from: openerState?.key, to: identifierState?.key });
  // A page no known state looks like is no place to lead to.
  expect(
    appendSignInStates(recorded, { states: [{ fingerprint: opener, step: openerStep }], to: notFound, signedIn: marker }),
  ).toEqual({ refused: "unknown_state" });

  sent.length = 0;
  await page.context().clearCookies();
  const ended = await signIn(page, learned.library);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(ended.visited).toEqual([openerState?.key, ...recorded.states.map((state) => state.key)]);
  expect(sent).toEqual(["/login/identifier", "/login/password"]);
});
