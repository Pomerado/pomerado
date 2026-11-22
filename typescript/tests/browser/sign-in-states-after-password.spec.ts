import { expect, test, type Page } from "@playwright/test";
import { Data, Effect, Either } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
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
  const { hooks, observe } = await hostOn(page);
  const flagged: string[] = [];
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
        site: "bank.example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 4_000, pollMs: 250 },
        sent: { current: false },
        hosted: {
          // The login's saved answer, and the host's own check that its question shows again.
          privateAnswer: () => Effect.succeed({ slot: "private_answer", value: "synthetic-saved-answer" }),
          refuseShownAnswer: (ran) => {
            const step = ran.findLast((taken) => taken.fields.some((field) => field.slot === "private_answer"));
            return step === undefined
              ? Effect.void
              : hooks.inspect(step).pipe(Effect.map((shown) => void flagged.push("outcome" in shown ? "gone" : "shown")));
          },
        },
      }),
    ),
  );
  if (Either.isLeft(ended)) throw ended.left;
  expect(ended.right.outcome).not.toBe("signed_in");
  expect(posts.filter((post) => post.startsWith("/question"))).toEqual(["/question answer=synthetic-saved-answer"]);
  expect(flagged).toEqual(["shown"]);
});
