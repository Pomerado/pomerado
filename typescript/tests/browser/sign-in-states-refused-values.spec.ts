import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import { observeSignInState } from "../../src/destinations/sign-in-state-scan.js";
import { appendSignInStates, signInStatesOf } from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in replayed from its screens on local Chromium, where the screen types each box
// alone and then presses its button. The site refuses the saved password and shows its error under
// the form, which the screen records as its password's rejection marker. A refused password is
// never typed again, even when the owner's correction repeats it.

const site = "https://app.example.test";
const email = "owner@app.example.test";
const [saved, corrected] = ["synthetic-saved-password", "synthetic-new-password"];

test.describe.configure({ timeout: 120_000 });

const form = (refused: boolean) =>
  `<form method="post" action="/login">${refused ? '<p id="login-error">Wrong password</p>' : ""}<label>Email<input id="email" name="email" type="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>`;

/**
 * The site: the login form at /login, shown again with its error after a refused password, and
 * the account at /home once the corrected one went in. Each password posted, in order.
 */
const serve = async (page: Page) => {
  const posted: string[] = [];
  let signedIn = false;
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const password = new URLSearchParams(request.postData() ?? "").get("password") ?? "";
      posted.push(password);
      signedIn = password === corrected;
      await route.fulfill({
        contentType: "text/html",
        body: signedIn ? '<script>location.replace("/home")</script>' : form(true),
      });
      return;
    }
    const home = new URL(request.url()).pathname === "/home" && signedIn;
    await route.fulfill({ contentType: "text/html", body: home ? '<p id="account">Your account</p>' : form(false) });
  });
  return posted;
};

test("a password the site refused is never typed again when the owner's correction repeats it", async ({ page }) => {
  const posted = await serve(page);
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const browser = makeSignInBrowser({ page: host, keyboard, siteOrigin: site, authenticationOrigins: [], typing: { typed: false } });
  await page.goto(`${site}/login`);
  const login = await Effect.runPromise(observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [] }));
  if (login === undefined) throw new Error("The scan read nothing");
  const appended = appendSignInStates(signInStatesOf({}, []), {
    states: [
      {
        fingerprint: login.fingerprint,
        step: {
          page: `${site}/login`,
          fields: [
            { selector: "#email", accepts: ["email"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          rejectedMarkers: [{ slot: "password", selector: "#login-error" }],
        },
      },
    ],
    signedIn: { selector: "#account" },
  });
  if ("refused" in appended) throw new Error(appended.refused);
  await page.goto("about:blank");
  // The owner's login holds the saved password; the first correction repeats it and the second
  // is new.
  const asked: string[] = [];
  const secrets = makeRunSecrets();
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      const reason = question?.type === "credential" ? question.reason : "other";
      asked.push(reason);
      const corrections = asked.filter((each) => each === "invalid_credentials").length;
      return { login: { username: email, password: corrections === 2 ? corrected : saved, saveLogin: false } };
    }),
  );
  const ended = await Effect.runPromise(
    Effect.either(
      signInForRun({
        states: appended.library,
        entryUrl: `${site}/login`,
        browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: "app.example.test",
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expect(Either.isRight(ended) ? ended.right : ended.left).toEqual({ alreadySignedIn: false });
  // The repeat is asked again and never typed: the site gets the refused password once.
  expect(asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
  expect(posted).toEqual([saved, corrected]);
});
