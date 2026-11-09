import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// With `typing: "keyboard"` the host types a code split across a row of one-character boxes as a
// person does: one pointer click into the first box, then every digit by a held trusted key while
// the page's own script moves the focus from box to box, then one click of the submit, unless the
// page sent the code itself. A row whose page keeps the focus where it is is typed box by box.

const site = "https://bank.example.test";
const code = "482913";
// The host looks for up to 2 s for a page that sends itself before it clicks, and the fallback
// types box by box: more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 90_000 });

/**
 * One event the page saw, in order, across its own sends: a mouse down or click, a focus (with
 * `byPage`, whether the page's own script moved the focus there), or a key down, key press, input
 * or key up, with its time.
 */
interface Felt {
  readonly type: string;
  readonly field: string;
  readonly trusted: boolean;
  readonly key: string | null;
  readonly byPage: boolean | null;
  readonly at: number;
}

const feel = `<script>
let moving = null;
window.pageFocus = (box) => { moving = box; box.focus(); moving = null; };
for (const type of ["mousedown", "click", "focusin", "keydown", "keypress", "input", "keyup"])
  document.addEventListener(type, (event) => {
    window.reportFelt({
      type,
      field: event.target?.name || event.target?.id || "",
      trusted: event.isTrusted,
      key: typeof event.key === "string" ? event.key : null,
      byPage: type === "focusin" ? moving === event.target : null,
      at: performance.timeOrigin + event.timeStamp,
    });
  }, true);
</script>`;

/**
 * Six one-digit boxes and a Verify button. With `advances`, each box hands the focus to the next
 * once a digit goes in. `sends`: on the sixth digit the form submits itself, or the page sends the
 * code with a request of its own and keeps its boxes as typed.
 */
const rowScreen = ({ advances, sends }: { advances: boolean; sends?: "form" | "request" }) => `${feel}
<form id="form" method="post" action="/verify">
<p>Enter the code we sent you</p>
${Array.from(code, (_, at) => `<input id="box-${at + 1}" name="d${at + 1}" class="code" maxlength="1" inputmode="numeric" aria-label="Digit ${at + 1}"${at === 0 ? ' autocomplete="one-time-code"' : ""}>`).join("")}
<button id="verify">Verify</button>
</form>
<script>
const form = document.getElementById("form");
const boxes = [...document.querySelectorAll(".code")];
boxes.forEach((box, at) => box.addEventListener("input", () => {
  if (${JSON.stringify(advances)} && box.value !== "" && boxes[at + 1]) window.pageFocus(boxes[at + 1]);
  if (!boxes.every((each) => each.value !== "")) return;
  if (${JSON.stringify(sends === "form")}) form.requestSubmit();
  if (${JSON.stringify(sends === "request")})
    fetch("/check", { method: "POST", body: new URLSearchParams(boxes.map((each) => [each.name, each.value])) });
}));
</script>`;

/** One code field that takes the whole code, and a Verify button. */
const fieldScreen = `${feel}
<form method="post" action="/verify">
<p>Enter the code we sent you</p>
<input id="code" name="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" aria-label="Code">
<button id="verify">Verify</button>
</form>`;

const rowStep: AutofillStep = {
  fields: Array.from(code, (_, at) => ({ selector: `#box-${at + 1}`, slot: "code" as const })),
  submit: "#verify",
};
const fieldStep: AutofillStep = { fields: [{ selector: "#code", slot: "code" }], submit: "#verify" };

/** Serves `screen`, and keeps what the page saw and each code it sent, as its fields' values. */
const serve = async (page: Page, screen: string) => {
  const felt: Felt[] = [];
  const sent: string[] = [];
  await page.exposeFunction("reportFelt", (event: Felt) => void felt.push(event));
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      sent.push([...new URLSearchParams(request.postData() ?? "").values()].join(""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else await route.fulfill({ contentType: "text/html", body: screen });
  });
  await page.goto(`${site}/verify`);
  return { felt, sent };
};

/**
 * Fills the step with `values` by keyboard, as the local host signs in. The host's own reading of
 * whether the page sent the code (`codeSent`) watches the page's requests, as a host's request
 * log does, reads them when it is called and keeps what it was asked. `hook: "none"` passes no
 * reading, as an older host does, and `"throws"` one that throws.
 */
const fill = async (
  page: Page,
  step: AutofillStep,
  values: readonly string[],
  hook: "reads" | "none" | "throws" = "reads",
) => {
  const requests: { readonly at: number; readonly body: string }[] = [];
  page.on("request", (request) => requests.push({ at: Date.now(), body: request.postData() ?? "" }));
  const asked: { readonly since: number; readonly code: string }[] = [];
  const codeSent = (typed: { readonly since: number; readonly code: string }) => {
    asked.push(typed);
    if (hook === "throws") throw new Error("Request log unavailable");
    const sent = requests.some(
      ({ at, body }) =>
        at >= typed.since && [...new URLSearchParams(body).values()].join("") === typed.code,
    );
    return Effect.succeed(sent);
  };
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
      ...(hook === "none" ? {} : { codeSent }),
    }),
  );
  expectNotCarried(host.calls, code);
  // The focus calls the host made, by the field each focused or clicked.
  const focusCalls = host.calls.flatMap(({ script }) =>
    [...script.matchAll(/const fieldLocated = located\.fields\[(\d+)\];/g)].map(([, at]) => Number(at)),
  );
  return { report, asked, focusCalls };
};

/** The row's boxes' own events of `type`. */
const boxEvents = (felt: readonly Felt[], type: string) =>
  felt.filter((event) => event.type === type && /^d[1-6]$/.test(event.field));

/** How long each key was held: each key down to the key up that followed it, in milliseconds. */
const holds = (felt: readonly Felt[]) => {
  const downs = felt.filter((event) => event.type === "keydown");
  const ups = felt.filter((event) => event.type === "keyup");
  return downs.map((down, at) => Math.round((ups[at]?.at ?? down.at) - down.at));
};

test("a split code whose boxes move the focus on is typed through its first box: one pointer click, held keys the page moves box to box, and one Verify", async ({
  page,
}) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: true }));
  const { report, asked, focusCalls } = await fill(page, rowStep, [...code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: rowStep.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "clicked",
  });
  // One focus call, the first box's, which clicked it with the pointer.
  expect(focusCalls).toEqual([0]);
  expect(boxEvents(felt, "mousedown")).toEqual([expect.objectContaining({ field: "d1", trusted: true })]);
  expect(boxEvents(felt, "click")).toEqual([expect.objectContaining({ field: "d1", trusted: true })]);
  // Every later box took the focus from the page's own script, once.
  expect(boxEvents(felt, "focusin").map(({ field, byPage }) => [field, byPage])).toEqual([
    ["d1", false],
    ...Array.from(code.slice(1), (_, at) => [`d${at + 2}`, true]),
  ]);
  // One trusted key per digit, each into its own box, with its input there.
  expect(boxEvents(felt, "keydown").map(({ field, key, trusted }) => [field, key, trusted])).toEqual(
    Array.from(code, (digit, at) => [`d${at + 1}`, digit, true]),
  );
  expect(boxEvents(felt, "input").map(({ field }) => field)).toEqual(
    Array.from(code, (_, at) => `d${at + 1}`),
  );
  expect(felt.filter((event) => event.type === "keyup" && event.trusted)).toHaveLength(code.length);
  for (const held of holds(felt)) expect(held).toBeGreaterThanOrEqual(55);
  // The host asked whether the page sent the code itself, and the page never did: one Verify.
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((typed) => typed.code === code)).toBe(true);
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toHaveLength(1);
  expect(sent).toEqual([code]);
  const downs = boxEvents(felt, "keydown").map(({ at }) => at);
  const gaps = downs.slice(1).map((at, index) => Math.round(at - (downs[index] ?? at)));
  test.info().annotations.push({ type: "gaps between key downs (ms)", description: gaps.join(", ") });
  test.info().annotations.push({ type: "key holds (ms)", description: holds(felt).join(", ") });
});

test("a split code whose boxes keep the focus has its first box typed, emptied and typed again box by box, and sends each digit once", async ({
  page,
}) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: false }));
  const { report, focusCalls } = await fill(page, rowStep, [...code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: rowStep.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "clicked",
  });
  // The row's click into the first box and its first key, then a focus call per box from the first.
  expect(focusCalls).toEqual([0, 0, 1, 2, 3, 4, 5]);
  expect(boxEvents(felt, "mousedown")).toEqual([expect.objectContaining({ field: "d1", trusted: true })]);
  expect(boxEvents(felt, "keydown")[0]).toMatchObject({ field: "d1", key: code[0], trusted: true });
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toHaveLength(1);
  expect(sent).toEqual([code]);
});

test("a split code whose page sends it itself on the last digit and keeps its boxes is reported sent by the page, and Verify is never clicked", async ({
  page,
}) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: true, sends: "request" }));
  const { report } = await fill(page, rowStep, [...code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: rowStep.fields.map(() => ({ slot: "code", status: "filled" })),
    submit: "page",
  });
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toEqual([]);
  expect(sent).toEqual([code]);
});

test("without the host's reading, a split code whose page sends it itself and keeps its boxes is still clicked, as before", async ({
  page,
}) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: true, sends: "request" }));
  const { report } = await fill(page, rowStep, [...code], "none");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toHaveLength(1);
  expect(sent).toEqual([code, code]);
});

test("a host reading that throws counts as not sent, and Verify is clicked once", async ({ page }) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: true }));
  const { report, asked } = await fill(page, rowStep, [...code], "throws");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(asked.length).toBeGreaterThan(1);
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toHaveLength(1);
  expect(sent).toEqual([code]);
});

test("a split code whose sixth digit submits the form itself is typed through its first box and reported sent by the page", async ({
  page,
}) => {
  const { felt, sent } = await serve(page, rowScreen({ advances: true, sends: "form" }));
  const { report, focusCalls } = await fill(page, rowStep, [...code]);
  expect(report).toMatchObject({ outcome: "filled", submit: "page" });
  expect(focusCalls).toEqual([0]);
  expect(felt.filter((event) => event.type === "click" && event.field === "verify")).toEqual([]);
  expect(sent).toEqual([code]);
});

test("a code in one field is typed by held keys, and Verify is clicked once", async ({ page }) => {
  const { felt, sent } = await serve(page, fieldScreen);
  const { report } = await fill(page, fieldStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(felt.filter((event) => event.type === "keydown").map(({ key }) => key)).toEqual([...code]);
  for (const held of holds(felt)) expect(held).toBeGreaterThanOrEqual(55);
  expect(sent).toEqual([code]);
});
