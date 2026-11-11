import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";
import { screenSubmit } from "../../src/runtime/autofill-state.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in dialog whose own Sign In button does nothing on a click or Enter: the site lays a
// control with the button's own name over it, inside the same form, and only a click on that
// control posts the login, from script. Chromium must lay out the control over the button and
// decide where the click lands.
const site = "https://account.example.test";
const email = "synthetic.member@example.test";
const password = "synthetic-layer-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#email", slot: "email" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};

/**
 * Serves, at /login, the sign-in dialog with its control over Sign In named `layerName`, and at
 * /framed the same page in a frame under a parent overlay that notes a click, and keeps each login
 * the site received.
 */
const serve = async (page: Page, layerName = "Sign In", path = "/login") => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
      await route.fulfill({ contentType: "text/plain", body: "ok" });
    } else if (route.request().url().endsWith("/framed"))
      await route.fulfill({
        contentType: "text/html",
        body: `<iframe src="/login" style="width:600px;height:400px;border:0"></iframe>
<div style="position:fixed;inset:0" onclick="sessionStorage.setItem('overlay', 'clicked')">Accept all</div>`,
      });
    else
      await route.fulfill({
        contentType: "text/html",
        body: `<div role="dialog" aria-label="Sign in" style="position:absolute;top:40px;left:40px">
<form id="sign-in-form">
<label>Email<input id="email" name="email"></label>
<label>Password<input id="password" name="password" type="password"></label>
<input id="robots" name="robots" tabindex="-1" autocomplete="off" style="display:none">
<div style="position:relative;display:inline-block">
<button id="sign-in" type="button">Sign In</button>
<div id="layer" role="button" tabindex="0" aria-label="${layerName}" style="position:absolute;inset:0"></div>
</div></form></div>
<script>document.getElementById("layer").addEventListener("click", async () => {
  const form = document.getElementById("sign-in-form");
  const body = new URLSearchParams({ email: form.elements.email.value, password: form.elements.password.value });
  await fetch("/session", { method: "POST", body });
  document.body.innerHTML = '<p id="account">Signed in</p>';
});</script>`,
      });
  });
  await page.goto(`${site}${path}`);
  return received;
};

const fill = async (page: Page, step: AutofillStep) => {
  const hosted = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: hosted, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  return Effect.runPromise(
    fillAutofillStep({
      step,
      values: [email, password],
      inspection,
      page: hosted,
      keyboard,
      settleMs: 1_000,
    }),
  );
};

test("the site's own Sign In control over the real button is clicked as the submit on the first fill, the recipe records it as version 11, and a fresh browser replays it with one post; a control named otherwise, or a sign-in in a frame, stays blocked", async ({
  page,
  browser,
}) => {
  // The first fill, the control named otherwise and the frame each wait out Playwright's 5 s click
  // timeout.
  test.setTimeout(60_000);
  const received = await serve(page);
  const report = await fill(page, signInStep);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "email", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "clicked",
    via: "click_layer",
  });
  await expect(page.locator("#account")).toBeVisible();
  expect(received).toEqual([{ email, password }]);

  const recipe = signInRecipe(
    [
      {
        page: `${site}/login`,
        fields: signInStep.fields,
        submit: "#sign-in",
        submittedBy: "host",
        submitVia: "click_layer",
      },
    ],
    { selector: "#account" },
  );
  const text = signInRecipeText(recipe);
  const decoded = decodeSignInRecipe(text);
  expect(decoded).toMatchObject({ version: 11, steps: [{ submitVia: "click_layer" }] });
  // No earlier version carries the click layer.
  expect(decodeSignInRecipe(text.replace('"version": 11', '"version": 10'))).toBe("invalid");

  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    const sent = await serve(fresh);
    if (typeof decoded === "string") throw new Error(decoded);
    const replayed = await fill(fresh, { fields: signInStep.fields, ...screenSubmit(decoded.steps[0]!) });
    expect(replayed).toMatchObject({ outcome: "filled", submit: "clicked", via: "click_layer" });
    expect(sent).toEqual([{ email, password }]);
  } finally {
    await context.close();
  }

  const other = await page.context().newPage();
  const none = await serve(other, "Continue");
  expect(await fill(other, signInStep)).toMatchObject({
    outcome: "filled",
    submit: "blocked",
    blockedBy: { tag: "div" },
  });
  expect(none).toEqual([]);

  // In a frame, a parent page's element over the frame would take the click: blocked, unclicked.
  const framed = await page.context().newPage();
  const nothing = await serve(framed, "Sign In", "/framed");
  expect(await fill(framed, signInStep)).toMatchObject({ outcome: "filled", submit: "blocked" });
  expect(nothing).toEqual([]);
  expect(await framed.evaluate(() => sessionStorage.getItem("overlay"))).toBeNull();
});
