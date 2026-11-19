import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { observeSignInState, stateAfter } from "../../src/destinations/sign-in-state-scan.js";
import { fingerprintOf } from "../../src/destinations/sign-in-states.js";
import { hostPage } from "./autofill-host-page.js";

// The sign-in state scan on local Chromium, which decides what shows and runs each cross-origin
// frame in its own process: every visible box on a sign-in origin by the kind its own attributes
// say, and a page with no empty box by its message and buttons, with no name, login, address or
// number left in any text.
const site = "https://login.example.test";
const provider = "https://auth.provider.example.org";
const widget = "https://chat.widget.example.net";

test.use({ launchOptions: { args: ["--site-per-process"] } });

/** Serves each origin's page, opens the site, and gives the host's scan of the tab as it is then. */
const open = async (
  page: Page,
  bodies: Readonly<Record<string, string>>,
  identifiers?: readonly string[],
) => {
  await page.route(/^https:\/\//u, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: bodies[new URL(route.request().url()).origin] ?? "",
    }),
  );
  await page.goto(site);
  const host = await hostPage(page);
  return () =>
    Effect.runPromise(
      observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [provider], identifiers }),
    ).then((state) => {
      if (state === undefined) throw new Error("The scan read nothing");
      return state;
    });
};

test("the scan counts each kind of box, a row of one-character boxes as one code box", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<form action="/session" method="post">
        <input type="email" name="email"><input type="password" name="password">
        <input type="hidden" name="state" value="opaque"><input name="backup" type="email" style="display:none">
        <button>Sign in</button>
      </form>
      <div>${'<span><input inputmode="numeric" maxlength="1"></span>'.repeat(6)}</div>
      <form><input autocomplete="section-profile bday"><input name="postal_code" autocomplete="postal-code" inputmode="numeric" maxlength="5"></form>
      <input type="search" aria-label="Search the help pages">
      <form action="/search"><input name="q"><button>Go</button></form>
      <input name="nickname">`,
  });
  const state = await scan();
  const box = (kind: string, submit: boolean, count?: number) => ({
    frame: site,
    kind,
    ...(count === undefined ? {} : { count }),
    empty: true,
    submit,
  });
  expect(state.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [
        { frame: site, kind: "identifier" },
        { frame: site, kind: "password" },
        { frame: site, kind: "code", count: 6 },
        { frame: site, kind: "date_of_birth" },
        { frame: site, kind: "zip" },
      ],
      submit: true,
    }),
  );
  expect(state.boxes).toHaveLength(5);
  expect(state.boxes).toEqual(
    expect.arrayContaining([
      box("identifier", true),
      box("password", true),
      box("code", false, 6),
      box("date_of_birth", false),
      box("zip", false),
    ]),
  );
});

test("the scan reads a frame on a listed sign-in origin by its origin, and no other site's frame", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<h1>Sign in</h1><iframe src="${provider}/login"></iframe><iframe src="${widget}/chat"></iframe>`,
    [provider]: `<form><input type="password"><button>Continue</button></form><iframe srcdoc="<input autocomplete='one-time-code'>"></iframe>`,
    [widget]: `<form><input type="email"><button>Send</button></form>`,
  });
  expect(page.frames().find((frame) => frame.url().startsWith(widget))).toBeDefined();
  expect((await scan()).fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [
        { frame: provider, kind: "password" },
        { frame: provider, kind: "code" },
      ],
      submit: true,
    }),
  );
});

test("a page with no box reads as its heading and buttons, with no address, number, name or login", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<p>Questions? Call 555 0100</p>
      <h1>Sam, we sent a link to j***@example.test. Check your inbox</h1>
      <p>Not <b>Sam</b>? Start over</p>
      <p>Signed in as sam_smith or j.doe</p>
      <p>not jdoe? or (owner)</p>
      <p>back to jdoe-admin, user:jdoe or j***h</p>
      <p>that code is invalid</p>
      <p>&#x5c71;&#x7530;&#x592a;&#x90ce;&#x69d8;&#x3001;&#x3088;&#x3046;&#x3053;&#x305d;</p>
      <button>Resend in 30 seconds</button>
      <button aria-label="Use another email"><svg width="12" height="12"></svg></button>`,
  }, ["jdoe@example.test", "Owner", "ali"]);
  const state = await scan();
  expect(state.fingerprint).toEqual({
    top: site,
    boxes: [],
    submit: false,
    message: "~, we sent a link to @. ~ your inbox",
    buttons: ["~ another email", "~ in # seconds"],
  });
  expect(state.texts).toEqual([
    "~? ~ # #",
    "~, we sent a link to @. ~ your inbox",
    "~ ~? ~ over",
    "~ in as ~ or ~",
    "not ~? or ~)",
    "back to ~, ~ or ~",
    "that code is invalid",
  ]);
  expect(JSON.stringify(state)).not.toMatch(/sam|smith|doe|owner|555|\u5c71/iu);
});

test("two logins' account pickers that differ only in the names on their chips read alike", async ({
  page,
}) => {
  const picker = (name: string, address: string) => `<h1>Choose an account</h1>
    <button>${name} ${address}</button>
    <button>Continue as ${name.split(" ")[0]}</button>
    <button>Use another account</button>`;
  const first = await (await open(page, { [site]: picker("Sam Smith", "s***@example.test") }))();
  const second = await (await open(page, { [site]: picker("Ana Diaz", "a***@example.test") }))();
  expect(first.fingerprint).toEqual(second.fingerprint);
  expect(first.fingerprint.buttons).toEqual(["~ another account", "~ as ~", "~ ~ @"]);
});

test("a notice after a press beside the same boxes tells the state, and a typed box is no longer empty", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<h1>Welcome back</h1>
      <form id="sign-in">
        <label>Email <input type="email" name="email"></label>
        <label>Password <input type="password" name="password"></label>
      </form>
      <footer><button form="sign-in">Sign in</button></footer>
      <script>
        document.getElementById("sign-in").addEventListener("submit", (event) => {
          event.preventDefault();
          const notice = document.createElement("p");
          notice.textContent = "That password is not right. Try again in 5 minutes";
          document.body.append(notice);
        });
      </script>`,
  });
  const identifier = { frame: site, kind: "identifier" as const };
  const password = { frame: site, kind: "password" as const };
  const boxes = [identifier, password];
  const before = await scan();
  expect(before.fingerprint).toEqual(fingerprintOf({ top: site, boxes, submit: true }));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That password is not right")).toBeVisible();
  const after = await scan();
  expect(after.fingerprint).toEqual(before.fingerprint);
  expect(stateAfter(before, after)).toEqual(
    fingerprintOf({
      top: site,
      boxes,
      submit: true,
      message: "~ password is not right. ~ again in # minutes",
    }),
  );
  await page.locator("input[name=email]").pressSequentially("sam@example.test");
  const typed = await scan();
  expect(typed.boxes).toEqual([
    { ...identifier, empty: false, submit: true },
    { ...password, empty: true, submit: true },
  ]);
  expect(typed.fingerprint).toEqual(fingerprintOf({ top: site, boxes: [password], submit: true }));
  expect(JSON.stringify(typed)).not.toContain("sam@");
});
