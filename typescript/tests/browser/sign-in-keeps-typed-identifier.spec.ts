import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// An identifier-first sign-in that keeps both screens in one page. The email screen's Next shows
// the password box below the email box, and any change to the email box goes back to the email
// screen: the password box is hidden again and Next shows in place of Sign in. The recorded second
// screen lists the email box again with the password box. The replay keeps the email it typed on
// the first screen, since that same box on the same page still holds it, and types only the
// password, so the password box stays shown and the sign-in goes through.

const site = "https://accounts.example.test";
const host = "accounts.example.test";
const login = { username: "owner@accounts.example.test", password: "synthetic-password" };

const loginPage = `<form id="login" method="post" action="/session">
<label>Email<input id="email" name="email" type="email" autocomplete="username"></label>
<div id="password-row" hidden><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label></div>
<button id="next" type="button">Next</button>
<button id="sign-in" type="submit" hidden>Sign in</button>
</form>
<script>
const row = document.getElementById("password-row");
const next = document.getElementById("next");
const signIn = document.getElementById("sign-in");
const show = (passwordStep) => {
  row.hidden = !passwordStep;
  signIn.hidden = !passwordStep;
  next.hidden = passwordStep;
};
next.addEventListener("click", () => show(true));
document.getElementById("email").addEventListener("input", () => show(false));
</script>`;

/** The site: its login page, the session post, which it keeps, and the account page it answers. */
const serve = async (page: Page) => {
  const posted: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posted.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else await route.fulfill({ contentType: "text/html", body: loginPage });
  });
  return posted;
};

/** Screen 1 takes the email, then Next. Screen 2 lists the email box again, then the password. */
const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/login`,
      fields: [{ selector: "#email", accepts: ["email"] }],
      submit: "#next",
      submittedBy: "host",
    },
    {
      page: `${site}/login`,
      fields: [
        { selector: "#email", accepts: ["email"] },
        { selector: "#password", slot: "password" },
      ],
      submit: "#sign-in",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** A report as the replay's step diagnostic gives it: the fields' statuses and the submit. */
const shown = (report: AutofillStepReport) =>
  report.outcome === "filled"
    ? `${report.fields.map((field) => field.status).join(",")} ${report.submit}`
    : report.outcome;

test("a replay keeps the email it typed on the screen before, so a page that resets on a changed email takes the password", async ({
  page,
}) => {
  const posted = await serve(page);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const ask = makeInputAsker(() =>
    Effect.succeed({ login: { ...login, saveLogin: false } }),
  );
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const reports: AutofillStepReport[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: {
          ...signIn,
          fill: (input) => signIn.fill(input).pipe(Effect.tap((report) => reports.push(report))),
        },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 5_000, pollMs: 250 },
      }),
    ),
  );
  const outcome = Either.isRight(result)
    ? { signedIn: true }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  // Before, the second screen emptied and typed the email again, which hid the password box:
  // `filled,failed`, with the password box found but hidden (`0/1`), and `fill_failed`.
  expect({
    outcome,
    reports: reports.map(shown),
    matches: reports.map(
      (report) => Reflect.get(Object(Reflect.get(report, "failureDetail")), "context")?.matches,
    ),
  }).toEqual({
    outcome: { signedIn: true },
    reports: ["filled clicked", "filled,filled clicked"],
    matches: [undefined, undefined],
  });
  expect(posted).toEqual([{ email: login.username, password: login.password }]);
  await expect(page.locator("#account")).toBeVisible();
  for (const value of [login.username, login.password]) expectNotCarried(browser.calls, value);
});
