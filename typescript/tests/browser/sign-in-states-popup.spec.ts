import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { observeSignInState, type SignInStatePopup, statesPopup, stepPopup } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, type SignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in whose screens sit in a pop-up the site's page opens on another origin, recorded with
// the host's own scan and replayed from its states on local Chromium. Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://shop.example.test";
const accounts = "https://accounts.example.test";
const popup = { opener: "primary", origin: accounts } as const;
const username = "ada@example.test";
const password = "synthetic-password";

const opener: AutofillRecipeStep = { page: `${site}/login`, fields: [], submit: "#open" };
const emailStep: AutofillRecipeStep = {
  page: `${accounts}/sign-in`,
  fields: [{ selector: "#email", accepts: ["email"] }],
  submit: "#next",
  popup,
};
const passwordStep: AutofillRecipeStep = {
  page: `${accounts}/password`,
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
  popup,
};

const pages: Readonly<Record<string, string>> = {
  [`${site}/login`]: `<h1>Sign in</h1><button id="open" onclick="window.open('${accounts}/sign-in', 'accounts', 'popup')">Continue with Accounts</button>`,
  [`${site}/home`]: '<p id="account">Your account</p>',
  [`${accounts}/sign-in`]:
    '<h1>Sign in to Accounts</h1><form method="post" action="/sign-in"><label>Email<input id="email" name="email" type="email"></label><button id="next">Next</button></form>',
  [`${accounts}/password`]:
    '<h1>Enter your password</h1><form method="post" action="/password"><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
};

test.describe.configure({ timeout: 120_000 });

/** The site and its pop-up, on every page of the browser: each post, in order. */
const serve = async (page: Page) => {
  const posts: string[] = [];
  await page.context().route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "POST")
      return route.fulfill({ contentType: "text/html", body: pages[`${url.origin}${url.pathname}`] ?? "<p>Not found</p>" });
    posts.push(`${url.pathname} ${request.postData() ?? ""}`);
    // The email goes on to the password; the password signs the site's page in and the pop-up
    // closes a moment later.
    return route.fulfill({
      contentType: "text/html",
      body:
        url.pathname === "/sign-in"
          ? "<script>location.replace('/password')</script>"
          : `<p>Signing you in</p><script>setTimeout(() => { opener.location.replace('${site}/home'); close(); }, 1000)</script>`,
    });
  });
  return posts;
};

/** The host's browser, hooks and scan on `page`, as a host gives them to a replay. */
const hostOn = async (page: Page) => {
  const host = await hostPage(page);
  const observe = (popup: SignInStatePopup | undefined) =>
    observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [accounts], identifiers: [username], popup });
  const { keyboard } = await hostKeyboard(page);
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [accounts], typing: { typed: false } });
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
  return { browser, hooks, observe };
};

/**
 * A build's library, read as the recorder reads each screen just before its fill: the site's page,
 * then each pop-up screen in the pop-up its inspection found.
 */
const recorded = async (page: Page) => {
  const { browser, observe } = await hostOn(page);
  const read = async (step: AutofillRecipeStep) => {
    // The step as the minter sends it: its email box names the slot it takes.
    const sent: AutofillStep = {
      ...step,
      fields: step.fields.map((field) => ("accepts" in field ? { selector: field.selector, slot: "email" } : field)),
    };
    const inspection = await Effect.runPromise(browser.inspect(sent));
    if ("outcome" in inspection) throw new Error(inspection.reason);
    const observed = await Effect.runPromise(observe(stepPopup(step, inspection)));
    if (observed === undefined) throw new Error("The scan read nothing");
    return { fingerprint: observed.fingerprint, step };
  };
  await page.goto(opener.page);
  const states = [await read(opener)];
  const opened = page.waitForEvent("popup");
  await page.click("#open");
  const shown = await opened;
  await shown.waitForSelector("#email");
  states.push(await read(emailStep));
  await shown.fill("#email", username);
  await shown.click("#next");
  await shown.waitForSelector("#password");
  states.push(await read(passwordStep));
  await shown.close();
  const appended = appendSignInStates(signInStatesOf({}, []), { states, signedIn: { selector: "#account" } });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

/** A run's replay of `library` from the site's sign-in page, reading pop-ups as a run does. */
const replay = async (page: Page, library: SignInStates) => {
  const { hooks, observe } = await hostOn(page);
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe: observe(statesPopup(library)),
        hooks,
        entryUrl: opener.page,
        credentials: { username, password },
        ask: makeInputAsker(() => Effect.succeed({})),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "shop.example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 4_000, pollMs: 250 },
        sent: { current: false },
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  return ended.right;
};

test("a sign-in in a pop-up is recorded by the pop-up's own look and replays through each of its screens", async ({ page }) => {
  const posts = await serve(page);
  const library = await recorded(page);
  // Each pop-up screen is a look of its own, on the pop-up's origin, apart from the page that opened it.
  const [first, email, typed] = library.states.map((state) => state.fingerprint);
  expect(email).toMatchObject({ top: accounts, popup: true });
  expect(typed).toMatchObject({ top: accounts, popup: true });
  expect(new Set([first, email, typed].map((look) => JSON.stringify(look))).size).toBe(3);
  await page.goto("about:blank");
  posts.length = 0;
  const ended = await replay(page, library);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, visited: library.states.map((state) => state.key) });
  expect(posts).toEqual([`/sign-in email=${encodeURIComponent(username)}`, `/password password=${password}`]);
});
