import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import {
  appendSignInStates,
  type SignInStates,
  type SignInStatesChoices,
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
// own scan, inspection and fill; and one that learned a box the site renamed, which a login whose
// route holds the old state signs in by, though never by another form drawn in place of its own.
// Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.com";
const username = "ada-owner";
const password = "synthetic-password";
const marker = { selector: "#account", openPath: "/home" };

test.describe.configure({ timeout: 120_000 });

/** An identifier form posting to /login/identifier, its box `id` and its button `next`. */
const form = (id: string, next = "next", hidden = false) =>
  `<form method="post" action="/login/identifier"${hidden ? " hidden" : ""}><label>Username<input id="${id}" name="value"></label><button id="${next}">Next</button></form>`;

/**
 * The site: a link at /login that opens the identifier form at /login/identifier, as `identifier`
 * draws it, the password at /login/password, then /home with the account marker. Each path a value
 * was sent to.
 */
const serve = async (page: Page, identifier = () => form("username")) => {
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
          ? identifier()
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

const signIn = async (page: Page, library: SignInStates, choices?: SignInStatesChoices) => {
  const { host, hooks, observe } = await hostOn(page);
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        ...(choices === undefined ? {} : { choices }),
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

  // The opener, then the page it led to, read as the identifier state the library knows; the
  // marker it never reached is not stored.
  const learned = appended(
    appendSignInStates(recorded, { states: [{ fingerprint: opener, step: openerStep }], to: identifier, signedIn: { selector: "#elsewhere" } }),
  );
  const [openerState] = learned.added;
  expect(learned.added.map((entry) => entry.kind)).toEqual(["state", "transition"]);
  expect(learned.added[1]).toMatchObject({ from: openerState?.key, to: identifierState?.key });
  // A page no known state looks like is no place to lead to.
  expect(
    appendSignInStates(recorded, { states: [{ fingerprint: opener, step: openerStep }], to: notFound, signedIn: { selector: "#elsewhere" } }),
  ).toEqual({ refused: "unknown_state" });

  sent.length = 0;
  await page.context().clearCookies();
  const ended = await signIn(page, learned.library);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(ended.visited).toEqual([openerState?.key, ...recorded.states.map((state) => state.key)]);
  expect(sent).toEqual(["/login/identifier", "/login/password"]);
});

const openerStep: AutofillRecipeStep = { page: `${site}/login`, fields: [], submit: "#open-sign-in" };
const passwordStep: AutofillRecipeStep = {
  page: `${site}/login/password`,
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const identifierStep = (selector: string, submit = "#next"): AutofillRecipeStep => ({
  page: `${site}/login/identifier`,
  fields: [{ selector, accepts: ["username"] }],
  submit,
});

/**
 * A library that recorded a sign-in through the opener, the identifier state `own` and the
 * password, then learned `later` after the opener, as another login's repair does; and the route
 * of the first sign-in.
 */
const learnedLater = async (
  page: Page,
  own: { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep },
  later: { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep },
) => {
  const [opener, secret] = [await scanAt(page, "/login"), await scanAt(page, "/login/password")];
  const recorded = appended(
    appendSignInStates(signInStatesOf({}, []), {
      states: [{ fingerprint: opener, step: openerStep }, own, { fingerprint: secret, step: passwordStep }],
      signedIn: marker,
    }),
  ).library;
  const route = recorded.states.map((state) => state.key);
  const learned = appended(
    appendSignInStates(recorded, { from: route[0], states: [later, { fingerprint: secret, step: passwordStep }], signedIn: marker }),
  ).library;
  expect(learned.states).toHaveLength(4);
  return { route, library: learned, later: learned.states.at(-1)?.key };
};

test("a login whose route holds a state whose box the site renamed signs in by the look-alike learned after it", async ({ page }) => {
  const box = { id: "username" };
  const sent = await serve(page, () => form(box.id));
  const identifier = await scanAt(page, "/login/identifier");
  // The site renames the box, and another login's repair learns the renamed box's state, of the
  // same look, after the one this login's route holds.
  box.id = "login-name";
  const renamed = await scanAt(page, "/login/identifier");
  const { route, library, later } = await learnedLater(
    page,
    { fingerprint: identifier, step: identifierStep("#username") },
    { fingerprint: renamed, step: identifierStep("#login-name") },
  );

  sent.length = 0;
  await page.context().clearCookies();
  const ended = await signIn(page, library, { states: route });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(ended.visited).toEqual([route[0], later, route[2]]);
  expect(sent).toEqual(["/login/identifier", "/login/password"]);
});

test("a login whose route holds one of two forms on a page takes no other login's form drawn in its place", async ({ page }) => {
  // One form for each kind of account, of one look, the other one hidden.
  const business = { shown: true };
  const sent = await serve(page, () => form("biz-user", "biz-next", !business.shown) + form("user", "next", business.shown));
  const businessLook = await scanAt(page, "/login/identifier");
  business.shown = false;
  const personalLook = await scanAt(page, "/login/identifier");
  const { route, library } = await learnedLater(
    page,
    { fingerprint: businessLook, step: identifierStep("#biz-user", "#biz-next") },
    { fingerprint: personalLook, step: identifierStep("#user") },
  );

  // The page now draws the other form by default: the business login stops for a repair of its own.
  sent.length = 0;
  await page.context().clearCookies();
  const ended = await signIn(page, library, { states: route });
  expect(ended).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(ended.visited).toEqual([route[0]]);
  expect(sent).toEqual([]);
});
