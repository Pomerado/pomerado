import { Effect, Schema } from "effect";
import { primaryPageCode } from "../runtime/host-execute.js";
import { hostOnSiteSource, siteDomain } from "../runtime/same-site.js";
import { workspaceHost } from "../runtime/workspace-origin.js";
import { namedForCodeCode } from "../runtime/autofill-unrecorded-code.js";
import { choicesCode, codeRowCode } from "./autofill-page-code.js";
import type { AutofillPage } from "./autofill-step.js";
import {
  blankFingerprint,
  BoxKind,
  BoxTakes,
  fingerprintOf,
  type ObservedState,
  type StateBox,
} from "./sign-in-states.js";

export { type ObservedBox, type ObservedState, stateAfter } from "./sign-in-states.js";

// The page as a sign-in state: one host call reads each visible box on a sign-in origin, by its
// frame's origin and the kind of value its own attributes say it takes, never its value, a code
// box by its role and its labels too, and an identifier box by whether it takes an email, a phone
// or either. A page with no empty box is told by text: its main message and its buttons,
// normalized on the host so no name, address or number is kept, as a code box's labels are, save
// a lone number of one or two digits, a box's place. A page with boxes keeps its instruction and
// the ways it offers, normalized alike, which only order states of one look.

/**
 * A text as a state holds it, normalized here, never in the page, whose own code may change what
 * its string functions return: a run of digits becomes "#", of stars or dots "*", a word with an
 * address or a starred one "@", and each word a name or a login may be "~": one with a capital,
 * with "_" or "." or a digit between its letters, a star beside a letter, in a script with no
 * capitals, or holding one of the sign-in's own `logins` of three characters or more as a whole
 * part between other characters, in any case. Lowercase, at most `limit` characters.
 */
const normalized = (text: string, limit: number, logins: readonly string[]) =>
  text
    .slice(0, 4_000)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[*\u2022\u25cf\u00b7\u2219]+/gu, "*")
    .replace(/\p{Nd}+/gu, "#")
    .split(" ")
    .map((word) => {
      let cut = word.length;
      while (cut > 0 && ".,;:!?)".includes(word[cut - 1] ?? "")) cut -= 1;
      const end = word.slice(cut);
      if (word.includes("@")) return `@${end}`;
      const bare = word.replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase();
      const parts = bare.split(/[^\p{L}\p{N}]+/u);
      return /[\p{Lu}\p{Lt}\p{Lo}]|[\p{L}#][._][\p{L}#]|\p{L}#|#\p{L}|\p{L}\*|\*\p{L}/u.test(word) ||
        logins.some((login) => (/^[\p{L}\p{N}]+$/u.test(login) ? parts.includes(login) : bare.includes(login)))
        ? `~${end}`
        : word;
    })
    .join(" ")
    .toLowerCase()
    .slice(0, limit);

/**
 * Page code, run in each frame: the visible boxes that take typing, with their kinds, whether each
 * holds a value, and whether a submit sits in its form; a row of one-character boxes is one code
 * box with its count. A code box also gives its role, its own or else its type's, and the labels
 * of its boxes (`labels`): each one's `aria-label`, else its label elements' text, else its
 * placeholder. An identifier box gives what it takes (`takes`): an email, a phone, either, or
 * neither said, by its type, input mode and autocomplete and the words of its labels and
 * placeholder, never its name or id, which a page may give for its layout. A box with no hint of
 * its kind counts as an identifier only when required or in a form that has a submit or another
 * counted box; a search box never counts. With no empty box, the first visible h1, else h2,
 * heading, h3 or paragraph, and up to eight buttons, and those of the modal dialog it shows
 * (`dialog`), as a covering notice's are read (`coveringCode` in autofill-page-code.ts); with one,
 * that same text as its instruction and up to twelve buttons and links as its ways; these and
 * every visible text outside a control (`texts`) as they stand, which the host normalizes.
 *
 * A code's row is also one by the rule a fill reads a code's boxes by (`codeRowCode`), where the
 * one-parent rule above finds none: four to twelve one-character boxes of one form, or of the
 * document or shadow root outside one, as boxes split three and three or set apart by a separator
 * are; or as many boxes the page's script holds to one character each, side by side on one line;
 * or such a row whose first box alone takes typing, the page switching each later one on in turn.
 * A box named for a code (`namedForCodeCode`) is a code box too. Each is read so only where the
 * rule before it read each of its boxes alike, as code boxes, or as identifier boxes taking one
 * kind, counted as they were; a code box read where the rule before read identifier boxes says
 * what they took (`takes`), so a look read before compares with it (`sameFingerprint`).
 *
 * A picture code box, a site's own picture CAPTCHA on a sign-in form, which a gate fills and no
 * step ever names, reads as the rule before read it with role `captcha`, so a look that shows it
 * pairs with one that doesn't (`sameFingerprint`). A frame with no box that takes typing reads a
 * code picked from four or more named checkboxes in one container, as a code step's choices are
 * read (`choicesCode`), as a code box with role `checkbox`, empty while none is ticked, and tells
 * itself as a page with no box too. A page with no box reads apart from each notice, a dialog,
 * region or aside, that holds one of the `dismissed` controls, as it reads apart from a modal
 * dialog (`dialog`).
 *
 * With `deep`, it reads each open shadow root too, as inspect and fill walk them, page order
 * first; without, a frame that shows nothing says whether it holds one (`shadowed`).
 */
const scanFrame = `({ deep, dismissed }) => {
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
  const roots = [document];
  if (deep)
    for (const root of roots)
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot !== null) roots.push(element.shadowRoot);
  const all = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  // A search box: in a search landmark, named for a search or the usual q, or in a form that
  // sends to a search.
  const searching = (element) => {
    const form = formOf(element);
    return element.closest('search, [role="search" i]') !== null || named(element, ["search", "query"]) ||
      attribute(element, "name") === "q" || (form !== null && /(^|[^a-z])search/.test(attribute(form, "action")));
  };
  const notTyped = ["hidden", "submit", "button", "checkbox", "radio", "file", "image", "reset", "range", "color", "search"];
  const boxes = all("input, textarea").filter((element) =>
    !notTyped.includes(attribute(element, "type")) && !element.disabled && !element.readOnly &&
    !searching(element) && shows(element));
  // A picture code box, a site's own picture CAPTCHA on a sign-in form, as a gate that fills one
  // reads it: a text box named for a captcha, a picture, image, graphic or verification code, in a
  // form with a password box, and a picture beside it in that form, outside the page's chrome.
  const chrome = "header, nav, footer, aside, [role=banner], [role=navigation], [role=search], [role=contentinfo], [role=complementary]";
  const captcha = /(?<!re|h-?|fun|frc-|no)[ck]aptcha|(?:picture|image|graphic|verification)[ _-]?code/i;
  const pictureCode = (element) => {
    if (element.tagName !== "INPUT" || element.type !== "text" || element.form === null ||
      !boxes.some((other) => other.type === "password" && other.form === element.form) ||
      ![element.id, element.name, element.placeholder, element.getAttribute("aria-label"),
        ...[...(element.labels ?? [])].map((label) => label.textContent)].some((name) => captcha.test(name ?? "")))
      return false;
    const near = element.getBoundingClientRect();
    return [...element.form.querySelectorAll("*")].some((picture) => {
      const at = picture.getBoundingClientRect();
      return at.width >= 40 && at.height >= 15 && !picture.contains(element) &&
        Math.max(0, at.left - near.right, near.left - at.right) <= 2 * near.height &&
        Math.max(0, at.top - near.bottom, near.top - at.bottom) <= near.height &&
        shows(picture) && picture.closest(chrome) === null && picture.closest("[inert], [aria-hidden=true]") === null &&
        (picture.matches("img, canvas, svg") || (!picture.matches("input, select, textarea") &&
          picture.querySelector("input, select, textarea") === null && getComputedStyle(picture).backgroundImage.includes("url(")));
    });
  };
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
  const takesOf = (element) => {
    const type = attribute(element, "type");
    const mode = attribute(element, "inputmode");
    const auto = attribute(element, "autocomplete").split(/\\s+/);
    const root = element.getRootNode();
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\\s+/)
      .map((id) => (id === "" ? "" : (root.getElementById?.(id) ?? document.getElementById(id))?.innerText ?? ""));
    const words = [element.getAttribute("aria-label") ?? "", ...labelledBy, ...[...(element.labels ?? [])].map((label) => label.innerText),
      element.getAttribute("placeholder") ?? ""].join(" ").toLowerCase().slice(0, 1000);
    const email = type === "email" || mode === "email" || auto.includes("email") || /e-?mail|correo|courriel/.test(words);
    const phone = type === "tel" || mode === "tel" || auto.some((token) => token.startsWith("tel")) ||
      /phone|mobil|(^|[^a-z])cell|t[e\\u00e9]l[e\\u00e9]f|m[o\\u00f3]vil|celular/.test(words);
    return email ? (phone ? "email_or_phone" : "email") : phone ? "phone" : "other";
  };
  const roleOf = (element) => {
    const own = attribute(element, "role");
    return /^[a-z]{1,20}$/.test(own) ? own : attribute(element, "type") === "number" ? "spinbutton" : "textbox";
  };
  const labelOf = (element) => (element.getAttribute("aria-label") ||
    [...(element.labels ?? [])].map((label) => label.innerText).join(" ") || element.getAttribute("placeholder") || "").slice(0, 200);
  const codeRow = (members) => ({ kind: "code", count: members.length, role: roleOf(members[0]), labels: members.map(labelOf), empty: members.every((box) => box.value === ""), submit: submitIn(formOf(members[0])), form: formOf(members[0]) });
  // One-character boxes in one parent, or each alone in its own wrapper in one parent.
  const rowOf = (element) => element.parentNode?.childElementCount === 1
    ? element.parentNode.parentNode : element.parentNode;
  const rows = new Map();
  for (const element of boxes.filter((box) => box.maxLength === 1)) {
    const row = rowOf(element);
    rows.set(row, [...(rows.get(row) ?? []), element]);
  }
  const found = [];
  const unhinted = [];
  for (const [, members] of rows)
    if (members.length >= 4 && members.length <= 12) found.push(codeRow(members));
  const inRows = new Set([...rows.values()].filter((members) => members.length >= 4 && members.length <= 12).flat());
  const left = boxes.filter((element) => !inRows.has(element));
  // A code's row by the rule a fill reads its boxes by, of boxes the rule before read alike.
  const oneLine = (members) => {
    const first = members[0].getBoundingClientRect();
    return members.every((box) => {
      const { top, height } = box.getBoundingClientRect();
      return top + height / 2 >= first.top && top + height / 2 <= first.bottom;
    });
  };
  const grouped = new Set();
  for (const element of left) {
    if (grouped.has(element)) continue;
    const row = (${codeRowCode})(element, true, 12);
    const members = (row?.boxes ?? []).filter((box) => left.includes(box) && !grouped.has(box));
    if (members.length < 4 || members.length > 12 || (row.limit === "script" && !oneLine(members))) continue;
    const kinds = new Set(members.map((box) => kindOf(box) ?? "none"));
    const [kind] = kinds;
    if (kinds.size !== 1 || !["code", "identifier", "none"].includes(kind) ||
      (kind !== "code" && new Set(members.map(takesOf)).size !== 1) ||
      (kind === "none" && new Set(members.map((box) => box.required)).size !== 1))
      continue;
    for (const box of members) grouped.add(box);
    const box = { ...codeRow(members), ...(kind === "code" ? {} : { takes: takesOf(members[0]) }) };
    if (kind === "none") unhinted.push({ box, required: members[0].required, at: boxes.indexOf(members[0]) });
    else found.push(box);
  }
  // A row the page switches on box by box: its first box takes typing, and each later one is off.
  for (const element of left) {
    if (grouped.has(element) || element.maxLength !== 1) continue;
    const members = (${codeRowCode})(element, false, 12, true)?.boxes ?? [];
    const kind = kindOf(element) ?? "none";
    if (members.length < 4 || members.length > 12 || members[0] !== element ||
      !members.slice(1).every((box) => box.disabled) || !["code", "identifier", "none"].includes(kind))
      continue;
    grouped.add(element);
    const box = { ...codeRow(members), ...(kind === "code" ? {} : { takes: takesOf(element) }) };
    if (kind === "none") unhinted.push({ box, required: element.required, at: boxes.indexOf(element) });
    else found.push(box);
  }
  for (const element of left) {
    if (grouped.has(element)) continue;
    const kind = kindOf(element);
    const pictured = pictureCode(element);
    // A box named for a code that the rule before read as an identifier, or as none said; a picture
    // code box reads as the rule before read it, marked by its role.
    const box = (kind === undefined || kind === "identifier") && !pictured && (${namedForCodeCode})(element)
      ? { kind: "code", role: roleOf(element), labels: [labelOf(element)], takes: takesOf(element), empty: element.value === "", submit: submitIn(formOf(element)), form: formOf(element) }
      : { kind: kind ?? "identifier", ...(kind === "code" ? { role: roleOf(element), labels: [labelOf(element)] } : {}),
        ...((kind ?? "identifier") === "identifier" ? { takes: takesOf(element) } : {}), ...(pictured ? { role: "captcha" } : {}),
        empty: element.value === "", submit: submitIn(formOf(element)), form: formOf(element) };
    if (kind === undefined) unhinted.push({ box, required: element.required, at: boxes.indexOf(element) });
    else found.push(box);
  }
  for (const { box, required } of unhinted.sort((a, b) => a.at - b.at))
    if (required || box.submit || found.some((other) => other.form !== null && other.form === box.form)) found.push(box);
  // A code picked from named checkboxes, on a frame with no box that takes typing: each widest
  // container the old step reads such a code from (\`choicesCode\`) that holds four or more.
  const checkboxes = 'input[type="checkbox"], [role="checkbox"]';
  const choices = boxes.length === 0 ? all(checkboxes).filter(shows) : [];
  if (choices.length >= 4 && choices.length <= 60)
    for (const choice of choices) {
      if (found.some((box) => box.grid?.contains(choice))) continue;
      let grid;
      for (let at = choice.parentElement; at !== null && at.querySelectorAll(checkboxes).length <= 30; at = at.parentElement) {
        const read = (${choicesCode})(at);
        if (read !== null && read.choices.length >= 4) grid = { at, read };
        else if (grid !== undefined) break;
      }
      if (grid !== undefined)
        found.push({ kind: "code", role: "checkbox", labels: [labelOf(grid.at)], grid: grid.at, form: formOf(grid.at), submit: submitIn(formOf(grid.at)),
          empty: !grid.read.choices.some((each) => each.checked === true || each.getAttribute("aria-checked") === "true") });
    }
  // Every visible text of its own outside a control, which the host normalizes: what is new after
  // a press tells a notice the site showed beside the same boxes. Text is read by the block it sits
  // in, so a name in an inline element of its own, as "Not <b>Sam</b>?", is masked within the
  // sentence.
  const blockOf = (element) => {
    let block = element;
    while (block.parentElement !== null && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    return block;
  };
  const own = new Map();
  let last;
  let full = false;
  for (const root of roots) {
    if (full) break;
    const walker = document.createTreeWalker(root === document ? (document.body ?? document.documentElement) : root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || parent.closest('script, style, noscript, template, button, a, label, option, select, textarea, [role="button" i]') !== null || !shows(parent)) continue;
      const block = blockOf(parent);
      if (!own.has(block)) {
        if (node.textContent.trim() === "") continue;
        if (own.size >= 40) {
          full = true;
          break;
        }
        own.set(block, "");
      }
      // A block's text on both sides of a block inside it reads as two words, not one.
      own.set(block, own.get(block) + (last === block ? "" : " ") + node.textContent);
      last = block;
    }
  }
  const result = { boxes: found.map(({ form, grid, ...box }) => box), texts: [...own.values()].map((text) => text.slice(0, 2000)) };
  const headings = ["h1", "h2", '[role="heading" i]', "h3", "p"];
  const firstSaid = (within) => headings
    .map((selector) => within(selector).find((element) => shows(element) && element.innerText.trim() !== ""))
    .find((element) => element !== undefined)?.innerText.slice(0, 2000);
  const said = firstSaid(all);
  const controlText = (element) => (element.getAttribute("aria-label") || element.innerText || element.value || "").slice(0, 500);
  const pressed = 'button, [role="button" i], input[type="submit" i], input[type="button" i]';
  const buttonsIn = (within) => within(pressed).filter(shows).map(controlText).filter((label) => label.trim() !== "").slice(0, 8);
  // Each notice the library dismisses: the dialog, region or aside that holds a control it names.
  const notices = [...new Set((dismissed ?? []).map((control) =>
    control.closest('dialog, [role~="dialog"], [role~="alertdialog"], [role~="region"], aside')).filter((notice) => notice !== null))];
  const apart = (element) => notices.some((notice) => notice.contains(element));
  // The page as a look with no box reads it, and apart from what covers it.
  const told = () => {
    const buttons = buttonsIn(all);
    // The modal dialog shown, as a covering notice's is found: the last that holds no other shown,
    // and no notice the library dismisses; else the page outside each such notice.
    const modals = all('dialog[open], [role~="dialog"], [role~="alertdialog"], [aria-modal="true"]').filter((element) => shows(element) && !apart(element));
    const modal = modals.findLast((element) => !modals.some((other) => other !== element && element.contains(other)));
    const within = (selector) => (modal === undefined ? all(selector) : [...modal.querySelectorAll(selector)]).filter((element) => !apart(element));
    const [dialogSaid, dialogButtons] = modal === undefined && notices.length === 0 ? [undefined, []] : [firstSaid(within), buttonsIn(within)];
    const same = modal === undefined && dialogSaid === said && JSON.stringify(dialogButtons) === JSON.stringify(buttons);
    const dialog = (dialogSaid === undefined && dialogButtons.length === 0) || same
      ? {} : { dialog: { ...(dialogSaid === undefined ? {} : { message: dialogSaid }), buttons: dialogButtons } };
    const shadowed = !deep && said === undefined && buttons.length === 0 &&
      [...document.querySelectorAll("*")].some((element) => element.shadowRoot !== null);
    return { ...(said === undefined ? {} : { message: said }), buttons, ...dialog, ...(shadowed ? { shadowed } : {}) };
  };
  if (found.some((box) => box.empty)) {
    const ways = [];
    for (const element of all(pressed + ', a[href], [role="link" i]')) {
      if (ways.length >= 12) break;
      if (!shows(element)) continue;
      const label = controlText(element);
      if (label.trim() !== "") ways.push(label);
    }
    // A frame whose only boxes are codes picked from checkboxes is told as a page with no box too.
    return { ...result, ...(said === undefined ? {} : { instruction: said }), ways, ...(found.every((box) => box.grid !== undefined) ? told() : {}) };
  }
  return { ...result, ...told() };
}`;

/** One host call over the primary tab's frames on the site or a configured sign-in origin. */
const scanCode = (
  targetId: string,
  siteHost: string,
  authenticationOrigins: readonly string[],
  deep: boolean,
  dismiss: readonly string[],
) =>
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
  if (frames.length >= 20) break;
  try {
    const origin = signInOrigin(frameAddress(frame));
    if (origin === undefined || !(await frameShows(frame))) continue;
    // Each control the library dismisses a notice by that shows in this frame, at most five a selector.
    const dismissed = [];
    for (const selector of ${JSON.stringify(dismiss)}) {
      const located = frame.locator(selector);
      const count = await located.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index++) {
        const handle = await located.nth(index).elementHandle({ timeout: 1000 }).catch(() => null);
        if (handle !== null) dismissed.push(handle);
      }
    }
    try {
      frames.push({ ...(await frame.evaluate(${scanFrame}, { deep: ${deep}, dismissed })), origin });
    } finally {
      for (const handle of dismissed) await handle.dispose().catch(() => undefined);
    }
  } catch {
    // A frame the host cannot read, such as one that detaches during the scan, shows nothing.
    continue;
  }
}
return { url: primary.url(), frames };`;

const ScannedBox = Schema.Struct({
  kind: BoxKind,
  count: Schema.optional(Schema.Int.pipe(Schema.between(2, 12))),
  role: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  takes: Schema.optional(BoxTakes),
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
      instruction: Schema.optional(Schema.String),
      ways: Schema.optional(Schema.Array(Schema.String)),
      dialog: Schema.optional(
        Schema.Struct({ message: Schema.optional(Schema.String), buttons: Schema.Array(Schema.String) }),
      ),
      shadowed: Schema.optional(Schema.Boolean),
    }),
  ),
});

/**
 * Reads the page as a sign-in state (see `scanFrame`). A frame or the top page on a workspace host
 * of the tool's relation, other than the site's own origin, reads as `workspace`. A word of any
 * text that is one of the sign-in's own `identifiers`, or an address's part before "@", is masked
 * as a name is. Undefined when the page could not be read, or its top page is no web page.
 *
 * A page with no empty box that shows a modal dialog reads as that dialog, its heading as the
 * message and its buttons, and one with a notice that holds a control of `dismiss`, a library's
 * steps' own, reads apart from it; either keeps the page as read whole as its instruction and ways,
 * where a look with no box keeps neither otherwise, so a look read before compares with it
 * (`sameFingerprint`). A page whose only boxes are codes picked from checkboxes keeps the page as a
 * look with no box reads it as its instruction and ways alike; on a page with a box that takes
 * typing they never count. A page that reads as nothing at all, no box, message or button, is read
 * again through its open shadow roots (`deep`), as a page whose sign-in form sits in web components
 * shows nothing to a read of its document alone: no look ever read so is stored or matched.
 */
export const observeSignInState = (input: {
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly workspace?: { readonly parent: string } | undefined;
  readonly identifiers?: readonly string[] | undefined;
  readonly dismiss?: readonly string[] | undefined;
}): Effect.Effect<ObservedState | undefined> => {
  const scan = (deep: boolean) =>
    input.page
      .execute(
        scanCode(
          input.page.targetId,
          siteDomain(input.siteOrigin) ?? URL.parse(input.siteOrigin)?.hostname ?? "",
          input.authenticationOrigins,
          deep,
          [...new Set(input.dismiss ?? [])].slice(0, 8),
        ),
        15,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknown(Scan)));
  return scan(false)
    .pipe(
      Effect.flatMap((light) => {
        const read = readingOf(input, light);
        return read !== undefined && blankFingerprint(read.fingerprint) && light.frames.some((frame) => frame.shadowed === true)
          ? Effect.map(scan(true), (deep) => readingOf(input, deep))
          : Effect.succeed(read);
      }),
      Effect.orElseSucceed(() => undefined),
    );
};

/** The page as `scanFrame` read it in each frame, as a state (`observeSignInState`). */
const readingOf = (
  input: {
    readonly siteOrigin: string;
    readonly workspace?: { readonly parent: string } | undefined;
    readonly identifiers?: readonly string[] | undefined;
  },
  scan: typeof Scan.Type,
): ObservedState | undefined => {
  const top = URL.parse(scan.url)?.origin;
  if (top === undefined || top === "null") return undefined;
  const { workspace, siteOrigin } = input;
  const logins = (input.identifiers ?? [])
    .flatMap((identifier) => {
      const login = identifier.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim().toLowerCase();
      return [login, login.split("@")[0] ?? login];
    })
    .filter((login) => login.length >= 3);
  const frames = scan.frames.slice(0, 20);
  const named = (origin: string) =>
    workspace !== undefined && origin !== siteOrigin && workspaceHost(siteOrigin, workspace.parent, origin)
      ? "workspace"
      : origin;
  // A code picked from named checkboxes counts on a page that shows no box that takes typing.
  const picked = (box: (typeof frames)[number]["boxes"][number]) => box.kind === "code" && box.role === "checkbox";
  const typed = frames.some((frame) => frame.boxes.some((box) => !picked(box)));
  const kept = (frame: (typeof frames)[number]) => frame.boxes.slice(0, 200).filter((box) => !typed || !picked(box));
  const boxes = frames.flatMap((frame) => kept(frame).map((box) => ({ frame: named(frame.origin), ...box })));
  const written = (box: (typeof boxes)[number]): StateBox => {
    const label = (box.labels ?? [])
      .slice(0, 12)
      .map((text) => (/^[0-9]{1,2}$/u.test(text.trim()) ? text.trim() : normalized(text, 200, logins)))
      .filter((text) => text !== "")
      .join(" ")
      .slice(0, 200);
    return {
      frame: box.frame,
      kind: box.kind,
      ...(box.count === undefined ? {} : { count: box.count }),
      ...(box.role !== undefined && /^[a-z]{1,20}$/u.test(box.role) ? { role: box.role } : {}),
      ...(label === "" ? {} : { label }),
      ...(box.takes === undefined ? {} : { takes: box.takes }),
    };
  };
  // At most the 24 empty boxes a `StateFingerprint` holds, so a long form, such as an account
  // page's, still reads as a state a library can keep.
  const empty = boxes.filter((box) => box.empty).slice(0, 24);
  // A page whose only boxes are codes picked from checkboxes keeps the page as a look with no box
  // reads it as its instruction and ways, so a look read before such codes were read compares with
  // it (`sameFingerprint`).
  const pickedOnly = empty.length > 0 && empty.every(picked);
  const told =
    empty.length > 0 && !pickedOnly
      ? undefined
      : frames.find((frame) => frame.message !== undefined || (frame.buttons ?? []).length > 0);
  const pressed = (labels: readonly string[]) =>
    labels
      .slice(0, 8)
      .map((label) => normalized(label, 120, logins))
      .filter((label) => label !== "");
  const buttons = pressed(told?.buttons ?? []);
  const message = told?.message === undefined ? undefined : normalized(told.message, 200, logins);
  // A dialog shown over a page with no box is the look, the page behind it its instruction and ways.
  const dialogMessage = told?.dialog?.message === undefined ? undefined : normalized(told.dialog.message, 200, logins);
  const dialogButtons = pressed(told?.dialog?.buttons ?? []);
  const dialog = !pickedOnly && told !== undefined && (dialogMessage !== undefined || dialogButtons.length > 0);
  // A page with boxes is told beside them by the frame its first empty box sits in.
  const shown = empty.length > 0 && !pickedOnly ? frames.find((frame) => kept(frame).some((box) => box.empty)) : undefined;
  const instruction = shown?.instruction === undefined ? "" : normalized(shown.instruction, 200, logins);
  const ways = [...new Set((shown?.ways ?? []).slice(0, 12).map((label) => normalized(label, 120, logins)))];
  return {
    fingerprint: fingerprintOf({
      top: named(top),
      boxes: empty.map(written),
      submit: empty.some((box) => box.submit),
      ...(pickedOnly
        ? { ...(message === undefined ? {} : { instruction: message }), ...(told === undefined ? {} : { ways: buttons }) }
        : dialog
        ? {
            ...(dialogMessage === undefined ? {} : { message: dialogMessage }),
            buttons: dialogButtons,
            ...(message === undefined ? {} : { instruction: message }),
            ways: buttons,
          }
        : {
            ...(message === undefined ? {} : { message }),
            ...(told === undefined ? {} : { buttons }),
            ...(instruction === "" ? {} : { instruction }),
            ...(shown === undefined ? {} : { ways: ways.filter((label) => label !== "") }),
          }),
    }),
    boxes: boxes.map((box) => ({ ...written(box), empty: box.empty, submit: box.submit })),
    texts: [
      ...new Set(
        frames
          .flatMap((frame) => frame.texts)
          .slice(0, 40)
          .map((text) => normalized(text, 200, logins)),
      ),
    ]
      .filter((text) => text.length >= 2)
      .slice(0, 40),
  };
};
