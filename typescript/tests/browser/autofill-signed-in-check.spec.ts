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
) => {
  await page.route(/^https:\/\//u, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: new URL(route.request().url()).pathname === "/account" ? body : (frame ?? ""),
    }),
  );
  await page.goto(`${site}/account`);
  return Effect.runPromise(
    checkAutofillSignedIn({
      indicator: { selector: "#identity" },
      page: await hostPage(page),
      siteOrigin: site,
      screens: signIn,
    }),
  );
};

for (const [name, body, frame, failed] of [
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
    expect(await checkPage(page, body, frame, screens)).toEqual(
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
