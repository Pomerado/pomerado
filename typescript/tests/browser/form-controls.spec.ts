import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's date and dropdown helpers, run as a Kernel call body runs them (`page` in
// scope) on local fixture pages, one per control shape. Chromium must generate the events: the
// custom dropdowns open, filter and commit only from real clicks, typing and scrolling.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${formControlsCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/** What the page's form would submit. */
const submitted = (page: Page) =>
  page.evaluate(() => {
    const form = document.forms[0];
    return form === undefined ? {} : Object.fromEntries(new FormData(form));
  });

const dateOfBirth = "1990-07-04";

/**
 * A custom dropdown: a button that owns a listbox through aria-controls, rendered when opened,
 * which commits a click into the button's text and a hidden input. `virtual` renders ten options
 * at a time as the listbox scrolls; `filter` is an editable combobox whose options follow typing.
 */
const dropdown = (
  name: string,
  options: readonly (readonly [string, string])[],
  mode: "plain" | "virtual" | "filter" = "plain",
) => `
<div class="dropdown" data-name="${name}">
  ${
    mode === "filter"
      ? `<input role="combobox" aria-label="${name}" aria-expanded="false" aria-controls="${name}-list" autocomplete="off">`
      : `<button type="button" aria-label="${name}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${name}-list">Select</button>`
  }
  <input type="hidden" name="${name}">
  <div role="listbox" id="${name}-list" hidden style="max-height:100px;overflow:auto"></div>
</div>
<script>
(() => {
  const root = document.querySelector('[data-name="${name}"]');
  const control = root.querySelector('[aria-controls]');
  const list = root.querySelector('[role=listbox]');
  const hidden = root.querySelector('input[type=hidden]');
  const all = ${JSON.stringify(options)};
  const mode = ${JSON.stringify(mode)};
  let shown = 10;
  const render = () => {
    const query = mode === "filter" ? control.value.toLowerCase() : "";
    // A filtering dropdown lists nothing until something is typed.
    const visible = mode === "filter" && query === "" ? [] : all.filter(([, label]) => label.toLowerCase().startsWith(query)).slice(0, mode === "virtual" ? shown : all.length);
    // Options arrive a moment after the page asks for them, as from a server.
    setTimeout(() => {
      list.innerHTML = visible.map(([value, label]) => '<div role="option" style="height:20px" data-value="' + value + '">' + label + '</div>').join("");
    }, 30);
  };
  const open = () => { list.hidden = false; control.setAttribute("aria-expanded", "true"); render(); };
  control.addEventListener("click", open);
  if (mode === "filter") control.addEventListener("input", () => { if (list.hidden) open(); else render(); });
  list.addEventListener("scroll", () => {
    if (mode === "virtual" && list.scrollTop + list.clientHeight >= list.scrollHeight - 5 && shown < all.length) { shown += 10; render(); }
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (!option) return;
    hidden.value = option.dataset.value;
    if (mode === "filter") control.value = option.textContent; else control.textContent = option.textContent;
    list.hidden = true;
    control.setAttribute("aria-expanded", "false");
  });
})();
</script>`;

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

for (const [format, typed] of [
  ["MM/DD/YYYY", "07/04/1990"],
  ["DD/MM/YYYY", "04/07/1990"],
  ["YYYY-MM-DD", "1990-07-04"],
  ["MMDDYYYY", "07041990"],
  ["DD.MM.YYYY", "04.07.1990"],
  ["MMMM D, YYYY", "July 4, 1990"],
] as const)
  test(`fillDate writes ${format} into a text box`, async ({ page }) => {
    await page.setContent(
      `<form><label>Date of birth<input name="dob" placeholder="${format}"></label></form>`,
    );
    const filled = await call(
      page,
      `return await fillDate(page.getByLabel("Date of birth"), ${JSON.stringify(dateOfBirth)}, ${JSON.stringify(format)});`,
    );
    expect(filled).toEqual({ result: { shape: "text" } });
    expect(await submitted(page)).toEqual({ dob: typed });
  });

test("fillDate fills a native date input with the ISO date, whatever the format", async ({
  page,
}) => {
  await page.setContent(`<form><label>Date of birth<input type="date" name="dob"></label></form>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByLabel("Date of birth"), "1990-07-04", "MM/DD/YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "date" } });
  expect(await submitted(page)).toEqual({ dob: "1990-07-04" });
});

test("fillDate types into a masked field that rewrites what is filled at once", async ({
  page,
}) => {
  // The mask keeps digits only as they are typed one by one, adding its own slashes; a value set
  // in one go is cleared.
  await page.setContent(`<form><label>Date of birth<input name="dob" maxlength="10"></label></form>
<script>
const field = document.querySelector("input");
let digits = "";
field.addEventListener("keydown", (event) => {
  event.preventDefault();
  if (/^\\d$/.test(event.key) && digits.length < 8) digits += event.key;
  field.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
});
field.addEventListener("input", () => { if (field.value.replace(/\\D/g, "") !== digits) field.value = ""; });
</script>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByLabel("Date of birth"), "1990-07-04", "MM/DD/YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "text" } });
  expect(await submitted(page)).toEqual({ dob: "07/04/1990" });
});

test("fillDate fills split month, day and year text boxes", async ({ page }) => {
  await page.setContent(`<form><fieldset><legend>Date of birth</legend>
<label>Month<input name="month" maxlength="2"></label>
<label>Day<input name="day" maxlength="2"></label>
<label>Year<input name="year" maxlength="4"></label></fieldset></form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByLabel("Month"), iso, "MM"),
  await fillDate(page.getByLabel("Day"), iso, "DD"),
  await fillDate(page.getByLabel("Year"), iso, "YYYY"),
];`,
  );
  expect(filled).toEqual({ result: [{ shape: "text" }, { shape: "text" }, { shape: "text" }] });
  expect(await submitted(page)).toEqual({ month: "07", day: "04", year: "1990" });
});

test("fillDate chooses month, day and year in native selects by name or number", async ({
  page,
}) => {
  // Month values count from zero, so only the names tell July; days are unpadded; a placeholder
  // option leads each list.
  const monthOptions = months.map((name, index) => `<option value="${index}">${name}</option>`);
  const dayOptions = Array.from({ length: 31 }, (_, index) => `<option>${index + 1}</option>`);
  const yearOptions = Array.from({ length: 100 }, (_, index) => `<option>${2025 - index}</option>`);
  await page.setContent(`<form>
<label>Month<select name="month"><option value="">Month</option>${monthOptions.join("")}</select></label>
<label>Day<select name="day"><option value="">Day</option>${dayOptions.join("")}</select></label>
<label>Year<select name="year"><option value="">Year</option>${yearOptions.join("")}</select></label></form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByLabel("Month"), iso, "MM"),
  await fillDate(page.getByLabel("Day"), iso, "DD"),
  await fillDate(page.getByLabel("Year"), iso, "YYYY"),
];`,
  );
  expect(filled).toEqual({
    result: [{ shape: "select" }, { shape: "select" }, { shape: "select" }],
  });
  expect(await submitted(page)).toEqual({ month: "6", day: "4", year: "1990" });
});

test("fillDate chooses a month and a day in custom dropdowns", async ({ page }) => {
  // The month list shows short names and the day list ordinals.
  const monthList = months.map((name, index) => [String(index + 1), name.slice(0, 3)] as const);
  const ordinal = (day: number) =>
    `${day}${day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"}`;
  const dayList = Array.from(
    { length: 31 },
    (_, index) => [String(index + 1), ordinal(index + 1)] as const,
  );
  await page.setContent(`<form>${dropdown("Month", monthList)}${dropdown("Day", dayList)}</form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByRole("button", { name: "Month" }), iso, "MM"),
  await fillDate(page.getByRole("button", { name: "Day" }), iso, "DD"),
];`,
  );
  expect(filled).toEqual({ result: [{ shape: "combobox" }, { shape: "combobox" }] });
  expect(await submitted(page)).toEqual({ Month: "7", Day: "4" });
});

test("fillDate scrolls a custom year dropdown that renders its options as it scrolls", async ({
  page,
}) => {
  const yearList = Array.from({ length: 40 }, (_, index) => {
    const year = String(2025 - index);
    return [year, year] as const;
  });
  await page.setContent(`<form>${dropdown("Year", yearList, "virtual")}</form>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByRole("button", { name: "Year" }), "1990-07-04", "YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "combobox" } });
  expect(await submitted(page)).toEqual({ Year: "1990" });
});

test("chooseOption picks one option by any of its spellings in a native select", async ({
  page,
}) => {
  await page.setContent(`<form><label>State<select name="state">
<option value="">Choose</option><option value="CA">California</option><option value="NV">Nevada</option>
<option value="OR" disabled>Oregon</option></select></label></form>`);
  const state = 'page.getByLabel("State")';
  expect(await call(page, `return await chooseOption(${state}, ["California", "CA"]);`)).toEqual({
    result: { shape: "select", label: "California", value: "CA" },
  });
  expect(await submitted(page)).toEqual({ state: "CA" });
  // A value alone names it; a disabled or missing option is refused and changes nothing.
  expect(await call(page, `return await chooseOption(${state}, "NV");`)).toMatchObject({
    result: { value: "NV" },
  });
  expect(await call(page, `return await chooseOption(${state}, "Oregon");`)).toMatchObject({
    error: "option_disabled",
  });
  expect(await call(page, `return await chooseOption(${state}, "Texas");`)).toMatchObject({
    error: "option_missing",
  });
  expect(await submitted(page)).toEqual({ state: "NV" });
});

test("chooseOption refuses two different options that both match", async ({ page }) => {
  await page.setContent(`<form><label>Plan<select name="plan">
<option value="a">Basic monthly</option><option value="b">Basic yearly</option></select></label></form>`);
  expect(await call(page, `return await chooseOption(page.getByLabel("Plan"), "basic");`)).toEqual({
    error: "option_ambiguous",
  });
  expect(await submitted(page)).toEqual({ plan: "a" });
});

test("chooseOption types into a dropdown that filters as you type", async ({ page }) => {
  const countries = ["Canada", "Chile", "China", "France", "Germany"].map(
    (name) => [name.slice(0, 2).toUpperCase(), name] as const,
  );
  await page.setContent(`<form>${dropdown("Country", countries, "filter")}</form>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Country"), "Chile");`),
  ).toEqual({ result: { shape: "combobox", label: "Chile", value: "CH" } });
  expect(await submitted(page)).toEqual({ Country: "CH" });
});

test("a failure names its reason, never the value", async ({ page }) => {
  await page.setContent(`<form><label>Date of birth<input name="dob"></label>
<label>Month<select name="month"><option>7</option></select></label></form>`);
  // An impossible date, a whole date for one part's select, and a dropdown choice in a text box.
  expect(
    await call(
      page,
      `return await fillDate(page.getByLabel("Date of birth"), "1990-02-30", "MM/DD/YYYY");`,
    ),
  ).toEqual({ error: "date_invalid" });
  expect(
    await call(
      page,
      `return await fillDate(page.getByLabel("Month"), "1990-07-04", "MM/DD/YYYY");`,
    ),
  ).toEqual({ error: "format_mismatch" });
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Date of birth"), "July");`),
  ).toEqual({ error: "control_unsupported" });
  expect(await submitted(page)).toEqual({ dob: "", month: "7" });
});
