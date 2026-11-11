import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";
import { screenSubmit } from "../../src/runtime/autofill-state.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A fixed footer that sits over a sign-in form's Log In button catches the host's click, and has
// no control of its own to dismiss. Chromium must lay out the footer over the button at the
// default viewport and decide where the click lands.
const site = "https://member.example.test";
const username = "synthetic-owner";
const password = "synthetic-footer-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#log-in",
};

/**
 * Serves, at /login, a sign-in form at the foot of a page that does not scroll, under a fixed
 * footer that notes any click on it, and keeps each form the site received.
 */
const serve = async (page: Page, script = "") => {
  const received: Record<string, string>[] = [];
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<body style="margin:0;height:100vh;overflow:hidden">
<form action="/session" method="post" style="position:absolute;bottom:20px;left:20px">
<label>Username<input id="username" name="username"></label>
<label>Password<input id="password" name="password" type="password"></label>
<button id="log-in">Log In</button></form>
<footer id="footer" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">Help and terms</footer>
<script>document.getElementById("footer").addEventListener("click", () => sessionStorage.setItem("footer", "clicked"));
${script}</script></body>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

const inspect = async (page: Page) => {
  const hosted = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: signInStep, page: hosted, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  return { hosted, inspection };
};

const fill = async (page: Page) => {
  const { hosted, inspection } = await inspect(page);
  const { keyboard } = await hostKeyboard(page);
  return Effect.runPromise(
    fillAutofillStep({
      step: signInStep,
      values: [username, password],
      inspection,
      page: hosted,
      keyboard,
      settleMs: 1_000,
    }),
  );
};

/** The host's click again of the blocked screen, sent again unchanged, typing nothing. */
const clickAgain = async (page: Page) => {
  const { hosted, inspection } = await inspect(page);
  return Effect.runPromise(
    resubmitAutofillStep({ step: signInStep, inspection, page: hosted, settleMs: 1_000 }),
  );
};

const filled = [
  { slot: "username", status: "filled" },
  { slot: "password", status: "filled" },
];

test("a fixed footer over Log In catches the host's click: the fill reports it blocked by the footer, and the screen sent again presses that same Log In from the keyboard and signs in, clicking nothing on the footer; a Log In that focus never lands on stays blocked", async ({
  page,
}) => {
  // Four clicks the footer catches, each through Playwright's full 5 s click timeout.
  test.setTimeout(60_000);
  const received = await serve(page);
  expect(await fill(page)).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "blocked",
    blockedBy: { tag: "footer", role: null },
  });
  expect(received).toEqual([]);
  expect(await clickAgain(page)).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "clicked",
    via: "keyboard",
  });
  expect(received).toEqual([{ username, password }]);
  expect(await page.evaluate(() => sessionStorage.getItem("footer"))).toBeNull();

  // The same page, whose Log In gives the focus up as soon as it takes it.
  const unfocused = await page.context().newPage();
  const sent = await serve(
    unfocused,
    'document.getElementById("log-in").addEventListener("focus", (event) => event.target.blur());',
  );
  expect(await fill(unfocused)).toMatchObject({ outcome: "filled", submit: "blocked" });
  expect(await clickAgain(unfocused)).toMatchObject({
    outcome: "filled",
    submit: "blocked",
    blockedBy: { tag: "footer", role: null },
  });
  expect(sent).toEqual([]);
  expect(await unfocused.evaluate(() => sessionStorage.getItem("footer"))).toBeNull();
});

test("an empty overlay beside a modal dialog in one portal catches the host's click: the fill reports a dialog with the dialog's own controls, its icon-only close among them", async ({
  page,
}) => {
  const received = await serve(
    page,
    `document.body.insertAdjacentHTML("beforeend", '<span><div data-state="open" style="position:fixed;inset:0;z-index:10"></div>'
+ '<div data-state="open" role="dialog" aria-modal="true" tabindex="-1" style="position:fixed;top:20px;left:20px;z-index:11;background:#fff">'
+ '<button type="button"><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" width="16" height="16"></button>'
+ '<div>Join to see more</div><button type="button">Create Account</button><div>Already have an account? <span>Sign in</span></div></div></span>');`,
  );
  expect(await fill(page)).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "blocked",
    blockedBy: {
      tag: "span",
      role: "dialog",
      controls: [
        { role: "button", name: "", iconOnly: true },
        { role: "button", name: "Create Account" },
      ],
    },
  });
  expect(received).toEqual([]);
});

test("an email field's own suggestion list, opened by typing, covers Continue: the fill closes it with Escape in the field and clicks Continue once, the recipe records closeFieldList as version 15, and a fresh browser replays it; a banner over Continue that Escape leaves open stays blocked", async ({
  page,
  browser,
}) => {
  // The first fill and the banner's each wait out Playwright's 5 s click timeout once.
  test.setTimeout(30_000);
  const email = "synthetic.member@example.test";
  const step: AutofillStep = { fields: [{ selector: "#email", slot: "email" }], submit: "#continue" };
  // An unlabelled list, drawn right under the field on input and closed by Escape, over Continue.
  const open = async (target: Page, script = "") => {
    const received: string[] = [];
    await target.route(`${site}/**`, async (route) => {
      if (route.request().method() === "POST") {
        received.push(route.request().postData() ?? "");
        await route.fulfill({ contentType: "text/html", body: '<p id="password-screen">Password</p>' });
      } else
        await route.fulfill({
          contentType: "text/html",
          body: `<form action="/identify" method="post"><div style="position:relative">
<label>Email<input id="email" name="email" autocomplete="off"></label>
<div id="list" hidden style="position:absolute;top:100%;left:0;width:320px;height:120px;background:#fff"><div>${email}</div></div></div>
<button id="continue">Continue</button></form>
<script>const field = document.getElementById("email");
const list = document.getElementById("list");
const show = (shown) => { list.hidden = !shown; field.setAttribute("aria-expanded", String(shown)); };
field.addEventListener("input", () => show(true));
field.addEventListener("keydown", (event) => { if (event.key === "Escape") show(false); });
${script}</script>`,
        });
    });
    await target.goto(`${site}/login`);
    return received;
  };
  const run = async (target: Page, at: AutofillStep) => {
    const hosted = await hostPage(target);
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step: at, page: hosted, siteOrigin: site, authenticationOrigins: [] }),
    );
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    const { keyboard } = await hostKeyboard(target);
    return Effect.runPromise(
      fillAutofillStep({ step: at, values: [email], inspection, page: hosted, keyboard, settleMs: 1_000 }),
    );
  };
  const received = await open(page);
  expect(await run(page, step)).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "email", status: "filled" }],
    submit: "clicked",
    via: "closed_field_list",
  });
  await expect(page.locator("#password-screen")).toBeVisible();
  expect(received).toEqual([new URLSearchParams({ email }).toString()]);
  // A banner over Continue, which Escape leaves open, is no closed list: the fill stays blocked.
  const bannered = await page.context().newPage();
  const unsent = await open(
    bannered,
    `document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;top:32px;left:0;right:0;height:60px;z-index:1;background:#eee"><button type="button">Accept</button></div>');`,
  );
  expect(await run(bannered, step)).toMatchObject({ outcome: "filled", submit: "blocked", blockedBy: { tag: "div" } });
  expect(unsent).toEqual([]);

  const text = signInRecipeText(
    signInRecipe(
      [
        {
          page: `${site}/login`,
          fields: step.fields,
          submit: "#continue",
          submittedBy: "host",
          closeFieldList: true,
        },
      ],
      { selector: "#password-screen" },
    ),
  );
  const decoded = decodeSignInRecipe(text);
  expect(decoded).toMatchObject({ version: 15, steps: [{ closeFieldList: true }] });
  // No earlier version carries the flag.
  expect(decodeSignInRecipe(text.replace('"version": 15', '"version": 14'))).toBe("invalid");
  if (typeof decoded === "string") throw new Error(decoded);
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    const sent = await open(fresh);
    expect(
      await run(fresh, { fields: step.fields, ...screenSubmit(decoded.steps[0]!) }),
    ).toMatchObject({ outcome: "filled", submit: "clicked", via: "closed_field_list" });
    expect(sent).toHaveLength(1);
  } finally {
    await context.close();
  }
});
