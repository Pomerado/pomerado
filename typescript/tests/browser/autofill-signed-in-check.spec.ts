import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  checkAutofillSignedIn,
  type AutofillScreens,
} from "../../src/destinations/autofill-step.js";
import { hostPage } from "./autofill-host-page.js";

// The host's check that an autofill sign-in shows the site signed in, on local Chromium,
// which decides what shows. A password field still showing fails it only when it belongs to the
// sign-in's own screens: one of their fields, or in the form of one of them that shows. Another
// form's password field on the signed-in page does not count unless a recorded selector matches
// in it.
const site = "https://bank.example.test";
const widget = "https://vault.widget.example.net";
const marker = '<p id="identity">Signed in</p>';

/** The sign-in's screens as its recipe records them: the identifier, then the password. */
const screens = [
  { fields: [{ selector: "input[name=username]" }] },
  { fields: [{ selector: "#password" }] },
];

/** Serves the signed-in page, and `frame` at any other path, then runs the host's check on it. */
const checkPage = async (
  page: Page,
  body: string,
  frame: string | null,
  signIn: AutofillScreens,
  path = "/account",
) => {
  await page.route(/^https:\/\//u, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: new URL(route.request().url()).pathname === path ? body : (frame ?? ""),
    }),
  );
  await page.goto(`${site}${path}`);
  return Effect.runPromise(
    checkAutofillSignedIn({
      indicator: { selector: "#identity" },
      page: await hostPage(page),
      siteOrigin: site,
      screens: signIn,
    }),
  );
};

for (const [name, body, frame, failed, signIn] of [
  [
    "the identity marker inside an unfinished security-answer form",
    `<form><p id="identity">Signed in</p><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, { fields: [{ selector: "input[name=securityAnswer]", slot: "private_answer" }] }],
  ],
  [
    "a header marker outside an unfinished security-answer form",
    `${marker}<form><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, { fields: [{ selector: "input[name=securityAnswer]", slot: "private_answer" }] }],
  ],
  [
    "a header marker outside an unfinished verification-code form",
    `${marker}<form><label>Verification code<input name="verificationCode" required></label><button>Verify</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, { fields: [{ selector: "input[name=verificationCode]", slot: "code" }] }],
  ],
  [
    "an account search form that shares the page path",
    `${marker}<form method="get"><label>Search<input name="search"></label><button>Search</button></form>`,
    null,
    undefined,
  ],
  [
    "another form's password field, such as a change-password form",
    `${marker}<form action="/account/password" method="post"><label>Current password<input type="password" name="current"></label><label>New password<input type="password" name="new"></label><button>Change password</button></form>`,
    null,
    undefined,
  ],
  [
    "a change-password form that holds a hidden username matching the sign-in's field",
    `${marker}<form action="/account/password" method="post"><input name="username" autocomplete="username" hidden><label>New password<input type="password" name="new"></label><button>Change password</button></form>`,
    null,
    undefined,
  ],
  [
    "an inner service's own login in another site's frame",
    `${marker}<iframe src="${widget}/login"></iframe>`,
    `<form action="/session" method="post"><label>Vault user<input name="vault_user"></label><label>Vault password<input type="password" name="vault_password"></label><button>Open vault</button></form>`,
    undefined,
  ],
  [
    "the sign-in's own password field",
    `${marker}<form action="/session" method="post"><label>Password<input id="password" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
  [
    "a password field in the same form as the sign-in's identifier field",
    `${marker}<form action="/session" method="post"><label>Username<input name="username"></label><label>Password<input id="pass" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
  [
    "the sign-in's own password field in its sign-in frame",
    `${marker}<iframe src="${site}/login-frame"></iframe>`,
    `<form action="/session" method="post"><label>Password<input id="password" type="password"></label><button>Sign in</button></form>`,
    "password_field_visible",
  ],
  [
    "a password field in the form the sign-in's identifier field joins by its form attribute",
    `${marker}<label>Username<input name="username" form="login"></label><form id="login" action="/session" method="post"><label>Password<input id="pass" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
] as const)
  test(`the signed-in check with ${name}`, async ({ page }) => {
    expect(await checkPage(page, body, frame, signIn ?? screens)).toEqual(
      failed === undefined
        ? { signedIn: true, url: `${site}/account` }
        : { signedIn: false, failed, url: `${site}/account` },
    );
  });

test("the signed-in check with no sign-in field to go by counts any password field", async ({
  page,
}) => {
  const changePassword = `${marker}<form action="/account/password" method="post"><label>New password<input type="password" name="new"></label><button>Change password</button></form>`;
  expect(await checkPage(page, changePassword, null, [{ fields: [] }])).toEqual({
    signedIn: false,
    failed: "password_field_visible",
    url: `${site}/account`,
  });
});

test("an account search form containing the signed-in marker does not look like unfinished authentication", async ({ page }) => {
  const account = '<form action="/account/search"><p id="identity">Signed in</p><label>Search<input name="search"></label><button>Search</button></form>';
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an unrelated support question on the account page does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<form action="/support"><label>Support question<textarea name="question" required></textarea></label><button>Send</button></form>`;
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an unrelated security settings form on the account page does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<form action="/account/security"><label>Security answer<input name="securityAnswer" required></label><button>Update</button></form>`;
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an account page below an auth URL prefix still accepts an unrelated security form", async ({ page }) => {
  const account = `${marker}<form action="/auth/account/security"><label>Security answer<input name="securityAnswer" required></label><button>Update</button></form>`;
  expect(await checkPage(page, account, null, screens, "/auth/account")).toEqual({
    signedIn: true,
    url: `${site}/auth/account`,
  });
});

test("an auth-named route does not classify an unrecorded account form as a challenge", async ({ page }) => {
  const challenge = `${marker}<form><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`;
  expect(await checkPage(page, challenge, null, screens, "/security-question")).toEqual({
    signedIn: true,
    url: `${site}/security-question`,
  });
});

test("a visible contenteditable security answer remains an unfinished challenge", async ({ page }) => {
  const account = `${marker}<form><div contenteditable="true" aria-label="Security answer"></div><button>Continue</button></form>`;
  expect(await checkPage(page, account, null, [...screens, { fields: [{ selector: '[contenteditable="true"]', slot: "private_answer" }] }])).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

test("a recorded challenge field associated with its form by form attribute remains unfinished", async ({ page }) => {
  const account = `${marker}<form id="challenge"><button>Continue</button></form><label>Security answer<input id="answer" name="securityAnswer" form="challenge" required></label>`;
  expect(await checkPage(page, account, null, [...screens, { fields: [{ selector: "#answer", slot: "private_answer" }] }])).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

test("a recorded challenge field in a visible provider iframe remains unfinished", async ({ page }) => {
  const account = `${marker}<iframe src="${widget}/security-question"></iframe>`;
  const challenge = '<form><label>Security answer<input id="challenge-answer" name="securityAnswer" required></label><button>Continue</button></form>';
  expect(await checkPage(page, account, challenge, [...screens, { fields: [{ selector: "#challenge-answer", slot: "private_answer" }] }])).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

test("a challenge field in a hidden provider iframe does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<iframe style="display:none" src="${widget}/security-question"></iframe>`;
  const challenge = '<form><label>Security answer<input id="challenge-answer" name="securityAnswer" required></label><button>Continue</button></form>';
  expect(await checkPage(page, account, challenge, [...screens, { fields: [{ selector: "#challenge-answer", slot: "private_answer" }] }])).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});
