import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { type AutofillStep, inspectAutofillStep } from "../../src/destinations/autofill-step.js";
import { observeSignInState, stateAfter } from "../../src/destinations/sign-in-state-scan.js";
import {
  type BoxTakes,
  fingerprintOf,
  noteSignInState,
  observedSignInOf,
  sameFingerprint,
  type StateBox,
  toldApart,
} from "../../src/destinations/sign-in-states.js";
import { codeRowFields, isCodeRowByPlace } from "../../src/runtime/autofill-unrecorded-code.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

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
  dismiss?: readonly string[],
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
      observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [provider], identifiers, dismiss }),
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
    ...(count === undefined ? {} : { count, role: "textbox" }),
    ...(kind === "identifier" ? { takes: "email" } : {}),
    empty: true,
    submit,
  });
  expect(state.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [
        { frame: site, kind: "identifier", takes: "email" },
        { frame: site, kind: "password" },
        { frame: site, kind: "code", count: 6, role: "textbox" },
        { frame: site, kind: "date_of_birth" },
        { frame: site, kind: "zip" },
      ],
      submit: true,
      ways: ["~ in", "~"],
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
        { frame: provider, kind: "code", role: "textbox" },
      ],
      submit: true,
      ways: ["~"],
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
  const identifier = { frame: site, kind: "identifier" as const, takes: "email" as const };
  const password = { frame: site, kind: "password" as const };
  const boxes = [identifier, password];
  const told = { instruction: "~ back", ways: ["~ in"] };
  const before = await scan();
  expect(before.fingerprint).toEqual(fingerprintOf({ top: site, boxes, submit: true, ...told }));
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
  expect(typed.fingerprint).toEqual(fingerprintOf({ top: site, boxes: [password], submit: true, ...told }));
  expect(JSON.stringify(typed)).not.toContain("sam@");
});

test("an identifier box says whether it takes an email, a phone or either, and a page with boxes keeps its instruction and ways, value-free", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<h1>Welcome back, Sam</h1>
      <form action="/session" method="post">
        <input type="email" name="first">
        <input type="tel" aria-label="Phone number">
        <label>Email or mobile number <input name="second"></label>
        <input autocomplete="username" name="third">
        <input type="tel" name="member" placeholder="Member number">
        <span id="spoken">N&uacute;mero de tel&eacute;fono</span><input aria-labelledby="spoken" name="fourth">
        <input name="username-mobile" id="username-mobile" placeholder="Username">
        <button>Continue</button>
      </form>
      <a href="/password">Use password instead</a>
      <button type="button">Text a code to 555 0100</button>`,
  }, ["sam@example.test"]);
  const state = await scan();
  const identifier = (takes: BoxTakes) => ({ frame: site, kind: "identifier" as const, takes });
  expect(state.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: (["email", "phone", "email_or_phone", "other", "phone", "phone", "other"] as const).map(identifier),
      submit: true,
      instruction: "~ back, ~",
      ways: ["~", "~ password instead", "~ a code to # #"],
    }),
  );
  expect(JSON.stringify(state)).not.toMatch(/sam|555/iu);
  // A phone box in place of the email box after a press is a new look, with what its box takes now,
  // and an email box again is the same state.
  await open(page, { [site]: `<form><input type="email" name="login"><button>Continue</button></form>` });
  const host = await hostPage(page);
  const read = () =>
    Effect.runPromise(observeSignInState({ page: host, siteOrigin: site, authenticationOrigins: [] })).then((read) => {
      if (read === undefined) throw new Error("The scan read nothing");
      return read;
    });
  const email = await read();
  await page.evaluate(() => {
    const box = document.querySelector("input");
    box?.setAttribute("type", "tel");
    box?.setAttribute("aria-label", "Mobile number");
  });
  const phone = await read();
  expect(stateAfter(email, phone)).toEqual(fingerprintOf({ top: site, boxes: [identifier("phone")], submit: true }));
  expect(sameFingerprint(phone.fingerprint, email.fingerprint)).toBe(false);
  await page.evaluate(() => {
    const box = document.querySelector("input");
    box?.setAttribute("type", "email");
    box?.removeAttribute("aria-label");
  });
  expect(stateAfter(email, await read())).toEqual(fingerprintOf({ top: site, boxes: [identifier("email")], submit: true }));
});

test("two code rows alike but for their boxes' role and labels read as two looks; a row by place finds the second in its frame, never a box past it nor a row a code never goes in, and a step a minter records types it", async ({
  page,
}) => {
  const row = (type: string, first: number, before = "") => ({
    [site]: `<h1>Sign in</h1><iframe src="${provider}/verify"></iframe>`,
    [provider]: `<form>${before}${Array.from(
      { length: 6 },
      (_, at) =>
        `<div><div><input type="${type}" aria-label="${first + at}" autocomplete="one-time-code" inputmode="numeric"></div></div>`,
    ).join("")}<button type="button">Sign In</button></form>`,
  });
  const look = (role: string, first: number) =>
    fingerprintOf({
      top: site,
      boxes: Array.from({ length: 6 }, (_, at) => ({ frame: provider, kind: "code" as const, role, label: String(first + at) })),
      submit: false,
      ways: ["~ ~"],
    });
  const inspect = async (step: AutofillStep, authenticationOrigins = [provider]) =>
    Effect.runPromise(inspectAutofillStep({ step, page: await hostPage(page), siteOrigin: site, authenticationOrigins }));
  const text = await (await open(page, row("text", 1)))();
  expect(text.fingerprint).toEqual(look("textbox", 1));
  const number = await (await open(page, row("number", 0)))();
  expect(number.fingerprint).toEqual(look("spinbutton", 0));
  expect(sameFingerprint(text.fingerprint, number.fingerprint)).toBe(false);
  // The row by place, as a replay types a look-alike code screen whose recorded boxes never show,
  // with no box at the place after it.
  const byPlace = await inspect({ fields: codeRowFields(6, false) });
  expect("outcome" in byPlace ? byPlace : isCodeRowByPlace(byPlace.screen.fields, 6, false)).toBe(true);
  expect(await inspect({ fields: codeRowFields(7, false).slice(6) })).toMatchObject({ reason: "not_found" });
  // A transparent box before the row, which the look leaves out, is found at the place after it.
  const transparent = '<input autocomplete="one-time-code" style="opacity:0">';
  expect((await (await open(page, row("number", 0, transparent)))()).fingerprint).toEqual(look("spinbutton", 0));
  expect(await inspect({ fields: codeRowFields(7, false).slice(6) })).not.toHaveProperty("outcome");
  // A row of one-character boxes by place is each next box of as many, unless its boxes are a
  // birth date's, a social security number's or a PIN's, by their attributes or by their labels.
  const labelled = (label: (at: number) => string, hidden = "") => (at: number) =>
    `<label for="b${at}"${hidden}>${label(at)}</label><input id="b${at}" inputmode="numeric" maxlength="1">`;
  const attributed = (attributes: (at: number) => string) => (at: number) => `<input ${attributes(at)} maxlength="1">`;
  const rows = [
    attributed(() => 'inputmode="numeric"'),
    ...[
      'autocomplete="bday-day"',
      'autocomplete="section-signup bday-day"',
      'name="ssn-last4"',
      'type="password"',
      'aria-label="PIN digit"',
      'aria-label="PIN: digit"',
    ].map((attributes) => attributed(() => attributes)),
    labelled((at) => `PIN digit ${at + 1}`),
    labelled((at) => `PIN ${at + 1}`, " hidden"),
    labelled((at) => `Date of birth ${at + 1}`),
    attributed((at) => `aria-label="PIN-${at + 1}"`),
    attributed((at) => `aria-label="Enter PIN, digit ${at + 1}"`),
    attributed((at) => `placeholder="${["Month", "Month", "Day", "Day", "Year", "Year"][at] ?? ""}"`),
    attributed((at) => `placeholder="${"MMDDYY".charAt(at)}"`),
  ];
  const taken: boolean[] = [];
  for (const box of rows) {
    await open(page, { [site]: `<form>${Array.from({ length: 6 }, (_, at) => `<span>${box(at)}</span>`).join("")}</form>` });
    const counted = await inspect({ fields: codeRowFields(6, true) }, []);
    taken.push(!("outcome" in counted) && isCodeRowByPlace(counted.screen.fields, 6, true));
  }
  expect(taken).toEqual(rows.map((_, at) => at === 0));
  // The step a minter records on the second screen types it, and is noted with the look it was
  // taken in, as a build or repair notes it.
  await open(page, row("number", 0));
  const recorded = {
    page: `${provider}/verify`,
    fields: Array.from({ length: 6 }, (_, at) => ({ selector: `role=spinbutton[name="${at}"]`, slot: "code" as const })),
  } satisfies AutofillRecipeStep;
  const inspection = await inspect(recorded);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const code = "482913";
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: recorded,
      values: [...code],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({ outcome: "filled" });
  const boxes = page.frames().find((frame) => frame.url().startsWith(provider))?.locator("input");
  expect(await boxes?.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual([...code]);
  const signIn = { steps: [{ ...recorded }] };
  noteSignInState(signIn, number);
  expect(observedSignInOf(signIn.steps, { steps: [recorded], signedIn: { selector: "#account" } })).toMatchObject({
    states: [{ fingerprint: look("spinbutton", 0), step: recorded }],
  });
});

test("code boxes told by the rule a fill reads a row by, or by a name, read as code boxes, and still match a look that read them one by one", async ({
  page,
}) => {
  const verify = (boxes: string) =>
    `<h1>Enter the code</h1><form action="/verify" method="post">${boxes}<button>Verify</button></form>`;
  const six = (box: (at: number) => string) => Array.from({ length: 6 }, (_, at) => box(at)).join("");
  const digit = '<input inputmode="numeric" maxlength="1">';
  const pages = {
    // Each box in a wrapper beside a caret, three and three, and boxes the page's script holds to one digit.
    separated: six(() => `<span>${digit}<span class="caret"></span></span>`),
    split: `<div>${digit.repeat(3)}</div><span>-</span><div>${digit.repeat(3)}</div>`,
    script: `<div>${six(() => '<input inputmode="numeric" style="width:2em">')}</div>`,
    marked: six(() => '<span><input autocomplete="one-time-code" maxlength="1"><span class="caret"></span></span>'),
    named: '<input type="text" name="code">',
    // Boxes the page switches on in turn, each once the one before it holds a digit.
    switched: `<div>${digit}${'<input inputmode="numeric" maxlength="1" disabled>'.repeat(5)}</div>`,
  };
  const read: Record<string, readonly StateBox[]> = {};
  for (const [name, boxes] of Object.entries(pages))
    read[name] = (await (await open(page, { [site]: verify(boxes) }))()).fingerprint.boxes;
  const row = { frame: site, kind: "code" as const, count: 6, role: "textbox" };
  expect(read).toEqual({
    separated: [{ ...row, takes: "other" }],
    split: [{ ...row, takes: "other" }],
    script: [{ ...row, takes: "other" }],
    marked: [row],
    named: [{ frame: site, kind: "code", role: "textbox", takes: "other" }],
    switched: [{ ...row, takes: "other" }],
  });
  // A look read before, with each box one by one or a box named for a code as an identifier box,
  // matches each page's look now; a page with one box that takes a name never matches a row.
  const before = (boxes: readonly StateBox[]) => fingerprintOf({ top: site, boxes, submit: true });
  const identifiers = (count: number) => Array.from({ length: count }, () => ({ frame: site, kind: "identifier" as const, takes: "other" as const }));
  const now = (name: string) => before(read[name] ?? []);
  for (const name of ["separated", "split", "script"]) {
    expect(sameFingerprint(before(identifiers(6)), now(name))).toBe(true);
    expect(sameFingerprint(before(identifiers(1)), now(name))).toBe(false);
  }
  expect(sameFingerprint(before(Array.from({ length: 6 }, () => ({ frame: site, kind: "code" as const }))), now("marked"))).toBe(true);
  expect(sameFingerprint(before(identifiers(1)), now("named"))).toBe(true);
  expect(sameFingerprint(before([{ frame: site, kind: "code", role: "textbox" }]), now("separated"))).toBe(false);
  // A look read before held a switched row's first box alone: it matches where its step types as
  // many codes as the row has boxes, as a minter records such a row, and only there.
  const codes = (count: number) =>
    ({ page: `${site}/verify`, fields: Array.from({ length: count }, (_, at) => ({ selector: `#d${at}`, slot: "code" as const })) }) satisfies AutofillRecipeStep;
  expect(sameFingerprint({ fingerprint: before(identifiers(1)), step: codes(6) }, now("switched"))).toBe(true);
  expect(sameFingerprint({ fingerprint: before(identifiers(1)), step: codes(1) }, now("switched"))).toBe(false);
  expect(sameFingerprint(before(identifiers(1)), now("switched"))).toBe(false);
});

test("a page with no box that shows a modal dialog reads as the dialog, keeping the page as read before beside it", async ({
  page,
}) => {
  const scan = await open(page, {
    [site]: `<h1>Groceries near you</h1><button>Log in</button><button>Sign up</button>
      <div role="dialog" aria-modal="true"><h2>Try membership free</h2><button>Start trial</button><button>No thanks</button></div>`,
  });
  const shown = await scan();
  const before = fingerprintOf({
    top: site,
    boxes: [],
    submit: false,
    message: "~ near you",
    buttons: ["~ in", "~ up", "~ trial", "~ thanks"],
  });
  expect(shown.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [],
      submit: false,
      message: "~ membership free",
      buttons: ["~ trial", "~ thanks"],
      instruction: before.message,
      ways: before.buttons,
    }),
  );
  // A look read before dialogs were read still matches, after a look read as the dialog.
  expect(sameFingerprint(before, shown.fingerprint)).toBe(true);
  expect(toldApart(shown.fingerprint, shown.fingerprint)).toBeLessThan(toldApart(before, shown.fingerprint) ?? 0);
  // The page with the dialog gone is another look.
  await page.evaluate(() => document.querySelector('[role="dialog"]')?.remove());
  const behind = await scan();
  expect(behind.fingerprint).toEqual(fingerprintOf({ top: site, boxes: [], submit: false, message: "~ near you", buttons: ["~ in", "~ up"] }));
  expect(sameFingerprint(behind.fingerprint, shown.fingerprint)).toBe(false);
  // The same dialog over another page, as another login's home page shows it, is the same look:
  // a state read as the dialog matches it, as one read before, which holds only the page behind,
  // never does.
  const elsewhere = await (
    await open(page, {
      [site]: `<h1>Groceries near you</h1><button>Log in now</button><button>Sign up</button>
        <div role="dialog" aria-modal="true"><h2>Try membership free</h2><button>Start trial</button><button>No thanks</button></div>`,
    })
  )();
  expect(elsewhere.fingerprint.instruction).toBe(shown.fingerprint.instruction);
  expect(elsewhere.fingerprint.ways).not.toEqual(shown.fingerprint.ways);
  expect(sameFingerprint(shown.fingerprint, elsewhere.fingerprint)).toBe(true);
  expect(toldApart(shown.fingerprint, elsewhere.fingerprint)).toBe(0);
  expect(sameFingerprint(before, elsewhere.fingerprint)).toBe(false);
});

test("a page with no box reads apart from a notice whose control the library dismisses, keeping the page as read before beside it", async ({
  page,
}) => {
  const notice = `<div role="region" aria-label="Cookies"><h2>We use cookies</h2><button id="accept">Accept all</button><button>Settings</button></div>`;
  const body = (shown: string) => `${shown}<h2>Welcome to the shop</h2><button>Log in</button>`;
  const before = await (await open(page, { [site]: body(notice) }))();
  expect(before.fingerprint).toEqual(
    fingerprintOf({ top: site, boxes: [], submit: false, message: "~ use cookies", buttons: ["~ all", "~", "~ in"] }),
  );
  const apart = await (await open(page, { [site]: body(notice) }, undefined, ["#accept"]))();
  expect(apart.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [],
      submit: false,
      message: "~ to the shop",
      buttons: ["~ in"],
      instruction: before.fingerprint.message,
      ways: before.fingerprint.buttons,
    }),
  );
  // A look read before matches, and so does the page once the notice is gone.
  expect(sameFingerprint(before.fingerprint, apart.fingerprint)).toBe(true);
  const gone = await (await open(page, { [site]: body("") }, undefined, ["#accept"]))();
  expect(gone.fingerprint).toEqual(fingerprintOf({ top: site, boxes: [], submit: false, message: "~ to the shop", buttons: ["~ in"] }));
  expect(sameFingerprint(gone.fingerprint, apart.fingerprint)).toBe(true);
});

test("a code picked from four or more named checkboxes, on a page with no text box, reads as a code box and still matches a look read before", async ({
  page,
}) => {
  const pictures = (count: number) =>
    ["apple", "boat", "cat", "dog", "egg", "fish"].slice(0, count).map((name) => `<input type="checkbox" aria-label="${name}">`).join("");
  const body = (grid: string, extra = "") =>
    `<h1>Pick your pictures</h1><form action="/verify" method="post"><div>${grid}</div>
      <label><input type="checkbox"> Remember this device</label>${extra}<button>Continue</button></form>`;
  const shown = await (await open(page, { [site]: body(pictures(6)) }))();
  const before = await (await open(page, { [site]: body("") }))();
  expect(shown.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [{ frame: site, kind: "code", role: "checkbox" }],
      submit: true,
      instruction: before.fingerprint.message,
      ways: before.fingerprint.buttons,
    }),
  );
  expect(sameFingerprint(before.fingerprint, shown.fingerprint)).toBe(true);
  // Three checkboxes, or a page with a box that takes typing, read as before.
  const three = await (await open(page, { [site]: body(pictures(3)) }))();
  expect(three.fingerprint.boxes).toEqual([]);
  const typed = await (await open(page, { [site]: body(pictures(6), '<input type="email" name="email">') }))();
  expect(typed.fingerprint.boxes).toEqual([{ frame: site, kind: "identifier", takes: "email" }]);
});

test("a picture code box on a sign-in form reads as before, marked, so a page that shows it only at times reads as one look", async ({
  page,
}) => {
  const form = (code: string) =>
    `<h1>Sign in</h1><form action="/session" method="post"><input type="email" name="email"><input type="password" name="password">${code}<button>Continue</button></form>`;
  const pictured = '<div><input type="text" name="captcha"><canvas width="120" height="40"></canvas></div>';
  const shown = await (await open(page, { [site]: form(pictured) }))();
  const plain = { frame: site, kind: "identifier" as const, takes: "other" as const };
  const sure = [{ frame: site, kind: "identifier" as const, takes: "email" as const }, { frame: site, kind: "password" as const }];
  expect(shown.fingerprint.boxes).toEqual(fingerprintOf({ top: site, boxes: [...sure, { ...plain, role: "captcha" }], submit: true }).boxes);
  const without = await (await open(page, { [site]: form("") }))();
  const before = fingerprintOf({ ...shown.fingerprint, boxes: [...sure, plain] });
  // A look read before, which counted it, matches; so does the page without it, either way.
  expect(sameFingerprint(before, shown.fingerprint)).toBe(true);
  expect(sameFingerprint(without.fingerprint, shown.fingerprint)).toBe(true);
  // A box of that name with no picture beside it reads as before, unmarked.
  const bare = await (await open(page, { [site]: form('<input type="text" name="captcha">') }))();
  expect(bare.fingerprint.boxes).toEqual(before.boxes);
});

test("a page that shows nothing outside its open shadow roots reads through them; one that shows text of its own reads as before", async ({
  page,
}) => {
  const form = '<h1>Sign in</h1><form><input type="email" name="email"><input type="password" name="password"><button>Continue</button></form>';
  const component = (own: string) =>
    `${own}<sign-in-form></sign-in-form><script>customElements.define("sign-in-form", class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(form)}; }
    });</script>`;
  const deep = await (await open(page, { [site]: component("") }))();
  expect(deep.fingerprint).toEqual(
    fingerprintOf({
      top: site,
      boxes: [
        { frame: site, kind: "identifier", takes: "email" },
        { frame: site, kind: "password" },
      ],
      submit: true,
      instruction: "~ in",
      ways: ["~"],
    }),
  );
  const light = await (await open(page, { [site]: component("<p>Welcome back</p>") }))();
  expect(light.fingerprint).toEqual(fingerprintOf({ top: site, boxes: [], submit: false, message: "~ back", buttons: [] }));
});
