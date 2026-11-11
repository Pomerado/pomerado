import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// With `typing: "keyboard"` the host types a one-time code key by key, as a person does: one
// trusted key into each box of a code split across boxes, and a trusted key per digit into one
// code field. Chromium must generate the trusted key events and the input events the page's own
// script listens for.

const site = "https://bank.example.test";
const code = "482913";
// Six boxes take six focus calls and six keys each fill, and the host looks for up to 2 s for a
// page that sends itself before it clicks: more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 90_000 });

/** One key event or input a code field saw, reported to the test across the page's own sends. */
type Seen =
  | {
      readonly type: "keydown";
      readonly field: string;
      readonly key: string;
      readonly trusted: boolean;
      readonly at: number;
    }
  | { readonly type: "input"; readonly field: string; readonly keyed: boolean };

/**
 * The page's script that reports each code field's trusted key downs and inputs (`keyed`: whether
 * a trusted key down came first since the field's last input), and each click of Verify.
 */
const watch = `<script>
for (const field of document.querySelectorAll(".code")) {
  let keyed = false;
  field.addEventListener("keydown", (event) => {
    keyed = keyed || event.isTrusted;
    window.reportSeen({ type: "keydown", field: field.name, key: event.key, trusted: event.isTrusted, at: performance.timeOrigin + event.timeStamp });
  });
  field.addEventListener("input", () => {
    window.reportSeen({ type: "input", field: field.name, keyed });
    keyed = false;
  });
}
document.getElementById("verify").addEventListener("click", () => window.reportClick());
</script>`;

/**
 * Six one-digit boxes that move the focus to the next box once a digit goes in, and a Verify
 * button. With `sendsItself`, the sixth digit submits the form itself, as some code screens do.
 */
const boxesScreen = (sendsItself: boolean) => `<form id="form" method="post" action="/verify">
<p>Enter the code we sent you</p>
${Array.from(code, (_, at) => `<input id="box-${at + 1}" name="d${at + 1}" class="code" maxlength="1" inputmode="numeric" aria-label="Digit ${at + 1}"${at === 0 ? ' autocomplete="one-time-code"' : ""}>`).join("")}
<button id="verify">Verify</button>
</form>
<script>
const form = document.getElementById("form");
const boxes = [...document.querySelectorAll(".code")];
boxes.forEach((box, at) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[at + 1]) boxes[at + 1].focus();
  if (${JSON.stringify(sendsItself)} && boxes.every((each) => each.value !== "")) form.requestSubmit();
}));
</script>${watch}`;

/** One code field that takes the whole code, and a Verify button. */
const fieldScreen = `<form method="post" action="/verify">
<p>Enter the code we sent you</p>
<input id="code" name="code" class="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" aria-label="Code">
<button id="verify">Verify</button>
</form>${watch}`;

const boxesStep: AutofillStep = {
  fields: Array.from(code, (_, at) => ({ selector: `#box-${at + 1}`, slot: "code" as const })),
  submit: "#verify",
};
const fieldStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#verify",
};

/** Serves `screen`, and keeps what each code field saw, each Verify click and each form posted. */
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

/** Fills the step with `values` by keyboard, as the local host signs in. */
const fill = async (page: Page, step: AutofillStep, values: readonly string[]) => {
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
      typing: "keyboard",
      settleMs: 2_000,
    }),
  );
  expectNotCarried(host.calls, code);
  return report;
};

/** The milliseconds between each key down and the next, kept in the test's output. */
const recordGaps = (seen: readonly Seen[], name: string) => {
  const downs = seen.flatMap((event) => (event.type === "keydown" ? [event.at] : []));
  const gaps = downs.slice(1).map((at, index) => Math.round(at - (downs[index] ?? at)));
  const type = `${name} gaps between key downs (ms)`;
  test.info().annotations.push({ type, description: gaps.join(", ") });
  console.log(`${type}: ${gaps.join(", ")}`);
};

/** Each box saw one trusted key down, its digit, in box order, and no input no key started. */
const expectOneKeyPerBox = (seen: readonly Seen[]) => {
  expect(seen.filter((event) => event.type === "keydown")).toEqual(
    Array.from(code, (key, at) => ({
      type: "keydown",
      field: `d${at + 1}`,
      key,
      trusted: true,
      at: expect.any(Number),
    })),
  );
  expect(seen.filter((event) => event.type === "input" && !event.keyed)).toEqual([]);
};

test("a split code is typed one trusted key per box, in order, and the host clicks Verify once", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, boxesScreen(false));
  const report = await fill(page, boxesStep, [...code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: boxesStep.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "clicked",
  });
  expectOneKeyPerBox(seen);
  expect(clicks).toHaveLength(1);
  // The form posts once, with one digit in each box.
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    Object.fromEntries(Array.from(code, (digit, at) => [`d${at + 1}`, digit])),
  ]);
  recordGaps(seen, "split code");
});

test("a split code whose sixth key submits the form itself is reported sent by the page, and Verify is never clicked", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, boxesScreen(true));
  const report = await fill(page, boxesStep, [...code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: boxesStep.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "page",
  });
  expectOneKeyPerBox(seen);
  expect(clicks).toEqual([]);
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    Object.fromEntries(Array.from(code, (digit, at) => [`d${at + 1}`, digit])),
  ]);
});

test("a code in one field is typed a trusted key per digit, and the field holds the code", async ({
  page,
}) => {
  const { seen, clicks, received } = await serve(page, fieldScreen);
  const report = await fill(page, fieldStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(seen.filter((event) => event.type === "keydown")).toEqual(
    Array.from(code, (key) => ({
      type: "keydown",
      field: "code",
      key,
      trusted: true,
      at: expect.any(Number),
    })),
  );
  expect(seen.filter((event) => event.type === "input" && !event.keyed)).toEqual([]);
  expect(clicks).toHaveLength(1);
  expect(received.map((form) => form.get("code"))).toEqual([code]);
  recordGaps(seen, "one field");
});
