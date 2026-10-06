import { randomUUID } from "node:crypto";
import { opaqueOrigins } from "./autofill-refusal.js";

/**
 * The primary page's window key for what each step call found, the same for every call of this
 * host process. Random, like the guard's, so it is no fixed name a page could define first; a
 * main-world page can still find it once a call set it.
 */
const judgmentKey = `__pomerado_judgment_${randomUUID()}`;

/**
 * Page code: `where` reads a URL as the host judges it, never its query, fragment or credentials,
 * in any of which page code may have put a typed value: a frame by its origin,
 * a form or link destination by its origin and path, which the request watch counts, and an opaque
 * one by a fixed name, the host's own (`opaqueOrigins`), else `other:`. Credentials are never
 * trusted, so only that a URL has them leaves the page.
 */
const whereCode = `const opaqueNames = ${JSON.stringify(opaqueOrigins)};
const where = (address, path) => {
  let url;
  try {
    url = new URL(address);
  } catch {
    return "invalid";
  }
  if (url.origin === "null") {
    const name = url.protocol === "about:" ? "about:" + url.pathname : url.protocol;
    return opaqueNames.includes(name) ? name : "other:";
  }
  if (url.protocol === "blob:") return "blob:" + url.origin;
  const credentials = url.username !== "" || url.password !== "" ? "credentials@" : "";
  return url.protocol + "//" + credentials + url.host + (path ? url.pathname : "");
};
`;

/**
 * Page code: `keep` holds what a call found in the primary page's window, under the host's
 * per-process key and an id the host chose, and `kept` reads it back, or null once the page lost
 * it (the window was replaced, or a later call's finding pushed it out). A later call compares
 * against it by id, so no call's code holds an address the page supplied.
 */
const keptCode = `const judgmentKey = ${JSON.stringify(judgmentKey)};
const keep = (id, record) =>
  primary
    .mainFrame()
    .evaluate(([key, id, record]) => {
      let kept = window[key];
      if (!(kept instanceof Map)) {
        kept = new Map();
        Object.defineProperty(window, key, { value: kept, configurable: true });
      }
      kept.set(id, record);
      for (const old of kept.keys()) if (kept.size > 32) kept.delete(old);
    }, [judgmentKey, id, record])
    .catch(() => undefined);
const kept = (id) =>
  id === null
    ? Promise.resolve(null)
    : primary
        .mainFrame()
        .evaluate(([key, id]) => (window[key] instanceof Map ? window[key].get(id) ?? null : null), [judgmentKey, id])
        .catch(() => null);
`;

/**
 * Page code: `locate` finds a selector's one visible match across the primary tab's frames. Where
 * it sits is read from the element itself, never from the frame the search started in: its own
 * frame (or the first one above it with a real URL) and its document's origin. It also reads every
 * form action and method it could submit with, its link destination, shape and words that label
 * it, never its value. Every URL leaves only as `where` reads it; the destinations as found stay
 * in the page (`destinations`), for the guard. For the host's evidence it says which frame matched
 * and how many it searched, or, with no one visible match, each frame that matched and how often.
 */
const findCode = `const clip = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\\s+/g, " ").slice(0, 200) : null);
const locate = async (selector) => {
  const visible = [];
  const frames = primary.frames();
  const matches = [];
  for (const frame of frames) {
    const located = frame.locator(selector);
    const count = await located.count();
    const match = { frameUrl: where(frame.url(), false), count, visible: 0 };
    if (count > 0) matches.push(match);
    if (count > 100) return { error: "ambiguous_match", searched: { frames: frames.length, matches } };
    for (let index = 0; index < count; index++)
      if (await located.nth(index).isVisible()) {
        match.visible++;
        visible.push({ frame, locator: located.nth(index) });
      }
  }
  if (visible.length !== 1)
    return { error: visible.length === 0 ? "not_found" : "ambiguous_match", searched: { frames: frames.length, matches } };
  const [{ frame, locator }] = visible;
  const handle = await locator.elementHandle();
  let owner = handle ? await handle.ownerFrame() : null;
  while (owner && ["about:blank", "about:srcdoc"].includes(owner.url())) owner = owner.parentFrame();
  const found = await locator.evaluate((element) => {
    const associated =
      "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
    // Read through the form's own getters: a control named "action", "method" or "elements"
    // shadows the property of that name on the form itself.
    const formProperty = (name) =>
      Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(associated);
    const actions = associated ? [formProperty("action")] : [];
    const methods = associated ? [formProperty("method")] : [];
    // A link-style sign-in action may navigate instead of submitting its containing form.
    const href = element instanceof HTMLAnchorElement ? element.getAttribute("href") : null;
    if (href !== null) actions.push(new URL(href, document.baseURI).href);
    for (const control of associated ? Array.from(formProperty("elements")) : [element]) {
      const action = control.getAttribute("formaction");
      if (action !== null) actions.push(new URL(action, document.baseURI).href);
      const method = control.getAttribute("formmethod");
      if (method !== null) methods.push(method.toLowerCase());
    }
    // The method a submission with it as the submitter goes by, as the browser reads it: a submit
    // button's own formmethod, else its form's. Another control's, such as a "Forgot password"
    // button's, says nothing of it.
    const submitter =
      (element instanceof HTMLButtonElement && element.type === "submit") ||
      (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type));
    const submitMethod = associated
      ? submitter && element.hasAttribute("formmethod")
        ? element.formMethod
        : formProperty("method")
      : null;
    // Disabled, which a page may undo once the fields hold input, and inert, which takes no
    // interaction at all, as an inactive or background form does.
    const disabled = element.matches(":disabled") || element.closest('[aria-disabled="true"]') !== null;
    const inert = element.closest("[inert]") !== null;
    const editable =
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      !disabled && !inert && !element.readOnly;
    // Only whether it holds a value leaves the page, never the value.
    const empty =
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.value === "";
    const labels = "labels" in element && element.labels ? Array.from(element.labels) : [];
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    const words = (node) => {
      const copy = node.cloneNode(true);
      for (const field of copy.querySelectorAll("input,textarea,select")) field.remove();
      return copy.textContent;
    };
    return {
      disabled,
      inert,
      target: { documentOrigin: self.origin, actions, methods, submitMethod, editable, empty },
      described: {
        role: element.getAttribute("role"),
        formMethod: methods.join(",") || null,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        name: element.getAttribute("name"),
        id: element.getAttribute("id"),
        autocomplete: element.getAttribute("autocomplete"),
        inputmode: element.getAttribute("inputmode"),
        label: [...labels, ...labelledBy].map(words).join(" "),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
        text: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? null : element.textContent,
      },
    };
  });
  const described = Object.fromEntries(Object.entries(found.described).map(([key, value]) => [key, key === "tag" ? value : clip(value)]));
  const shape = await formControlShape(locator);
  const control =
    (found.disabled || found.inert) && (shape === "select" || shape === "combobox") ? "other" : shape;
  return {
    locator,
    disabled: found.disabled,
    inert: found.inert,
    target: {
      ...found.target,
      ownerUrl: owner ? where(owner.url(), false) : null,
      actions: found.target.actions.map((action) => where(action, true)),
      control,
    },
    destinations: found.target.actions,
    described,
    located: { frameUrl: where(frame.url(), false), frames: frames.length },
  };
};
`;

/**
 * A selector that reaches into another frame (`>>` chains, Playwright's `internal:` engines such as
 * `internal:control=enter-frame`) is never run: each control is found in its own frame.
 */
export const frameCrossing = (selector: string) =>
  selector.includes(">>") || selector.includes("internal:");
export const unsupportedSelector = (step: {
  readonly fields: readonly { readonly selector: string }[];
  readonly submit?: string | undefined;
}) => {
  const index = step.fields.findIndex((field) => frameCrossing(field.selector));
  if (index !== -1) return index;
  return step.submit !== undefined && frameCrossing(step.submit) ? ("submit" as const) : undefined;
};

/**
 * The page code every step call starts with, after `formControlsCode` and with `primary` bound:
 * `where`, `keep` and `kept`, and `locate`.
 */
export const locateCode = `${whereCode}${keptCode}${findCode}`;
