import { Effect, Schema } from "effect";
import { primaryPageCode } from "../runtime/host-execute.js";
import { hostOnSiteSource, siteDomain } from "../runtime/same-site.js";
import { workspaceHost } from "../runtime/workspace-origin.js";
import type { AutofillPage } from "./autofill-step.js";
import {
  BoxKind,
  fingerprintOf,
  type ObservedState,
  type StateBox,
} from "./sign-in-states.js";

export { type ObservedBox, type ObservedState, stateAfter } from "./sign-in-states.js";

// The page as a sign-in state: one host call reads each visible box on a sign-in origin, by its
// frame's origin and the kind of value its own attributes say it takes, never its value. Only a
// page with no empty box is told by text: its main message and its buttons, normalized on the
// host so no name, address or number is kept.

/**
 * A text as a state holds it, normalized here, never in the page, whose own code may change what
 * its string functions return: an address or a starred one becomes "@", a run of digits "#", of
 * stars or dots "*", and each word a name or a login may be "~": one with a capital, with "_" or
 * "." or a digit between its letters, in a script with no capitals, or one of the sign-in's own
 * `logins`, in any case. Lowercase, at most `limit` characters.
 */
const normalized = (text: string, limit: number, logins: ReadonlySet<string>) =>
  text
    .slice(0, 4_000)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\S*@\S*?(?=[.,;:!?)]*(?:\s|$))/gu, "@")
    .replace(/[*\u2022\u25cf\u00b7\u2219]+/gu, "*")
    .replace(/\p{Nd}+/gu, "#")
    .split(" ")
    .map((word) =>
      /[\p{Lu}\p{Lt}\p{Lo}]|[\p{L}#][._][\p{L}#]|\p{L}#|#\p{L}/u.test(word) ||
      logins.has(word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
        ? `~${/[.,;:!?)]*$/u.exec(word)?.[0] ?? ""}`
        : word,
    )
    .join(" ")
    .toLowerCase()
    .slice(0, limit);

/**
 * Page code, run in each frame: the visible boxes that take typing, with their kinds, whether each
 * holds a value, and whether a submit sits in its form; a row of one-character boxes is one code
 * box with its count. A box with no hint of its kind counts as an identifier only when required or
 * in a form that has a submit or another counted box; a search box never counts. With no empty
 * box, the first visible h1, else h2, heading, h3 or paragraph, and up to eight buttons; these
 * and every visible text outside a control (`texts`) as they stand, which the host normalizes.
 */
const scanFrame = `() => {
  const shows = (element) => {
    if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const box = element.getBoundingClientRect();
    return box.width >= 2 && box.height >= 2;
  };
  const attribute = (element, name) => (element.getAttribute(name) ?? "").toLowerCase();
  const named = (element, words) => {
    const own = attribute(element, "name") + " " + attribute(element, "id");
    return words.some((word) => own.includes(word));
  };
  const formOf = (element) => element.form ?? element.closest("form");
  // A search box: in a search landmark, named for a search or the usual q, or in a form that
  // sends to a search.
  const searching = (element) => {
    const form = formOf(element);
    return element.closest('search, [role="search" i]') !== null || named(element, ["search", "query"]) ||
      attribute(element, "name") === "q" || (form !== null && /(^|[^a-z])search/.test(attribute(form, "action")));
  };
  const notTyped = ["hidden", "submit", "button", "checkbox", "radio", "file", "image", "reset", "range", "color", "search"];
  const boxes = [...document.querySelectorAll("input, textarea")].filter((element) =>
    !notTyped.includes(attribute(element, "type")) && !element.disabled && !element.readOnly &&
    !searching(element) && shows(element));
  // Every submit of the form, a button with no type and one joined by its form attribute too.
  const submitIn = (form) => form !== null && [...form.elements].some((element) => element.type === "submit" && shows(element));
  const kindOf = (element) => {
    const type = attribute(element, "type");
    const auto = attribute(element, "autocomplete").split(/\\s+/);
    const numeric = attribute(element, "inputmode") === "numeric" || type === "number" || type === "tel";
    if (type === "password") return "password";
    if (auto.includes("one-time-code") || named(element, ["otp", "totp", "2fa", "mfa"])) return "code";
    if (auto.some((token) => token.startsWith("bday")) || type === "date") return "date_of_birth";
    // Before a code by its name, as a postal_code or zipcode box is named for a code too.
    if (auto.includes("postal-code") || named(element, ["zip", "postal"])) return "zip";
    if (named(element, ["code", "verification"]) && numeric && element.maxLength >= 4 && element.maxLength <= 8) return "code";
    if (type === "email" || type === "tel" || auto.some((token) => /^(username|email|tel)/.test(token)) ||
      named(element, ["email", "user", "login", "phone", "mobile"])) return "identifier";
    return undefined;
  };
  // One-character boxes in one parent, or each alone in its own wrapper in one parent.
  const rowOf = (element) => element.parentElement?.childElementCount === 1
    ? element.parentElement.parentElement : element.parentElement;
  const rows = new Map();
  for (const element of boxes.filter((box) => box.maxLength === 1)) {
    const row = rowOf(element);
    rows.set(row, [...(rows.get(row) ?? []), element]);
  }
  const found = [];
  const unhinted = [];
  for (const [, members] of rows)
    if (members.length >= 4 && members.length <= 12)
      found.push({ kind: "code", count: members.length, empty: members.every((box) => box.value === ""), submit: submitIn(formOf(members[0])), form: formOf(members[0]) });
  const inRows = new Set([...rows.values()].filter((members) => members.length >= 4 && members.length <= 12).flat());
  for (const element of boxes) {
    if (inRows.has(element)) continue;
    const kind = kindOf(element);
    const box = { kind: kind ?? "identifier", empty: element.value === "", submit: submitIn(formOf(element)), form: formOf(element) };
    if (kind === undefined) unhinted.push({ box, required: element.required });
    else found.push(box);
  }
  for (const { box, required } of unhinted)
    if (required || box.submit || found.some((other) => other.form !== null && other.form === box.form)) found.push(box);
  // Every visible text of its own outside a control, normalized: what is new after a press tells a
  // notice the site showed beside the same boxes. Text is read by the block it sits in, so a name
  // in an inline element of its own, as "Not <b>Sam</b>?", is masked as within the sentence.
  const blockOf = (element) => {
    let block = element;
    while (block.parentElement !== null && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    return block;
  };
  const own = new Map();
  let last;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || parent.closest('script, style, noscript, template, button, a, label, option, select, textarea, [role="button" i]') !== null || !shows(parent)) continue;
    const block = blockOf(parent);
    if (!own.has(block)) {
      if (node.textContent.trim() === "") continue;
      if (own.size >= 40) break;
      own.set(block, "");
    }
    // A block's text on both sides of a block inside it reads as two words, not one.
    own.set(block, own.get(block) + (last === block ? "" : " ") + node.textContent);
    last = block;
  }
  const result = { boxes: found.map(({ form, ...box }) => box), texts: [...own.values()].map((text) => text.slice(0, 2000)) };
  if (found.some((box) => box.empty)) return result;
  const message = ["h1", "h2", '[role="heading" i]', "h3", "p"]
    .map((selector) => [...document.querySelectorAll(selector)].find((element) => shows(element) && element.innerText.trim() !== ""))
    .find((element) => element !== undefined);
  const buttons = [...document.querySelectorAll('button, [role="button" i], input[type="submit" i], input[type="button" i]')]
    .filter(shows)
    .map((element) => (element.getAttribute("aria-label") || element.innerText || element.value || "").slice(0, 500))
    .filter((label) => label.trim() !== "")
    .slice(0, 8);
  return { ...result, ...(message === undefined ? {} : { message: message.innerText.slice(0, 2000) }), buttons };
}`;

/** One host call over the primary tab's frames on the site or a configured sign-in origin. */
const scanCode = (targetId: string, siteHost: string, authenticationOrigins: readonly string[]) =>
  `${primaryPageCode(targetId)}
const onSiteHost = ${hostOnSiteSource(siteHost)};
const authenticationOrigins = ${JSON.stringify(authenticationOrigins)};
// A frame's own address, or for an about:blank or about:srcdoc frame, the first one above it with
// a real address.
const frameAddress = (frame) => {
  let scope = frame;
  while (scope !== null && ["about:blank", "about:srcdoc"].includes(scope.url())) scope = scope.parentFrame();
  return scope === null ? "" : scope.url();
};
const signInOrigin = (address) => {
  let url;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  return onSiteHost(url.hostname) || authenticationOrigins.includes(url.origin) ? url.origin : undefined;
};
const frameShows = async (frame) => {
  for (let scope = frame; scope.parentFrame() !== null; scope = scope.parentFrame())
    if (!(await (await scope.frameElement()).isVisible())) return false;
  return true;
};
const frames = [];
for (const frame of primary.frames()) {
  try {
    const origin = signInOrigin(frameAddress(frame));
    if (origin === undefined || !(await frameShows(frame))) continue;
    frames.push({ origin, ...(await frame.evaluate(${scanFrame})) });
  } catch {
    // A frame the host cannot read, such as one that detaches during the scan, shows nothing.
    continue;
  }
}
return { url: primary.url(), frames };`;

const ScannedBox = Schema.Struct({
  kind: BoxKind,
  count: Schema.optional(Schema.Int.pipe(Schema.between(2, 12))),
  empty: Schema.Boolean,
  submit: Schema.Boolean,
});
const Scan = Schema.Struct({
  url: Schema.String,
  frames: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      boxes: Schema.Array(ScannedBox),
      texts: Schema.Array(Schema.String),
      message: Schema.optional(Schema.String),
      buttons: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

/**
 * Reads the page as a sign-in state (see `scanFrame`). A frame or the top page on a workspace host
 * of the tool's relation, other than the site's own origin, reads as `workspace`. A word of any
 * text that is one of the sign-in's own `identifiers`, or an address's part before "@", is masked
 * as a name is. Undefined when the page could not be read, or its top page is no web page.
 */
export const observeSignInState = (input: {
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly workspace?: { readonly parent: string } | undefined;
  readonly identifiers?: readonly string[] | undefined;
}): Effect.Effect<ObservedState | undefined> =>
  input.page
    .execute(
      scanCode(
        input.page.targetId,
        siteDomain(input.siteOrigin) ?? URL.parse(input.siteOrigin)?.hostname ?? "",
        input.authenticationOrigins,
      ),
      15,
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(Scan)),
      Effect.map((scan) => {
        const top = URL.parse(scan.url)?.origin;
        if (top === undefined || top === "null") return undefined;
        const { workspace, siteOrigin } = input;
        const logins = new Set(
          (input.identifiers ?? []).flatMap((identifier) => {
            const login = identifier.trim().toLowerCase();
            return login === "" ? [] : [login, login.split("@")[0] ?? login].filter((part) => part !== "");
          }),
        );
        const named = (origin: string) =>
          workspace !== undefined && origin !== siteOrigin && workspaceHost(siteOrigin, workspace.parent, origin)
            ? "workspace"
            : origin;
        const boxes = scan.frames.flatMap((frame) =>
          frame.boxes.slice(0, 200).map((box) => ({ frame: named(frame.origin), ...box })),
        );
        const written = (box: (typeof boxes)[number]): StateBox => ({
          frame: box.frame,
          kind: box.kind,
          ...(box.count === undefined ? {} : { count: box.count }),
        });
        // At most the 24 empty boxes a `StateFingerprint` holds, so a long form, such as an account
        // page's, still reads as a state a library can keep.
        const empty = boxes.filter((box) => box.empty).slice(0, 24);
        const told = empty.length > 0 ? undefined : scan.frames.find((frame) => frame.message !== undefined || (frame.buttons ?? []).length > 0);
        const buttons = (told?.buttons ?? []).slice(0, 8).map((label) => normalized(label, 120, logins));
        return {
          fingerprint: fingerprintOf({
            top: named(top),
            boxes: empty.map(written),
            submit: empty.some((box) => box.submit),
            ...(told?.message === undefined ? {} : { message: normalized(told.message, 200, logins) }),
            ...(told === undefined ? {} : { buttons: buttons.filter((label) => label !== "") }),
          }),
          boxes: boxes.map((box) => ({ ...written(box), empty: box.empty, submit: box.submit })),
          texts: [
            ...new Set(
              scan.frames.flatMap((frame) => frame.texts.slice(0, 40).map((text) => normalized(text, 200, logins))),
            ),
          ]
            .filter((text) => text.length >= 2)
            .slice(0, 40),
        };
      }),
      Effect.orElseSucceed(() => undefined),
    );
