import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, type SignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { HostedSignIn } from "../../src/runtime/autofill-replay-steps.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in replayed from a library of states on local Chromium, with the host's own scan,
// inspection and fill, where the site asks something more once the password went in. Every host is
// synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://bank.example.test";
const username = "ada-owner";
const password = "synthetic-password";
const login: AutofillRecipeStep = {
  page: `${site}/login`,
  fields: [{ selector: "#username", accepts: ["username"] }, { selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const loginPage =
  '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>';

const verify =
  '<form method="post" action="/verify"><label>Verification code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label><button id="verify">Verify</button></form>';

test.describe.configure({ timeout: 120_000 });

/** The site: each path's page, and where each form's post goes on to. Each post, in order. */
const serve = async (page: Page, pages: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>) => {
  const posts: string[] = [];
  await page.route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "POST") {
      posts.push(`${pathname} ${request.postData() ?? ""}`);
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next[pathname])})</script>` });
    } else await route.fulfill({ contentType: "text/html", body: pages[pathname] ?? "<p>Not found</p>" });
  });
  return posts;
};

/** The host's hooks and scan on `page`, as a host gives them to a replay. */
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
  return { hooks, observe: observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [], identifiers: [username] }) };
};

/** A build's library: each step on the page the host's scan read at its path. */
const recorded = async (page: Page, steps: readonly AutofillRecipeStep[]) => {
  const states = [];
  for (const step of steps) {
    await page.goto(step.page);
    const read = await Effect.runPromise((await hostOn(page)).observe);
    if (read === undefined) throw new Error("The scan read nothing");
    states.push({ fingerprint: read.fingerprint, step });
  }
  const appended = appendSignInStates(signInStatesOf({}, []), { states, signedIn: { selector: "#account" } });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

/**
 * A run's replay of `library` from the login page, answering every ask with `answers`, with what
 * the host adds on its hooks (`hosted`). The ids of the questions asked, in order.
 */
const replay = async (
  page: Page,
  library: SignInStates,
  answers: InputAnswers,
  hosted?: (hooks: AutofillHooks<TestFailure>) => HostedSignIn<TestFailure>,
) => {
  const { hooks, observe } = await hostOn(page);
  const asked: string[] = [];
  const ended = await Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe,
        hooks,
        entryUrl: `${site}/login`,
        credentials: { username, password },
        ask: makeInputAsker((request) => Effect.sync(() => (asked.push(...request.questions.map((question) => question.id)), answers))),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "bank.example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 4_000, pollMs: 250 },
        sent: { current: false },
        ...(hosted === undefined ? {} : { hosted: hosted(hooks) }),
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  return { ended: ended.right, asked };
};

/** The login's saved answer, and the host's own flag of it where its question shows again. */
const savedAnswer =
  (flagged: string[]) =>
  (hooks: AutofillHooks<TestFailure>): HostedSignIn<TestFailure> => ({
    privateAnswer: () => Effect.succeed({ slot: "private_answer", value: "synthetic-saved-answer" }),
    refuseShownAnswer: (ran) => {
      const step = ran.findLast((taken) => taken.fields.some((field) => field.slot === "private_answer"));
      return step === undefined
        ? Effect.void
        : hooks.inspect(step).pipe(Effect.map((shown) => void flagged.push("outcome" in shown ? "gone" : "shown")));
    },
  });

test("a saved security answer the site asks for again is flagged through the host's hook", async ({ page }) => {
  const question =
    '<form method="post" action="/question"><p id="question">What was the name of your first pet?</p><label>Answer<input id="answer" name="answer"></label><button id="next">Continue</button></form>';
  // The site takes the login and refuses every answer, asking the same question again.
  const posts = await serve(page, { "/login": loginPage, "/question": question }, { "/login": "/question", "/question": "/question" });
  const library = await recorded(page, [
    login,
    { page: `${site}/question`, fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }], submit: "#next" },
  ]);
  await page.goto("about:blank");
  posts.length = 0;
  const flagged: string[] = [];
  const { ended } = await replay(page, library, {}, savedAnswer(flagged));
  expect(ended.outcome).not.toBe("signed_in");
  expect(posts.filter((post) => post.startsWith("/question"))).toEqual(["/question answer=synthetic-saved-answer"]);
  expect(flagged).toEqual(["shown"]);
});

test("a code page the library never recorded, after the password, is answered once and signs in", async ({ page }) => {
  const code = "246810";
  const posts = await serve(
    page,
    { "/login": loginPage, "/verify": verify, "/home": '<p id="account">Your account</p>' },
    { "/login": "/verify", "/verify": "/home" },
  );
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(asked).toEqual(["code"]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([`/verify code=${code}`]);
  // The page's look and the state before it, for the host to have the page recorded.
  expect(ended.unrecordedCode).toEqual({
    fingerprint: expect.objectContaining({ boxes: [expect.objectContaining({ kind: "code" })] }),
    after: library.states[0]?.key,
  });
});

test("a refused password beside a security question flags no saved answer", async ({ page }) => {
  const both = loginPage.replace(
    "<button",
    '<p id="question">What was the name of your first pet?</p><label>Answer<input id="answer" name="answer"></label><button',
  );
  await serve(page, { "/login": both }, { "/login": "/login" });
  const library = await recorded(page, [
    { ...login, fields: [...login.fields, { selector: "#answer", slot: "private_answer", questionSelector: "#question" }] },
  ]);
  await page.goto("about:blank");
  const flagged: string[] = [];
  const { ended } = await replay(page, library, {}, savedAnswer(flagged));
  expect(ended.outcome).not.toBe("signed_in");
  expect(flagged).toEqual([]);
});

test("a login page that comes back typed beside a new code box gets no code, and the password goes once", async ({ page }) => {
  const returned = loginPage
    .replace('name="username"', `name="username" value="${username}"`)
    .replace('type="password"', `type="password" value="${password}"`)
    .replace("<button", '<label>Code<input id="otp" name="otp" autocomplete="one-time-code"></label><button');
  const posts = await serve(page, { "/login": loginPage, "/login/again": returned }, { "/login": "/login/again" });
  const library = await recorded(page, [login]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code: "246810" });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(asked).toEqual([]);
  expect(posts).toHaveLength(1);
});

test("a code page right after the username, before any password, gets no code", async ({ page }) => {
  const identifier =
    '<form method="post" action="/login"><label>Username<input id="username" name="username"></label><button id="next">Next</button></form>';
  const posts = await serve(page, { "/login": identifier, "/verify": verify }, { "/login": "/verify" });
  const library = await recorded(page, [{ page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" }]);
  await page.goto("about:blank");
  posts.length = 0;
  const { ended, asked } = await replay(page, library, { code: "246810" });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(asked).toEqual([]);
  expect(posts.filter((post) => post.startsWith("/verify"))).toEqual([]);
});

/**
 * A page after the password asking to remember the device, recorded so, that asks about the
 * browser at the run, with a library of the login state and that page recorded in one sign-in
 * (`led`) and one where no sign-in learned the page after the login state (`apart`).
 */
const reworded = async (page: Page) => {
  const trust = (word: string) =>
    `<h1>Remember this ${word}?</h1><p>You won't need a code here next time.</p><form method="post" action="/trust"><button id="remember" name="remember" value="yes">Remember</button><button id="not-now" name="remember" value="no">Not now</button></form>`;
  const pages: Record<string, string> = { "/login": loginPage, "/trust": trust("device"), "/home": '<p id="account">Your account</p>' };
  const posts = await serve(page, pages, { "/login": "/trust", "/trust": "/home" });
  const step: AutofillRecipeStep = { page: `${site}/trust`, fields: [], submit: "#not-now" };
  const led = await recorded(page, [login, step]);
  const fingerprint = led.states[1]?.fingerprint;
  if (fingerprint === undefined) throw new Error("The page after the password was not recorded");
  const apart = appendSignInStates(await recorded(page, [login]), { states: [{ fingerprint, step }], signedIn: { selector: "#account" } });
  if ("refused" in apart) throw new Error(apart.refused);
  pages["/trust"] = trust("browser");
  await page.goto("about:blank");
  posts.length = 0;
  return { posts, led, apart: apart.library };
};

test("a page after the password whose question the site reworded is taken by its control where the login state led to it", async ({ page }) => {
  const { posts, led } = await reworded(page);
  const { ended } = await replay(page, led, {});
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(posts).toEqual([`/login username=${username}&password=${password}`, "/trust remember=no"]);
});

test("a reworded page after the password that no sign-in learned after the login state stays unknown", async ({ page }) => {
  const { posts, apart } = await reworded(page);
  const { ended } = await replay(page, apart, {});
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(posts).toEqual([`/login username=${username}&password=${password}`]);
});
