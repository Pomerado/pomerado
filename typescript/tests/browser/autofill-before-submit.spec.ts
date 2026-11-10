import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A host may hold a sign-in's submit once every field holds its value, before its first click
// (`beforeSubmit`). Chromium must run the page's own input, click and submit handlers, and the
// navigation of a form that submits itself.
const site = "https://member.example.test";
const username = "synthetic-owner";
const password = "synthetic-held-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const filled = [
  { slot: "username", status: "filled" },
  { slot: "password", status: "filled" },
];

/**
 * A sign-in form posting to /session, with `controls` after its fields and `script` after it. The
 * page notes each submit event and each click of its button, kept across the form's navigation.
 */
const login = (script = "", controls = '<button id="sign-in">Sign in</button>') =>
  `<form action="/session" method="post">
<label>Username<input id="username" name="username"></label>
<label>Password<input id="password" name="password" type="password"></label>
${controls}</form>
<script>
const form = document.forms[0];
form.addEventListener("submit", () => sessionStorage.setItem("submitted", "yes"));
document.getElementById("sign-in")?.addEventListener("click", () => sessionStorage.setItem("clicked", "yes"));
${script}</script>`;

/** Serves `screen` at /login and keeps each form the site received. */
const serve = async (page: Page, screen: string) => {
  const received: Record<string, string>[] = [];
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else await route.fulfill({ contentType: "text/html", body: screen });
  });
  await page.goto(`${site}/login`);
  return received;
};

type Typed = { readonly document: number | undefined };

/** A host's `beforeSubmit` that keeps the document each run got, then does `then`. */
const holding = (then: Effect.Effect<void, Error> = Effect.void) => {
  const runs: (number | undefined)[] = [];
  return {
    runs,
    beforeSubmit: (typed: Typed) =>
      Effect.suspend(() => {
        runs.push(typed.document);
        return then;
      }),
  };
};

/** The host's inspection of `step`, then its fill with `values`, holding its submit by `hold`. */
const fill = async (
  page: Page,
  step: AutofillStep,
  values: readonly string[],
  hold: (typed: Typed) => Effect.Effect<void, Error>,
) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
      beforeSubmit: hold,
    }),
  );
  return { report, host };
};

/** What the page noted: a submit event, and a click of its button. */
const noted = (page: Page) =>
  page.evaluate(() => ({
    submitted: sessionStorage.getItem("submitted"),
    clicked: sessionStorage.getItem("clicked"),
  }));

/** When the page's document began loading, as the host's calls read it. */
const documentStart = (page: Page) => page.evaluate(() => performance.timeOrigin);

test("beforeSubmit runs once every field holds its value and before anything submits, with the document typed in; then the host clicks once", async ({
  page,
}) => {
  const received = await serve(page, login());
  const typedIn = await documentStart(page);
  const seen: unknown[] = [];
  const { report } = await fill(page, signInStep, [username, password], (typed) =>
    Effect.promise(async () => {
      seen.push({
        document: typed.document,
        username: (await page.locator("#username").inputValue()).length,
        password: (await page.locator("#password").inputValue()).length,
        ...(await noted(page)),
      });
    }),
  );
  expect(seen).toEqual([
    {
      document: typedIn,
      username: username.length,
      password: password.length,
      submitted: null,
      clicked: null,
    },
  ]);
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "clicked" });
  expect(received).toEqual([{ username, password }]);
});

test("a beforeSubmit that fails holds the submit: nothing is clicked or sent, the fields keep what was typed, and the submit is refused with the failure's detail", async ({
  page,
}) => {
  const received = await serve(page, login());
  const held = holding(Effect.fail(new Error("Held by the host")));
  const { report, host } = await fill(page, signInStep, [username, password], held.beforeSubmit);
  expect(held.runs).toHaveLength(1);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "refused",
    typed: true,
    failureDetail: { subCause: "autofill_step_failed", operation: "autofill.before_submit" },
  });
  expect(report).not.toHaveProperty("clicked");
  expect(received).toEqual([]);
  expect(await noted(page)).toEqual({ submitted: null, clicked: null });
  expect(await page.locator("#username").inputValue()).toBe(username);
  expect((await page.locator("#password").inputValue()).length).toBe(password.length);
  expectNotCarried(host.calls, password);
});

test("a form that submits itself on its last input while beforeSubmit fails is reported sent by the page, and never clicked", async ({
  page,
}) => {
  const received = await serve(
    page,
    login('document.getElementById("password").addEventListener("input", () => form.requestSubmit(), { once: true });'),
  );
  const typedIn = await documentStart(page);
  // As a host's hold that finds the page it holds replaced: it fails once the next page loaded.
  const held = holding(
    Effect.promise(() => page.locator("#account").waitFor()).pipe(
      Effect.zipRight(Effect.fail(new Error("Page replaced after typing"))),
    ),
  );
  const { report } = await fill(page, signInStep, [username, password], held.beforeSubmit);
  expect(held.runs).toEqual([typedIn]);
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "page", typed: true });
  expect(report).not.toHaveProperty("clicked");
  expect(report).not.toHaveProperty("failureDetail");
  expect(received).toEqual([{ username, password }]);
  expect(await noted(page)).toEqual({ submitted: "yes", clicked: null });
});

test("beforeSubmit never runs for a step with only a submit key", async ({ page }) => {
  // A code form with one field and no submit control, which Enter in that field submits.
  const code = "246810";
  const enterStep: AutofillStep = {
    fields: [{ selector: "#code", slot: "code" }],
    submitKey: "Enter",
  };
  const received = await serve(
    page,
    '<form method="post" action="/session"><label>Code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label></form>',
  );
  const byKey = holding();
  const { report } = await fill(page, enterStep, [code], byKey.beforeSubmit);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(received).toEqual([{ code }]);
  expect(byKey.runs).toEqual([]);
});

test("beforeSubmit never runs for a step with no submit", async ({ page }) => {
  const received = await serve(page, login());
  const held = holding();
  const { report } = await fill(
    page,
    { fields: signInStep.fields },
    [username, password],
    held.beforeSubmit,
  );
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "none" });
  expect(received).toEqual([]);
  expect(held.runs).toEqual([]);
});

test("beforeSubmit never runs for a fill that stopped before its submit", async ({ page }) => {
  // The page empties the username as it takes it, so the password's call finds it empty.
  const received = await serve(
    page,
    login('document.getElementById("username").addEventListener("input", (event) => { event.target.value = ""; }, { once: true });'),
  );
  const held = holding();
  const { report } = await fill(page, signInStep, [username, password], held.beforeSubmit);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "failed" },
      { slot: "password", status: "not_attempted" },
    ],
    submit: "not_attempted",
  });
  expect(held.runs).toEqual([]);
  expect(received).toEqual([]);
});

test("a submit the page enables only on key presses is typed again by keys and clicked, with beforeSubmit run once, before the first submit call", async ({
  page,
}) => {
  // Over 3 s: the host waits its fixed 5 s for a disabled submit (`submitEnableMs`), which no
  // input sets, before it types every field again by keys.
  const received = await serve(
    page,
    login(
      'document.getElementById("password").addEventListener("keyup", () => { document.getElementById("sign-in").disabled = false; });',
      '<button id="sign-in" disabled>Sign in</button>',
    ),
  );
  const held = holding();
  const { report } = await fill(page, signInStep, [username, password], held.beforeSubmit);
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "clicked" });
  expect(held.runs).toHaveLength(1);
  expect(received).toEqual([{ username, password }]);
});

/** A notice over the whole page, whose Accept takes it away. */
const showNotice = `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(
  '<div id="notice" role="dialog" aria-label="Cookie notice" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"><button id="accept" type="button">Accept</button></div>',
)});
document.getElementById("accept").addEventListener("click", () => document.getElementById("notice").remove());`;
const dismissed: AutofillStep = { ...signInStep, dismiss: "#accept" };

test("a click a notice drawn after typing catches is dismissed and clicked again, with beforeSubmit run once, before the first click", async ({
  page,
}) => {
  // Over 3 s: Playwright's click of the covered submit retries for its fixed 5 s, the page code's
  // own click timeout, before it names the notice.
  const received = await serve(
    page,
    login(
      `document.getElementById("password").addEventListener("input", () => { ${showNotice} }, { once: true });`,
    ),
  );
  const held = holding();
  const { report } = await fill(page, dismissed, [username, password], held.beforeSubmit);
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "clicked" });
  expect(held.runs).toHaveLength(1);
  expect(received).toEqual([{ username, password }]);
});

test("a click again of a blocked screen never runs beforeSubmit, even when its host passes one", async ({
  page,
}) => {
  // The screen a fill reported blocked: the fields hold what was typed, under a notice.
  const received = await serve(page, login(showNotice));
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: dismissed, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const held = holding();
  // The same input a host gives its fill, `beforeSubmit` included.
  const input = {
    step: dismissed,
    inspection,
    page: host,
    settleMs: 500,
    beforeSubmit: held.beforeSubmit,
  };
  const report = await Effect.runPromise(resubmitAutofillStep(input));
  expect(report).toMatchObject({ outcome: "filled", fields: filled, submit: "clicked" });
  expect(held.runs).toEqual([]);
  expect(received).toEqual([{ username, password }]);
});
