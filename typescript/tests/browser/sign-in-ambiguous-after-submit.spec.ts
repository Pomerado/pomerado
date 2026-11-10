import { expect, test, type Page } from "@playwright/test";
import { Effect, Either } from "effect";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A portal whose sign-in API answers 403 to the password and then shows a verification screen in
// the same page. The verification screen draws beside the password screen, and the password
// screen goes a moment later, so for that moment the recorded code screen's button matches both
// screens' buttons. Right after a submit, the replay waits through that moment as it waits for a
// screen not yet shown, and types or clicks nothing while the step matches more than one element.
// Before anything was submitted, a step that matches twice refuses at once, as it always did.
// The password screen is hidden 400 ms after the replay first saw both buttons, so the moment is
// seen however long the host's submit took to return. It is hidden, not removed, as a page that
// keeps its screens in the document does.

const site = "https://portal.example.test";
const host = "portal.example.test";
const code = "246810";
const login = { username: "owner@portal.example.test", password: "synthetic-password" };
const stepWaitMs = 8_000;
// Two replays, a screen's wait that may run to its deadline, and a code: more than the default
// 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

/**
 * The portal's one page. Its password screen posts the login to /api/session from its own script.
 * A 403 answer draws the verification screen (a code field in no form and a Verify button with the
 * same class as the Sign in button) beside it and moves the address to /verify; the password screen
 * is hidden only when the test calls `finishSwap`. A verified code loads the account. With
 * `extraButton` the password screen's form also shows a second primary button before anything is
 * sent.
 */
const portal = (extraButton = false) => `<main>
<section id="password-screen">
<form id="login-form" method="post" action="/api/session">
<label>Email<input id="email" name="email" autocomplete="username"></label>
<label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
<button class="primary" type="submit">Sign in</button>${extraButton ? '\n<button class="primary" type="button">Use single sign-on</button>' : ""}
</form>
</section>
</main>
<script>
window.verifyClicks = 0;
window.finishSwap = () => {
  const old = document.getElementById("password-screen");
  if (old) old.hidden = true;
};
const form = document.getElementById("login-form");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then((response) => {
      if (response.status !== 403) return;
      const verify = document.createElement("section");
      verify.id = "code-screen";
      verify.innerHTML = '<label>Code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label><button class="primary" type="button">Verify</button>';
      document.querySelector("main").append(verify);
      history.pushState(null, "", "/verify");
      verify.querySelector("button").addEventListener("click", () => {
        window.verifyClicks += 1;
        fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("code").value }) })
          .then((answer) => { if (answer.ok) location.assign("/account"); });
      });
    });
});
</script>`;

/**
 * The portal: its page at /login, the sign-in API that answers every login 403, the code check and
 * the account. It keeps when each login reached the API and each code it received.
 */
const serve = async (page: Page, body: string) => {
  const sessions: number[] = [];
  const codes: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/session") {
      sessions.push(Date.now());
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"error":"verification_required"}',
      });
    } else if (request.method() === "POST" && path === "/api/code") {
      const sent: unknown = Reflect.get(Object(JSON.parse(request.postData() ?? "{}")), "code");
      codes.push(typeof sent === "string" ? sent : "");
      await route.fulfill({ status: sent === code ? 200 : 400, contentType: "application/json", body: "{}" });
    } else if (path === "/account")
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    else await route.fulfill({ contentType: "text/html", body });
  });
  return { sessions, codes };
};

/** The recipe the build recorded: the password screen, then the code screen, both by class. */
const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/login`,
      fields: [
        { selector: "#email", accepts: ["email"] },
        { selector: "#password", slot: "password" },
      ],
      submit: "button.primary",
      submittedBy: "host",
    },
    {
      page: `${site}/verify`,
      fields: [{ selector: "#code", slot: "code" }],
      submit: "button.primary",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/** What one inspection of a step answered: the step's first field, and found or why not. */
type Inspected = { readonly field: string | undefined; readonly answer: string; readonly at: number };

/**
 * One run's sign-in, answering the login ask and each code ask, with every fill and inspection.
 * With `swapMs`, the password screen is hidden that long after the code screen's first look found
 * both buttons.
 */
const run = async (page: Page, swapMs?: number) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.id ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const reports: AutofillStepReport[] = [];
  const inspected: Inspected[] = [];
  const refusals: AutofillRefusal[] = [];
  const note = (field: string | undefined, answer: AutofillInspection | AutofillRefusal) => {
    if ("outcome" in answer) refusals.push(answer);
    const firstAmbiguous =
      field === "#code" &&
      "outcome" in answer &&
      answer.reason === "ambiguous_match" &&
      !inspected.some((one) => one.answer === "ambiguous_match");
    if (firstAmbiguous && swapMs !== undefined)
      setTimeout(
        () =>
          void page.evaluate(() => Reflect.get(window, "finishSwap")()).catch(() => undefined),
        swapMs,
      );
    inspected.push({
      field,
      answer: "outcome" in answer ? answer.reason : "found",
      at: Date.now(),
    });
  };
  const started = Date.now();
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: {
          ...signIn,
          inspect: (step) =>
            signIn.inspect(step).pipe(Effect.tap((answer) => note(step.fields[0]?.selector, answer))),
          fill: (input) => signIn.fill(input).pipe(Effect.tap((report) => reports.push(report))),
        },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs, pollMs: 250 },
      }),
    ),
  );
  const ended = Date.now();
  for (const value of [code, login.password]) expectNotCarried(browser.calls, value);
  const outcome = Either.isRight(result)
    ? { signedIn: true, alreadySignedIn: result.right.alreadySignedIn }
    : { code: Reflect.get(result.left, "code"), reason: Reflect.get(result.left, "reason") };
  return { outcome, prompts, reports, inspected, refusals, started, ended };
};

test("a sign-in waits through a verification screen drawn beside the password screen after a 403, then types the code", async ({
  page,
}) => {
  const { sessions, codes } = await serve(page, portal());
  const { outcome, prompts, reports, inspected } = await run(page, 400);
  expect(outcome).toEqual({ signedIn: true, alreadySignedIn: false });
  // The code screen's button matched both screens' buttons a moment after the submit, and the
  // replay went on once only the code screen showed.
  const codeScreen = inspected.filter((one) => one.field === "#code");
  expect(codeScreen.map((one) => one.answer)).toContain("ambiguous_match");
  expect(codeScreen.at(-1)?.answer).toBe("found");
  expect(prompts).toEqual(["login", "code"]);
  expect(sessions).toHaveLength(1);
  expect(codes).toEqual([code]);
  expect(reports.map((report) => report.outcome)).toEqual(["filled", "filled"]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a sign-in whose next step still matches two buttons at its deadline refuses it as ambiguous, with nothing typed or clicked", async ({
  page,
}) => {
  const { sessions, codes } = await serve(page, portal());
  const { outcome, prompts, reports, inspected, refusals, ended } = await run(page);
  expect(outcome).toEqual({ code: "RecipeFailed", reason: "ambiguous_match" });
  // The password went out once, and the code screen took nothing: no code was asked or typed,
  // and neither button was clicked again.
  expect(prompts).toEqual(["login"]);
  expect(sessions).toHaveLength(1);
  expect(codes).toEqual([]);
  expect(reports).toHaveLength(1);
  await expect(page.locator("#code")).toHaveValue("");
  expect(await page.evaluate(() => Reflect.get(window, "verifyClicks"))).toBe(0);
  // It refused at the screen's deadline, not at once, with the refusal it always gave.
  const submittedAt = sessions[0] ?? Number.NaN;
  expect(ended - submittedAt).toBeGreaterThanOrEqual(stepWaitMs);
  expect(ended - submittedAt).toBeLessThan(stepWaitMs + 5_000);
  const codeScreen = inspected.filter((one) => one.field === "#code");
  expect(codeScreen.length).toBeGreaterThan(1);
  expect(codeScreen.every((one) => one.answer === "ambiguous_match")).toBe(true);
  expect(refusals.at(-1)).toMatchObject({
    outcome: "refused",
    reason: "ambiguous_match",
    target: "submit",
    failureDetail: {
      phase: "ambiguous_match",
      context: { check: "ambiguous_match", framesSearched: 1, matches: `${site} 2/2` },
    },
  });
});

test("a sign-in whose first screen matches two buttons before anything was sent refuses it at once", async ({
  page,
}) => {
  const { sessions } = await serve(page, portal(true));
  const { outcome, reports, inspected, started, ended } = await run(page);
  expect(outcome).toEqual({ code: "RecipeFailed", reason: "ambiguous_match" });
  expect(sessions).toEqual([]);
  expect(reports).toEqual([]);
  // The value-free check and the replay with the login each refused on their first look.
  expect(inspected.map((one) => one.answer)).toEqual(["ambiguous_match", "ambiguous_match"]);
  expect(ended - started).toBeLessThan(stepWaitMs);
});
