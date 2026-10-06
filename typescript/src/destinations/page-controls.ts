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
 * Page code, with `primary` bound: `pageControls()` reads every frame's form controls, buttons
 * and links as `PageControl`s, or null when the page cannot be read. Values never leave the page.
 */
export const pageControlsCode = `const pageControls = async () => {
  const read = (limit) => {
    const clip = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\\s+/g, " ").slice(0, 120) : null);
    // A label's own words, without the text of any control inside it.
    const words = (node) => {
      const copy = node.cloneNode(true);
      for (const field of copy.querySelectorAll("input,textarea,select")) field.remove();
      return copy.textContent;
    };
    const buttonTypes = ["submit", "button", "reset", "image"];
    const roleOf = (element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit.split(/\\s+/)[0];
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
    const nameOf = (element) => {
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
        .split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      if (labelledBy.length > 0) return clip(labelledBy.map(words).join(" "));
      const aria = clip(element.getAttribute("aria-label"));
      if (aria !== null) return aria;
      const labels = "labels" in element && element.labels ? Array.from(element.labels) : [];
      if (labels.length > 0) return clip(labels.map(words).join(" "));
      // A button's own words: its text, or an input button's site-authored value or alt text.
      if (element instanceof HTMLInputElement && buttonTypes.includes(element.type))
        return clip(element.type === "image" ? element.getAttribute("alt") : element.getAttribute("value"));
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement))
        return clip(words(element)) ?? clip(element.getAttribute("title"));
      return clip(element.getAttribute("title"));
    };
    const selector = 'input:not([type="hidden"]), select, textarea, button, a[href], [role~="button"], [role~="link"], [role~="checkbox"], [role~="radio"], [role~="switch"], [role~="tab"], [role~="menuitem"], [role~="option"], [role~="textbox"], [role~="combobox"]';
    const found = Array.from(document.querySelectorAll(selector));
    const controls = found.slice(0, limit).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        role: roleOf(element),
        name: nameOf(element),
        type: element instanceof HTMLInputElement ? element.type : null,
        required: element.required === true || element.getAttribute("aria-required") === "true",
        visible: box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true }),
        enabled: !element.matches(":disabled") && element.closest('[aria-disabled="true"], [inert]') === null,
      };
    });
    return { controls, total: found.length };
  };
  const controls = [];
  let total = 0;
  for (const frame of primary.frames()) {
    const found = await frame.evaluate(read, ${pageControlsLimit}).catch(() => null);
    if (found === null) continue;
    controls.push(...found.controls);
    total += found.total;
  }
  // Visible controls first, each group in page order.
  const ordered = [...controls.filter((control) => control.visible), ...controls.filter((control) => !control.visible)];
  return { controls: ordered.slice(0, ${pageControlsLimit}), total };
};
`;

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
