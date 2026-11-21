import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import { resubmitAutofillStep, fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  inspectAutofillStep,
  type AutofillInspection,
  type AutofillStep,
  type AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose code screen has the owner pick the emailed code from a grid of named
// checkboxes, each drawn as a picture, with no text box and an Authenticate button that stays
// disabled until a box is ticked. The run asks for the code with the choices' names, ticks the
// ones the answer names, and clicks Authenticate.

const site = "https://miles.example.test";
const host = "miles.example.test";
const login = { username: "owner@miles.example.test", password: "synthetic-password" };
test.describe.configure({ timeout: 120_000 });

const choices = [
  "seven", "nine", "kite", "two", "five", "six", "four", "eight", "zero", "one",
  "apple", "boat", "cloud", "three", "drum", "fish", "leaf", "star",
];
const picture = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// The site's own key for each choice, which the form posts; the owner's email names the pictures.
const key = (name: string) => `t${choices.indexOf(name) + 10}`;
const code = ["seven", "three", "kite"];

/**
 * The code screen: the grid of `names`, as checkboxes or as buttons, and an Authenticate button
 * that a ticked box enables, unless it stays disabled (`stuck`) or a banner covers it (`covered`).
 */
const gridPage = ({
  names = choices,
  buttons = false,
  stuck = false,
  covered = false,
}: { names?: readonly string[]; buttons?: boolean; stuck?: boolean; covered?: boolean } = {}) =>
  `<style>.tile { position: absolute; opacity: 0; width: 1px; height: 1px; } #otp-choices li { display: inline-block; }
#authenticate { position: fixed; left: 0; bottom: 0; width: 160px; height: 40px; }
#banner { position: fixed; left: 0; bottom: 0; width: 100%; height: 80px; z-index: 10; background: #fff; }</style>
<div role="dialog" aria-labelledby="title">
<h3 id="title">Enter your one-time password</h3>
<p>Select the numbers and pictures in the one-time password we emailed you. They can be selected in any order.</p>
<form method="post" action="/verify-code">
<ul id="otp-choices">${names
  .map((name, index) =>
    buttons
      ? `<li><button type="button" aria-label="${name}"><img alt="" width="40" height="40" src="${picture}"></button></li>`
      : `<li><input type="checkbox" class="tile" id="c-${index}" name="otp" value="${key(name)}"><label for="c-${index}"><img alt="${name}" width="40" height="40" src="${picture}"></label></li>`,
  )
  .join("")}</ul>
<button id="authenticate" disabled>Authenticate</button>
</form>
</div>
${covered ? '<div id="banner">This site uses cookies</div>' : ""}
<script>
const tiles = [...document.querySelectorAll(".tile")];
const authenticate = document.getElementById("authenticate");
for (const tile of tiles)
  tile.addEventListener("change", () => { authenticate.disabled = ${stuck ? "true" : "!tiles.some((each) => each.checked)"}; });
</script>`;
const grid = gridPage();

/** The site: a sign-in form, then the code screen, which keeps each set of choices it gets. */
const serve = async (page: Page) => {
  const posted: string[][] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/verify-code") {
      const picked = new URLSearchParams(request.postData() ?? "").getAll("otp").sort();
      posted.push(picked);
      const right = JSON.stringify(picked) === JSON.stringify(code.map(key).sort());
      await route.fulfill({
        contentType: "text/html",
        body: right ? '<p id="account">Signed in</p>' : `<p id="error">Wrong code</p>${grid}`,
      });
    } else if (request.method() === "POST" && path === "/session")
      await route.fulfill({ contentType: "text/html", body: '<script>location.replace("/verify")</script>' });
    else if (path === "/verify") await route.fulfill({ contentType: "text/html", body: grid });
    else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
      });
  });
  return posted;
};

const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/login`,
      fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
      submit: "#sign-in",
      submittedBy: "host",
    },
    {
      page: `${site}/verify`,
      fields: [{ selector: "#otp-choices", slot: "code" }],
      submit: "#authenticate",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
} as const;

const choicesLine = `The sign-in screen takes the code as a pick of these choices, so enter the ones your code shows: ${choices.join(", ")}.`;
const codePrompt = `Enter the sign-in code ${host} sent you. ${choicesLine}`;
const misfitPrompt = `That answer didn't match the sign-in screen's choices one for one, so nothing was picked and the website's code still works. Enter the sign-in code ${host} sent you. ${choicesLine}`;

test("a run asks for a code picked from named checkboxes, asks again for an answer the choices lack, then ticks the code's choices and signs in", async ({
  page,
}) => {
  const posted = await serve(page);
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const answers = ["7 3 comet", "7 3 Kite"];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: answers.shift() ?? "" };
    }),
  );
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  // Every fill's report, as a host emits it.
  const reports: AutofillStepReport[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: {
          ...signIn,
          fill: (input) =>
            signIn.fill(input).pipe(Effect.tap((report) => Effect.sync(() => reports.push(report)))),
        },
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt, misfitPrompt]);
  expect(posted).toEqual([code.map(key).sort()]);
  await expect(page.locator("#account")).toBeVisible();
  for (const value of ["7 3 comet", "7 3 Kite", login.password]) expectNotCarried(browser.calls, value);
  // No report or call answer holds a picked choice beside the code slot, or the picks in order.
  const picks = JSON.stringify(code).slice(1, -1);
  const leaks = [...reports, ...browser.calls.map(({ answer }) => answer)].filter((record) => {
    const text = JSON.stringify(record) ?? "";
    return (
      text.includes(picks) ||
      (text.includes('"slot":"code"') && code.some((name) => text.includes(`"${name}"`)))
    );
  });
  expect(leaks).toEqual([]);
});

const choiceStep: AutofillStep = {
  fields: [{ selector: "#otp-choices", slot: "code" }],
  submit: "#authenticate",
};

/** The code screen as `gridPage` draws it, opened on its own, with the host over the page. */
const codeScreen = async (page: Page, options?: Parameters<typeof gridPage>[0]) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: gridPage(options) }),
  );
  await page.goto(`${site}/verify`);
  return hostPage(page);
};

const inspectChoices = (browser: Awaited<ReturnType<typeof hostPage>>) =>
  Effect.runPromise(
    inspectAutofillStep({ step: choiceStep, page: browser, siteOrigin: site, authenticationOrigins: [] }),
  );

const fillChoices = async (page: Page, browser: Awaited<ReturnType<typeof hostPage>>) => {
  const inspection = (await inspectChoices(browser)) as AutofillInspection;
  expect(inspection.screen.fields[0]?.codeChoices).toEqual(choices);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: choiceStep,
      values: ["7 3 kite"],
      inspection,
      page: browser,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  return { inspection, report };
};

/** The page as Guardian's snapshot reads it: the grid still shows, and no choice in it is ticked. */
const expectUnticked = async (page: Page) => {
  const snapshot = await page.locator("body").ariaSnapshot();
  expect(snapshot).toContain('checkbox "seven"');
  expect(snapshot).not.toContain("[checked]");
};

test("a choice step whose submit stays disabled, or whose click a banner catches, unticks every choice before it returns, and a click again fills from the code", async ({
  page,
}) => {
  const stuck = await fillChoices(page, await codeScreen(page, { stuck: true }));
  expect(stuck.report).toMatchObject({ outcome: "filled", submit: "stayed_disabled" });
  await expectUnticked(page);

  await page.unrouteAll();
  const browser = await codeScreen(page, { covered: true });
  const covered = await fillChoices(page, browser);
  expect(covered.report).toMatchObject({ outcome: "filled", submit: "blocked" });
  await expectUnticked(page);
  // The grid holds nothing now, so a click again clicks nothing and the screen is filled again.
  const again = await Effect.runPromise(
    resubmitAutofillStep({ step: choiceStep, inspection: covered.inspection, page: browser }),
  );
  expect(again).toMatchObject({ outcome: "filled", submit: "not_attempted" });
  await expectUnticked(page);
});

test("a grid whose choices are named in more than one word, or that holds a box to remember the device, is no code's choices", async ({
  page,
}) => {
  for (const names of [
    ["hot air balloon", "kite", "seven", "three"],
    ["x-ray", "kite", "seven", "three"],
    ["10", "kite", "seven", "three"],
    ["seven", "three", "kite", "Remember this device"],
  ]) {
    await page.unrouteAll();
    expect(await inspectChoices(await codeScreen(page, { names }))).toMatchObject({
      outcome: "refused",
      reason: "not_editable",
      target: 0,
    });
  }
});

test("a grid of buttons is no code's choices", async ({ page }) => {
  expect(await inspectChoices(await codeScreen(page, { buttons: true }))).toMatchObject({
    outcome: "refused",
    reason: "not_editable",
    target: 0,
  });
});
