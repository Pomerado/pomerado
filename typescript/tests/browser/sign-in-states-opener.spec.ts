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
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
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

// Runs sign in from a library on the host's own page, as a run does (`signInForRun`): a code page
// that also shows the account's header is still a code page, a date of birth the site refused is
// asked for again and retyped alone, and a choice of account the page draws late is waited for,
// never passed for the page after it.

/** A library of states, each with the look the host's scan read and its step, to `#account`. */
const libraryOf = (states: readonly { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep }[]) =>
  appended(appendSignInStates(signInStatesOf({}, []), { states, signedIn: { selector: "#account" } })).library;

/**
 * The site: each page in `pages` by its path, and each form post or fetch given to `post` with
 * what it sent, the browser sent on to the path `post` names, if any.
 */
const serveSite = (
  page: Page,
  pages: Readonly<Record<string, () => string>>,
  post: (path: string, form: URLSearchParams) => string | undefined,
) =>
  page.route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST")
      return route.fulfill({ contentType: "text/html", body: pages[path]?.() ?? "<p>Not found</p>" });
    const next = post(path, new URLSearchParams(request.postData() ?? ""));
    return route.fulfill({
      contentType: "text/html",
      body: next === undefined ? "" : `<script>location.replace(${JSON.stringify(next)})</script>`,
    });
  });

const loginPage = () =>
  '<form method="post" action="/session"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>';
const loginStep: AutofillRecipeStep = {
  page: `${site}/login`,
  fields: [{ selector: "#username", accepts: ["username"] }, { selector: "#password", slot: "password" }],
  submit: "#sign-in",
};

/** A run's sign-in with `library` from /login, answering each ask by its kind, in turn, from `answers`. */
const runSignIn = async (page: Page, library: SignInStates, answers: Record<string, string[]> = {}) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const asked: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      const kind = question?.type === "credential" ? "login" : (question?.id ?? "");
      asked.push(kind);
      return kind === "login" ? { login: { username, password, saveLogin: false } } : { [kind]: answers[kind]?.shift() ?? "" };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        states: library,
        entryUrl: `${site}/login`,
        browser: makeSignInBrowser({ page: browser, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } }),
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: "app.example.com",
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expectNotCarried(browser.calls, password);
  return { result, asked };
};

test("a code page that also shows the account's header is answered as a code page, signing in only after the code", async ({ page }) => {
  const code = "246810";
  const posted: string[] = [];
  const header = '<header><a id="account" href="/home">Your account</a></header>';
  await serveSite(
    page,
    {
      "/login": loginPage,
      "/verify": () =>
        `${header}<form method="post" action="/verify"><label>Code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label><button id="verify">Verify</button></form>`,
      "/home": () => `${header}<p>Welcome back</p>`,
    },
    (path, form) => {
      posted.push(path === "/verify" ? (form.get("code") ?? "") : path);
      return path === "/session" || form.get("code") !== code ? "/verify" : "/home";
    },
  );
  const library = libraryOf([
    { fingerprint: await scanAt(page, "/login"), step: loginStep },
    {
      fingerprint: await scanAt(page, "/verify"),
      step: { page: `${site}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
    },
  ]);
  const { result, asked } = await runSignIn(page, library, { code: [code] });
  expect(result).toMatchObject({ _tag: "Right" });
  expect(asked).toEqual(["login", "code"]);
  expect(posted).toEqual(["/session", code]);
});

test("a date of birth the site refused is asked for again and retyped alone, never the login", async ({ page }) => {
  const posted: string[] = [];
  const shown = { refused: false };
  await serveSite(
    page,
    {
      "/login": loginPage,
      "/birth": () =>
        `${shown.refused ? '<p id="birth-error">That date of birth does not match</p>' : ""}<form method="post" action="/birth"><label>Date of birth<input id="birth" name="birth" autocomplete="bday" placeholder="YYYY-MM-DD"></label><button id="confirm">Confirm</button></form>`,
      "/home": () => '<p id="account">Your account</p>',
    },
    (path, form) => {
      posted.push(path === "/birth" ? (form.get("birth") ?? "") : path);
      if (path === "/session") return "/birth";
      shown.refused = form.get("birth") !== "1980-04-09";
      return shown.refused ? "/birth" : "/home";
    },
  );
  const library = libraryOf([
    { fingerprint: await scanAt(page, "/login"), step: loginStep },
    {
      fingerprint: await scanAt(page, "/birth"),
      step: {
        page: `${site}/birth`,
        fields: [{ selector: "#birth", slot: "date_of_birth", format: "YYYY-MM-DD" }],
        submit: "#confirm",
        rejectedMarkers: [{ slot: "date_of_birth", selector: "#birth-error" }],
      },
    },
  ]);
  const { result, asked } = await runSignIn(page, library, { date_of_birth: ["1980-01-01", "1980-04-09"] });
  expect(result).toMatchObject({ _tag: "Right" });
  expect(asked).toEqual(["login", "date_of_birth", "date_of_birth"]);
  expect(posted).toEqual(["/session", "1980-01-01", "1980-04-09"]);
});

test("a choice of account the page draws late is waited for and made, never passed for the page after it", async ({ page }) => {
  const posted: string[] = [];
  const shown = { chosen: false, late: false };
  const choice = `<button id="choose" type="button" onclick="fetch('/choose', { method: 'POST' }).then(() => this.remove())">Use the team account</button>`;
  await serveSite(
    page,
    {
      "/login": () =>
        `<main><p>Sign in to your workspace</p>${shown.chosen || shown.late ? "" : choice}<a id="continue" href="/login/identifier">Continue</a></main>${
          shown.late ? `<script>setTimeout(() => document.getElementById("continue").insertAdjacentHTML("beforebegin", ${JSON.stringify(choice)}), 1_500)</script>` : ""
        }`,
      "/login/identifier":
        () => '<form method="post" action="/login/identifier"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>',
      "/login/password":
        () => '<form method="post" action="/login/password"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
      "/home": () => '<p id="account">Your account</p>',
    },
    (path) => {
      posted.push(path);
      return path === "/choose" ? undefined : path === "/login/identifier" ? "/login/password" : "/home";
    },
  );
  const choose = await scanAt(page, "/login");
  shown.chosen = true;
  const library = libraryOf([
    { fingerprint: choose, step: { page: `${site}/login`, fields: [], submit: "#choose" } },
    { fingerprint: await scanAt(page, "/login"), step: { page: `${site}/login`, fields: [], submit: "#continue" } },
    {
      fingerprint: await scanAt(page, "/login/identifier"),
      step: { page: `${site}/login/identifier`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" },
    },
    {
      fingerprint: await scanAt(page, "/login/password"),
      step: { page: `${site}/login/password`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
    },
  ]);
  // A new session, where the page draws the choice a moment after the rest.
  Object.assign(shown, { chosen: false, late: true });
  const { result } = await runSignIn(page, library);
  expect(result).toMatchObject({ _tag: "Right" });
  expect(posted).toEqual(["/choose", "/login/identifier", "/login/password"]);
});
