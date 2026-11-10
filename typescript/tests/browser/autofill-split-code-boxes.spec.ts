import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A code screen of six one-digit number boxes whose page switches each box on only a moment after
// the one before it holds a digit, as some sign-ins draw a split code. The host types the code box
// by box, waiting for each box to switch on, and refuses a box that never does.

const site = "https://bank.example.test";
const code = "482913";
// Six boxes, each typed after the page switches it on, and a 2 s wait for a box that never does.
test.describe.configure({ timeout: 90_000 });

const step: AutofillStep = {
  fields: Array.from(code, (_, index) => ({ selector: `#box-${index + 1}`, slot: "code" as const })),
  submit: "#verify",
};

/** The screen: box 1 on, each later box switched on 300 ms after the one before it gets input, but `never`. */
const screen = (never?: number) => `<form method="post" action="/verify">
<p>Enter the code we sent you</p>
${Array.from(code, (_, index) => `<input id="box-${index + 1}" name="d${index + 1}" type="number" aria-label="Digit ${index + 1}"${index === 0 ? ' autocomplete="one-time-code"' : " disabled"}>`).join("")}
<button id="verify">Verify</button>
</form>
<script>
const boxes = [...document.querySelectorAll("input[type=number]")];
boxes.forEach((box, at) => box.addEventListener("input", () => {
  const next = boxes[at + 1];
  if (box.value === "" || next === undefined || at + 2 === ${JSON.stringify(never ?? null)}) return;
  setTimeout(() => {
    next.disabled = false;
    next.focus();
  }, 300);
}));
</script>`;

/** Serves the screen and keeps each code the form posts, its boxes' digits in order. */
const serve = async (page: Page, never?: number) => {
  const received: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") {
      const form = new URLSearchParams(route.request().postData() ?? "");
      received.push(step.fields.map((_, at) => form.get(`d${at + 1}`) ?? "").join(""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else await route.fulfill({ contentType: "text/html", body: screen(never) });
  });
  await page.goto(`${site}/verify`);
  return received;
};

const fill = async (page: Page) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason} at ${String(inspection.target)}`);
  return Effect.runPromise(
    fillAutofillStep({
      step,
      values: [...code],
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
};

test("a split code whose page switches each box on only after the one before it holds a digit is typed box by box and submitted", async ({
  page,
}) => {
  const received = await serve(page);
  const report = await fill(page);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: step.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "clicked",
  });
  expect(received).toEqual([code]);
});

test("a split code whose third box never switches on is refused there as not editable after the wait, with nothing submitted", async ({
  page,
}) => {
  const received = await serve(page, 3);
  const report = await fill(page);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: ["filled", "filled", "failed", "not_attempted", "not_attempted", "not_attempted"].map(
      (status) => ({ slot: "code", status }),
    ),
    submit: "not_attempted",
    failureDetail: { context: { check: "not_editable" } },
  });
  expect(received).toEqual([]);
});
