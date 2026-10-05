/**
 * The shape of a form control, as the page code reads it: a native date input, a text box, a
 * native select, or a custom ARIA dropdown (a combobox or a button that opens a listbox).
 */
export type FormControlShape = "date" | "text" | "select" | "combobox" | "other";

/**
 * An ISO `YYYY-MM-DD` date as `format` writes it, from the tokens `YYYY`, `YY`, `MMMM` and `MMM`
 * (the month's full and short name in `locale`, English when the locale is unknown), `MM`, `M`, `DD`
 * and `D`; anything else is kept as written. The page code's `formatDate` is this function, so the
 * host and a script render a date the same way. An impossible date throws `date_invalid`.
 * Self-contained: it runs in page code from its own source.
 */
export const formatDate = (iso: string, format: string, locale = "en-US"): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  const [, year = "", month = "", day = ""] = match ?? [];
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (match === null || at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(day))
    throw Object.assign(new Error("date_invalid"), { name: "FormControlFailure" });
  const named = (style: "long" | "short") => {
    try {
      return new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" }).format(at);
      // error-reporting-allow: typed-recovery a locale the browser does not know names the month in English, as documented
    } catch {
      return new Intl.DateTimeFormat("en-US", { month: style, timeZone: "UTC" }).format(at);
    }
  };
  const tokens: Readonly<Record<string, string>> = {
    YYYY: year,
    YY: year.slice(2),
    MMMM: named("long"),
    MMM: named("short"),
    MM: month,
    M: String(Number(month)),
    DD: day,
    D: String(Number(day)),
  };
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D/gu, (token) => tokens[token] ?? token);
};

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then call its functions with your verified Playwright locators. Every function reads
 * back that the page took the value and throws an Error whose message is a fixed reason, never a
 * value: `date_invalid`, `format_mismatch`, `control_unsupported`, `listbox_missing`,
 * `option_missing`, `option_ambiguous`, `option_disabled` or `not_committed`.
 *
 * - `formControlShape(control)`: the control's shape (`FormControlShape`).
 * - `formatDate(iso, format, locale?)`: an ISO `YYYY-MM-DD` date as `format` writes it (see
 *   the exported `formatDate`).
 * - `fillDate(control, iso, format, { timeout }?)`: fills an ISO date into whatever date control
 *   the page has: a native date input (always ISO), a text box written in `format` (typed again
 *   character by character when an input mask rewrote it), or one part of a split date (`MM`, `DD`
 *   or `YYYY`) in a text box, a native select or a custom dropdown, matched by number or month name.
 *   It returns `{ shape }`, never the value.
 * - `chooseOption(control, wanted, { timeout }?)`: chooses the one option of a native select or a
 *   custom dropdown whose label or value is one of `wanted` (a string or a list of alternate
 *   spellings, such as `["CA", "California"]`). A label that equals one wins over a value that does,
 *   which wins over a label that holds it as a whole word; two different options at the winning
 *   rank are ambiguous. A custom dropdown is opened, its own listbox found through `aria-controls`
 *   or `aria-owns` (else the one visible listbox), typed into when it filters as you type, and
 *   scrolled when it renders its options as you scroll. Returns `{ shape, label, value }`.
 */
export const formControlsCode = String.raw`
const formControlFailure = (reason) => Object.assign(new Error(reason), { name: "FormControlFailure" });
const formControlText = (text) =>
  String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "");
const formControlFrame = async (control) => {
  const handle = await control.elementHandle();
  const frame = handle === null ? null : await handle.ownerFrame();
  return frame ?? control.page().mainFrame();
};
const formControlShape = (control) =>
  control.evaluate((element) => {
    const popup = element.getAttribute("aria-haspopup");
    if (element instanceof HTMLSelectElement) return "select";
    // A date picker's popup is a dialog or grid: the field still takes typing.
    if (popup === "dialog" || popup === "grid") return element instanceof HTMLInputElement ? "text" : "other";
    if (element.getAttribute("role") === "combobox" || popup === "listbox" || popup === "true" || popup === "menu")
      return "combobox";
    if (element instanceof HTMLInputElement && element.type === "date") return "date";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)
      return "text";
    return "other";
  });
const formatDate = ${String(formatDate)};
const formControlOrdinal = (day) => {
  const number = Number(day);
  const suffix = number % 10 === 1 && number !== 11 ? "st" : number % 10 === 2 && number !== 12 ? "nd" : number % 10 === 3 && number !== 13 ? "rd" : "th";
  return number + suffix;
};
/** Every way an option can name one part of the date, the format's own first. */
const formControlDateCandidates = (iso, format, locale) => {
  const kinds = new Set((String(format).match(/YYYY|YY|MMMM|MMM|MM|M|DD|D/g) ?? []).map((token) => token[0]));
  if (kinds.size !== 1) throw formControlFailure("format_mismatch");
  const [kind] = kinds;
  const first = formatDate(iso, format, locale);
  const same = { Y: ["YYYY", "YY"], M: ["MM", "M", "MMMM", "MMM"], D: ["DD", "D"] }[kind];
  const candidates = [first, ...same.map((token) => formatDate(iso, token, locale))];
  if (kind === "M") candidates.push(...same.slice(2).map((token) => formatDate(iso, token, "en-US")));
  if (kind === "D") candidates.push(formControlOrdinal(iso.slice(8)));
  return [...new Set(candidates)];
};
/** The one option a choice names, by rank: label, then value, then a whole word of the label. */
const formControlPick = (options, wanted) => {
  const names = new Set(wanted.map(formControlText).filter((name) => name !== ""));
  const words = (label) => label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const ranks = [
    (option) => names.has(option.label),
    (option) => option.value !== "" && names.has(option.value),
    (option) => words(option.label).some((word) => names.has(word)),
  ];
  for (const rank of ranks) {
    const matched = options.filter(rank);
    if (matched.length === 0) continue;
    if (matched.length > 1) return { failure: "option_ambiguous" };
    return matched[0].disabled ? { failure: "option_disabled" } : { option: matched[0] };
  }
  return { failure: "option_missing" };
};
const formControlSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formControlChooseNative = async (control, wanted, timeout) => {
  const options = await control.evaluate((select) =>
    Array.from(select.options).map((option, index) => ({
      index,
      label: option.label || option.textContent || "",
      value: option.value,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    })),
  );
  const picked = formControlPick(
    options.map((option) => ({ ...option, label: formControlText(option.label), value: formControlText(option.value) })),
    wanted,
  );
  if (picked.failure) throw formControlFailure(picked.failure);
  await control.selectOption({ index: picked.option.index }, { timeout });
  if ((await control.evaluate((select) => select.selectedIndex)) !== picked.option.index)
    throw formControlFailure("not_committed");
  const chosen = options[picked.option.index];
  return { shape: "select", label: chosen.label.trim(), value: chosen.value };
};
const formControlListbox = async (control, frame, until) => {
  while (true) {
    const ids = [await control.getAttribute("aria-controls"), await control.getAttribute("aria-owns")]
      .filter(Boolean)
      .flatMap((value) => value.split(/\s+/).filter(Boolean));
    for (const id of ids) {
      const owned = frame.locator("[id=" + JSON.stringify(id) + "]");
      if ((await owned.count()) !== 1 || !(await owned.isVisible())) continue;
      if ((await owned.getAttribute("role")) === "listbox") return owned;
      const inner = owned.locator("[role=listbox]");
      if ((await inner.count()) === 1) return inner;
      return owned;
    }
    if (ids.length === 0) {
      const visible = [];
      const listboxes = frame.locator("[role=listbox]");
      const count = Math.min(await listboxes.count(), 20);
      for (let index = 0; index < count; index++)
        if (await listboxes.nth(index).isVisible()) visible.push(listboxes.nth(index));
      if (visible.length === 1) return visible[0];
      if (visible.length > 1) throw formControlFailure("listbox_missing");
    }
    if (Date.now() >= until) throw formControlFailure("listbox_missing");
    await formControlSleep(50);
  }
};
const formControlOptions = (listbox) =>
  listbox.locator("[role=option]").evaluateAll((options) =>
    options.map((option, index) => ({
      index,
      label: option.getAttribute("aria-label") || option.textContent || "",
      value: option.getAttribute("data-value") ?? option.getAttribute("value") ?? "",
      disabled: option.getAttribute("aria-disabled") === "true",
    })),
  );
const formControlChooseCustom = async (control, wanted, timeout) => {
  const until = Date.now() + timeout;
  const frame = await formControlFrame(control);
  if ((await control.getAttribute("aria-expanded")) !== "true") await control.click({ timeout });
  const editable = await control.evaluate(
    (element) => element instanceof HTMLInputElement && !element.readOnly && !element.disabled,
  );
  let typed = false;
  // A dropdown that filters as you type can list nothing until something is typed.
  let listbox = editable
    ? await formControlListbox(control, frame, Math.min(until, Date.now() + 500)).catch((error) => {
        if (error.name !== "FormControlFailure") throw error;
        return null;
      })
    : null;
  if (listbox === null && editable) {
    await control.fill(wanted[0], { timeout });
    typed = true;
  }
  listbox ??= await formControlListbox(control, frame, until);
  let picked = { failure: "option_missing" };
  let options = [];
  let stuck = 0;
  while (true) {
    const before = options.length;
    options = await formControlOptions(listbox);
    if (options.length !== before) stuck = 0;
    picked = formControlPick(
      options.map((option) => ({ ...option, label: formControlText(option.label), value: formControlText(option.value) })),
      wanted,
    );
    if (picked.failure !== "option_missing" || Date.now() >= until) break;
    // A dropdown that filters as you type shows its options for the typed text.
    if (editable && !typed) {
      await control.fill(wanted[0], { timeout });
      typed = true;
      continue;
    }
    // One that renders its options as it scrolls shows more of them further down.
    const moved = await listbox.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before + Math.max(element.clientHeight, 1);
      return element.scrollTop !== before;
    });
    // Options the scroll asked for can take a moment to arrive; a list that stays put has no more.
    if (moved) stuck = 0;
    else if (!editable && ++stuck > 10) break;
    await formControlSleep(50);
  }
  if (picked.failure) throw formControlFailure(picked.failure);
  const option = listbox.locator("[role=option]").nth(picked.option.index);
  await option.scrollIntoViewIfNeeded({ timeout });
  await option.click({ timeout });
  const chosen = options[picked.option.index];
  // The control shows the choice as its label or one of the wanted names, alone or as whole words
  // of its text ("Month: July"), or the option itself is marked selected.
  const phrase = (text) => " " + formControlText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ") + " ";
  const names = [chosen.label, ...wanted].map(phrase).filter((name) => name.trim() !== "");
  while (true) {
    const shown = await control.evaluate((element) =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent,
    );
    const selected = await option.getAttribute("aria-selected", { timeout: 100 }).catch(() => null);
    if (names.some((name) => phrase(shown).includes(name)) || selected === "true")
      return { shape: "combobox", label: chosen.label.trim(), value: chosen.value };
    if (Date.now() >= until) throw formControlFailure("not_committed");
    await formControlSleep(50);
  }
};
const chooseOption = async (control, wanted, options = {}) => {
  const timeout = options.timeout ?? 10000;
  const choices = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
  if (choices.length === 0) throw formControlFailure("option_missing");
  const shape = await formControlShape(control);
  if (shape === "select") return formControlChooseNative(control, choices, timeout);
  if (shape === "combobox") return formControlChooseCustom(control, choices, timeout);
  throw formControlFailure("control_unsupported");
};
/** Letters and digits only: an input mask adds or drops separators, never the date itself. */
const formControlSameText = (shown, expected) =>
  formControlText(shown).replace(/[^\p{L}\p{N}]/gu, "") === formControlText(expected).replace(/[^\p{L}\p{N}]/gu, "");
const fillDate = async (control, iso, format, options = {}) => {
  const timeout = options.timeout ?? 10000;
  const shape = await formControlShape(control);
  const frame = await formControlFrame(control);
  const locale = (await frame.evaluate(() => document.documentElement.lang).catch(() => "")) || "en-US";
  if (shape === "date") {
    formatDate(iso, "YYYY-MM-DD");
    await control.fill(iso, { timeout });
    if ((await control.inputValue()) !== iso) throw formControlFailure("not_committed");
    return { shape };
  }
  if (shape === "select" || shape === "combobox") {
    await chooseOption(control, formControlDateCandidates(iso, format, locale), { timeout });
    return { shape };
  }
  if (shape !== "text") throw formControlFailure("control_unsupported");
  const text = formatDate(iso, format, locale);
  await control.fill(text, { timeout });
  if (formControlSameText(await control.inputValue(), text)) return { shape };
  // A masked field rewrites what is filled at once; it takes the date typed key by key, with or
  // without its separators.
  for (const keys of [text, text.replace(/[^\p{L}\p{N}]/gu, "")]) {
    await control.fill("", { timeout });
    await control.pressSequentially(keys, { timeout });
    if (formControlSameText(await control.inputValue(), text)) return { shape };
  }
  throw formControlFailure("not_committed");
};
`;
