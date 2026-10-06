import { Schema } from "effect";

/**
 * A control on the page as the minter reads it after a submit: its role, accessible name or
 * label, input type and state. Never its value, typed text or placeholder, which a site may fill
 * with what was typed.
 */
export const PageControl = Schema.Struct({
  role: Schema.String,
  name: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  required: Schema.Boolean,
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type PageControl = typeof PageControl.Type;

/** The page's controls, visible ones first and at most `pageControlsLimit`, of `total` found. */
export const PageControls = Schema.Struct({
  controls: Schema.Array(PageControl),
  total: Schema.Number,
});
export type PageControls = typeof PageControls.Type;

/** At most this many controls are kept; `total` still counts every one. */
export const pageControlsLimit = 100;

/**
 * The longest role or name text page code returns for one control. Longer text is dropped whole,
 * never cut: a cut could keep the start of a typed value that screening for the whole value misses.
 */
export const pageControlTextLimit = 32_768;

/**
 * Page code, with `primary` bound: `pageControls()` reads every frame's form controls, buttons
 * and links as `PageControl`s, or null when the page cannot be read. Values never leave the page.
 * Names and roles come back as the page has them, never trimmed, collapsed or cut short, so the
 * host screens a typed value echoed in them whole before `presentControls` shortens them; a name
 * longer than `pageControlTextLimit` is null, and such a role is the element's implicit one. The
 * `pageControlsLimit` it keeps are the most useful: visible ones first, then enabled fields,
 * required ones first, each group in page order.
 */
export const pageControlsCode = `const pageControls = async () => {
  const read = ({ limit, textLimit }) => {
    // Page text as it is, or null when it has no words.
    const raw = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);
    // Text past the limit is dropped whole, never cut, so no part of a typed value escapes screening.
    const capped = (value) => (value !== null && value.length > textLimit ? null : value);
    // A label's own words, without the text of any control inside it.
    const words = (node) => {
      const copy = node.cloneNode(true);
      for (const field of copy.querySelectorAll("input,textarea,select")) field.remove();
      return copy.textContent;
    };
    const buttonTypes = ["submit", "button", "reset", "image"];
    const roleOf = (element) => {
      const explicit = capped(raw(element.getAttribute("role")));
      if (explicit !== null) return explicit;
      if (element instanceof HTMLInputElement) {
        if (buttonTypes.includes(element.type)) return "button";
        if (element.type === "checkbox" || element.type === "radio") return element.type;
        if (element.type === "range") return "slider";
        if (element.type === "number") return "spinbutton";
        if (element.type === "search") return "searchbox";
        return "textbox";
      }
      if (element instanceof HTMLSelectElement) return element.multiple || element.size > 1 ? "listbox" : "combobox";
      if (element instanceof HTMLTextAreaElement) return "textbox";
      if (element instanceof HTMLAnchorElement) return "link";
      return element.tagName.toLowerCase();
    };
    // The first source of a name that has words, as the page has it.
    const sourceName = (element) => {
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
        .split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      if (labelledBy.length > 0) return raw(labelledBy.map(words).join(" "));
      const aria = raw(element.getAttribute("aria-label"));
      if (aria !== null) return aria;
      const labels = "labels" in element && element.labels ? Array.from(element.labels) : [];
      if (labels.length > 0) return raw(labels.map(words).join(" "));
      // A button's own words: its text, or an input button's site-authored value or alt text.
      if (element instanceof HTMLInputElement && buttonTypes.includes(element.type))
        return raw(element.type === "image" ? element.getAttribute("alt") : element.getAttribute("value"));
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement))
        return raw(words(element)) ?? raw(element.getAttribute("title"));
      return raw(element.getAttribute("title"));
    };
    // The name, or null when it is longer than the limit: never cut, and never a later source's.
    const nameOf = (element) => capped(sourceName(element));
    const selector = 'input:not([type="hidden"]), select, textarea, button, a[href], [role~="button"], [role~="link"], [role~="checkbox"], [role~="radio"], [role~="switch"], [role~="tab"], [role~="menuitem"], [role~="option"], [role~="textbox"], [role~="combobox"]';
    const found = Array.from(document.querySelectorAll(selector));
    // Rank every control before keeping any: visible first, then enabled fields, required first.
    const ranked = found.map((element, order) => {
      const box = element.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true });
      const enabled = !element.matches(":disabled") && element.closest('[aria-disabled="true"], [inert]') === null;
      const field = element instanceof HTMLInputElement ? !buttonTypes.includes(element.type) : element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
      const required = element.required === true || element.getAttribute("aria-required") === "true";
      const rank = (visible ? 0 : 4) + (field && enabled ? 0 : 2) + (required ? 0 : 1);
      return { element, order, rank, visible, enabled, required };
    });
    ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
    const controls = ranked.slice(0, limit).map(({ element, rank, visible, enabled, required }) => ({
      rank,
      role: roleOf(element),
      name: nameOf(element),
      type: element instanceof HTMLInputElement ? element.type : null,
      required,
      visible,
      enabled,
    }));
    return { controls, total: found.length };
  };
  const controls = [];
  let total = 0;
  for (const frame of primary.frames()) {
    const found = await frame
      .evaluate(read, { limit: ${pageControlsLimit}, textLimit: ${pageControlTextLimit} })
      .catch(() => null);
    if (found === null) continue;
    controls.push(...found.controls);
    total += found.total;
  }
  // Across frames by the same rank, each frame's in page order and frames in tree order.
  const kept = controls
    .map((control, order) => ({ control, order }))
    .sort((left, right) => left.control.rank - right.control.rank || left.order - right.order)
    .slice(0, ${pageControlsLimit})
    .map(({ control: { rank, ...control } }) => control);
  return { controls: kept, total };
};
`;

/** The longest role and name the minter is shown; longer ones are cut, after screening. */
const shownRole = 40;
const shownName = 120;

/** Text as the minter reads it: whitespace collapsed and cut to `length`, or null when empty. */
const shown = (value: string | null, length: number) => {
  const text = value?.replace(/\s+/g, " ").trim().slice(0, length) ?? "";
  return text === "" ? null : text;
};

/**
 * The controls as the minter reads them, from controls already screened for typed values: each
 * role its first word, and each name in single spaces and at most 120 characters. Screen before
 * this, never after: cutting a name first can leave part of a typed value no screening finds.
 */
export const presentControls = (screened: PageControls): PageControls => ({
  total: screened.total,
  controls: screened.controls.map((control) => ({
    ...control,
    role: shown(control.role.trim().split(/\s+/)[0] ?? "", shownRole) ?? "generic",
    name: shown(control.name, shownName),
  })),
});

/** Where the host saves the controls it found after a sign-in step's submit, in the workspace. */
export const afterSubmitPath = (step: number) => `captures/after-submit/${step}.json`;

/** At most this many controls go inline in a failed step's result. */
export const inlineControlsLimit = 30;

/**
 * The controls saved after the last submit, for a failed step's result: at most
 * `inlineControlsLimit`, with a note naming the file that holds the rest.
 */
export const inlineControls = (path: string, saved: PageControls) => ({
  path,
  controls: saved.controls.slice(0, inlineControlsLimit),
  ...(saved.total > inlineControlsLimit
    ? {
        truncated: `Showing ${inlineControlsLimit} of ${saved.total} controls; read ${path} for more.`,
      }
    : {}),
});
