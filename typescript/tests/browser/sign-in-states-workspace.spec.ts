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

// A sign-in replayed from a library of states whose header names a workspace, on local Chromium
// with the host's own scan, inspection and fill: the identifier on the shared host, then the
// password on the login's own workspace host the site sent it to. Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.com";
const parent = "example.com";
const password = "synthetic-password";
const accounts: Readonly<Record<string, string>> = {
  "ada-owner": "https://acme.example.com",
  "grace-owner": "https://globex.example.com",
};

test.describe.configure({ timeout: 120_000 });

/**
 * The site: the identifier at the shared host's /login, the password at /login/password on the
 * account's workspace host, then /home there with the account marker. Each value sent, by host.
 */
const serve = async (page: Page) => {
  const sent: string[] = [];
  let typed = "";
  await page.route(/^https:\/\//u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      const value = new URLSearchParams(request.postData() ?? "").get("value") ?? "";
      sent.push(`${url.host}${url.pathname}`);
      const next =
        url.pathname === "/login"
          ? `${accounts[value] ?? site}/login/password`
          : value === password && Object.values(accounts).includes(url.origin)
            ? `${url.origin}/home`
            : `${url.origin}/login/password`;
      if (url.pathname === "/login") typed = value;
      await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(next)})</script>` });
      return;
    }
    const body =
      url.pathname === "/login"
        ? '<form method="post" action="/login"><label>Username<input id="username" name="value"></label><button id="next">Next</button></form>'
        : url.pathname === "/login/password"
          ? '<form method="post" action="/login/password"><label>Password<input id="password" name="value" type="password"></label><button id="sign-in">Sign in</button></form>'
          : url.pathname === "/home" && typed !== ""
            ? '<p id="account">Your workspace</p>'
            : "<p>Not found</p>";
    await route.fulfill({ contentType: "text/html", body });
  });
  return sent;
};

/** The host's hooks and its scan on `page`, as a host gives them to a replay. */
const hostOn = async (page: Page, username: string) => {
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
  const observe = observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [], workspace: { parent }, identifiers: [username] });
  return { host, hooks, observe };
};

/** The page as the host's scan reads it at `url`, as a build notes each state it acts in. */
const scanAt = async (page: Page, url: string) => {
  await page.goto(url);
  const { observe } = await hostOn(page, "ada-owner");
  const state = await Effect.runPromise(observe);
  if (state === undefined) throw new Error("The scan read nothing");
  return state.fingerprint;
};

/** A build's library: the identifier on the shared host, the password on `workspace`. */
const recorded = (identifier: StateFingerprint, secret: StateFingerprint): SignInStates => {
  const steps: readonly AutofillRecipeStep[] = [
    { page: `${site}/login`, fields: [{ selector: "#username", accepts: ["username"] }], submit: "#next" },
    { origin: "workspace", page: "/login/password", fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
  ];
  const appended = appendSignInStates(signInStatesOf({ workspace: { parent } }, []), {
    states: [identifier, secret].map((fingerprint, index) => ({ fingerprint, step: steps[index] as AutofillRecipeStep })),
    signedIn: { selector: "#account", openPath: "/home" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

const signIn = async (page: Page, library: SignInStates, username: string) => {
  const { host, hooks, observe } = await hostOn(page, username);
  const events: string[] = [];
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
        workspace: {
          siteOrigin: site,
          parent,
          pinned: undefined,
          observe: (event) => Effect.sync(() => void events.push(`${event.kind} ${event.origin}`)),
        },
        timing: { stepWaitMs: 8_000, pollMs: 250 },
        sent: { current: false },
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  expectNotCarried(host.calls, password);
  return { ended: ended.right, events };
};

test("a library whose header names a workspace signs each account in on its own workspace host", async ({ page }) => {
  const sent = await serve(page);
  const identifier = await scanAt(page, `${site}/login`);
  const secret = await scanAt(page, `${accounts["ada-owner"]}/login/password`);
  // The scan names the workspace host as the library holds it.
  expect(secret.top).toBe("workspace");
  expect(secret.boxes.map((box) => box.frame)).toEqual(["workspace"]);
  const library = recorded(identifier, secret);
  sent.length = 0;

  for (const [username, workspace] of Object.entries(accounts)) {
    await page.context().clearCookies();
    const { ended, events } = await signIn(page, library, username);
    expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, workspaceOrigin: workspace });
    expect(ended.visited).toEqual(library.states.map((state) => state.key));
    expect(events).toEqual([`admitted ${workspace}`]);
  }
  expect(sent).toEqual([
    "app.example.com/login",
    "acme.example.com/login/password",
    "app.example.com/login",
    "globex.example.com/login/password",
  ]);
});
