import { Effect, Schema } from "effect";
import { pageCode, primaryPageCode } from "../runtime/host-execute.js";
import { hostOnSiteSource, siteDomain } from "../runtime/same-site.js";
import { workspaceHost } from "../runtime/workspace-origin.js";
import type { AutofillPopup } from "./autofill-contracts.js";
import { openPopupsCode } from "./autofill-page-code.js";
import type { AutofillPage } from "./autofill-step.js";
import {
  BoxKind,
  BoxTakes,
  fingerprintOf,
  heldOpener,
  type ObservedState,
  type SignInStates,
  type StateBox,
  withOpenerLook,
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
 * heading, h3 or paragraph, and up to eight buttons; with one, that same text as its instruction
 * and up to twelve buttons and links as its ways; these and every visible text outside a control
 * (`texts`) as they stand, which the host normalizes.
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
  const takesOf = (element) => {
    const type = attribute(element, "type");
    const mode = attribute(element, "inputmode");
    const auto = attribute(element, "autocomplete").split(/\\s+/);
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\\s+/)
      .map((id) => (id === "" ? "" : document.getElementById(id)?.innerText ?? ""));
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
      found.push({ kind: "code", count: members.length, role: roleOf(members[0]), labels: members.map(labelOf), empty: members.every((box) => box.value === ""), submit: submitIn(formOf(members[0])), form: formOf(members[0]) });
  const inRows = new Set([...rows.values()].filter((members) => members.length >= 4 && members.length <= 12).flat());
  for (const element of boxes) {
    if (inRows.has(element)) continue;
    const kind = kindOf(element);
    const box = { kind: kind ?? "identifier", ...(kind === "code" ? { role: roleOf(element), labels: [labelOf(element)] } : {}),
      ...((kind ?? "identifier") === "identifier" ? { takes: takesOf(element) } : {}), empty: element.value === "", submit: submitIn(formOf(element)), form: formOf(element) };
    if (kind === undefined) unhinted.push({ box, required: element.required });
    else found.push(box);
  }
  for (const { box, required } of unhinted)
    if (required || box.submit || found.some((other) => other.form !== null && other.form === box.form)) found.push(box);
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
  const message = ["h1", "h2", '[role="heading" i]', "h3", "p"]
    .map((selector) => [...document.querySelectorAll(selector)].find((element) => shows(element) && element.innerText.trim() !== ""))
    .find((element) => element !== undefined);
  const said = message === undefined ? undefined : message.innerText.slice(0, 2000);
  const controlText = (element) => (element.getAttribute("aria-label") || element.innerText || element.value || "").slice(0, 500);
  const pressed = 'button, [role="button" i], input[type="submit" i], input[type="button" i]';
  if (found.some((box) => box.empty)) {
    const ways = [];
    for (const element of document.querySelectorAll(pressed + ', a[href], [role="link" i]')) {
      if (ways.length >= 12) break;
      if (!shows(element)) continue;
      const label = controlText(element);
      if (label.trim() !== "") ways.push(label);
    }
    return { ...result, ...(said === undefined ? {} : { instruction: said }), ways };
  }
  const buttons = [...document.querySelectorAll(pressed)]
    .filter(shows)
    .map(controlText)
    .filter((label) => label.trim() !== "")
    .slice(0, 8);
  return { ...result, ...(said === undefined ? {} : { message: said }), buttons };
}`;

/**
 * Where the scan reads a sign-in in a pop-up the primary tab opened: the one an inspection found
 * (`targetId`), as a build records a step in a pop-up; else the newest still open on one of
 * `origins`, as a replay reads one, or the primary tab where none is. With `opener`, the primary
 * tab is read beside a pop-up too (`ObservedState.opener`).
 */
export interface SignInStatePopup {
  readonly origins: readonly string[];
  readonly targetId?: string | undefined;
  readonly opener?: true | undefined;
}

/** Where a build reads the state of a step in a pop-up: the pop-up its inspection found. */
export const stepPopup = (
  step: { readonly popup?: AutofillPopup | undefined },
  inspection: { readonly popupTargetId?: string | undefined },
): SignInStatePopup | undefined =>
  step.popup === undefined
    ? undefined
    : {
        origins: [step.popup.origin],
        ...(inspection.popupTargetId === undefined ? {} : { targetId: inspection.popupTargetId }),
      };

/**
 * Where a replay of `library` reads the page: in a pop-up on the origin of any state recorded with
 * a pop-up's own look, with the primary tab beside it where a state holds an opener's look
 * (`heldOpener`). None for a library with no state of a pop-up's own look, read on its primary
 * tab alone.
 */
export const statesPopup = (library: SignInStates): SignInStatePopup | undefined => {
  const origins = library.states.flatMap((state) =>
    state.fingerprint.popup === true && state.step.popup !== undefined ? [state.step.popup.origin] : [],
  );
  return origins.length === 0
    ? undefined
    : { origins: [...new Set(origins)], ...(library.states.some(heldOpener) ? { opener: true as const } : {}) };
};

/**
 * Page code binding `shown`: the pop-up the scan reads (`SignInStatePopup`), else the primary tab,
 * and `popupOrigins`, the origins whose frames count in a pop-up besides the sign-in's own.
 */
const shownCode = (popup: SignInStatePopup | undefined) =>
  popup === undefined
    ? "const shown = primary;\nconst popupOrigins = [];"
    : `${
        popup.targetId === undefined
          ? `${openPopupsCode("primary", popup.origins, "popups")}
const shown = popups.at(-1) ?? primary;`
          : pageCode(popup.targetId, "shown")
      }
const popupOrigins = ${JSON.stringify(popup.origins)};`;

/**
 * One host call over the frames of the primary tab, or of the pop-up it reads (`shownCode`), on
 * the site or a configured sign-in origin, or in a pop-up on its own.
 */
const scanCode = (
  targetId: string,
  siteHost: string,
  authenticationOrigins: readonly string[],
  popup: SignInStatePopup | undefined,
) =>
  `${primaryPageCode(targetId)}
${shownCode(popup)}
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
  return onSiteHost(url.hostname) || authenticationOrigins.includes(url.origin) ||
    (shown !== primary && popupOrigins.includes(url.origin)) ? url.origin : undefined;
};
const frameShows = async (frame) => {
  for (let scope = frame; scope.parentFrame() !== null; scope = scope.parentFrame())
    if (!(await (await scope.frameElement()).isVisible())) return false;
  return true;
};
const frames = [];
for (const frame of shown.frames()) {
  if (frames.length >= 20) break;
  try {
    const origin = signInOrigin(frameAddress(frame));
    if (origin === undefined || !(await frameShows(frame))) continue;
    frames.push({ ...(await frame.evaluate(${scanFrame})), origin });
  } catch {
    // A frame the host cannot read, such as one that detaches during the scan, shows nothing.
    continue;
  }
}
return { url: shown.url(), frames, popup: shown !== primary };`;

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
  popup: Schema.Boolean,
  frames: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      boxes: Schema.Array(ScannedBox),
      texts: Schema.Array(Schema.String),
      message: Schema.optional(Schema.String),
      buttons: Schema.optional(Schema.Array(Schema.String)),
      instruction: Schema.optional(Schema.String),
      ways: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

interface ObserveInput {
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly workspace?: { readonly parent: string } | undefined;
  readonly identifiers?: readonly string[] | undefined;
  readonly popup?: SignInStatePopup | undefined;
}

/**
 * Reads the page as a sign-in state (see `scanFrame`), on the primary tab, or in a pop-up it opened
 * (`SignInStatePopup`), whose look is marked `popup`, with the primary tab read beside it by a
 * second call where `opener` asks. A frame or the top page on a workspace host of the tool's
 * relation, other than the site's own origin, reads as `workspace`. A word of any text that is one
 * of the sign-in's own `identifiers`, or an address's part before "@", is masked as a name is.
 * Undefined when the page could not be read, or its top page is no web page.
 */
export const observeSignInState = (input: ObserveInput): Effect.Effect<ObservedState | undefined> =>
  input.popup?.opener !== true
    ? observePage(input)
    : observePage(input).pipe(
        Effect.flatMap((observed) =>
          observed?.fingerprint.popup !== true
            ? Effect.succeed(observed)
            : observePage({ ...input, popup: undefined }).pipe(
                Effect.map((opener) =>
                  opener === undefined
                    ? observed
                    : { ...observed, fingerprint: withOpenerLook(observed.fingerprint, opener.fingerprint), opener },
                ),
              ),
        ),
      );

const observePage = (input: ObserveInput): Effect.Effect<ObservedState | undefined> =>
  input.page
    .execute(
      scanCode(
        input.page.targetId,
        siteDomain(input.siteOrigin) ?? URL.parse(input.siteOrigin)?.hostname ?? "",
        input.authenticationOrigins,
        input.popup,
      ),
      15,
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(Scan)),
      Effect.map((scan) => {
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
        const boxes = frames.flatMap((frame) =>
          frame.boxes.slice(0, 200).map((box) => ({ frame: named(frame.origin), ...box })),
        );
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
        const told = empty.length > 0 ? undefined : frames.find((frame) => frame.message !== undefined || (frame.buttons ?? []).length > 0);
        const buttons = (told?.buttons ?? []).slice(0, 8).map((label) => normalized(label, 120, logins));
        // A page with boxes is told beside them by the frame its first empty box sits in.
        const shown = empty.length > 0 ? frames.find((frame) => frame.boxes.slice(0, 200).some((box) => box.empty)) : undefined;
        const instruction = shown?.instruction === undefined ? "" : normalized(shown.instruction, 200, logins);
        const ways = [...new Set((shown?.ways ?? []).slice(0, 12).map((label) => normalized(label, 120, logins)))];
        return {
          fingerprint: fingerprintOf({
            top: named(top),
            ...(scan.popup ? { popup: true } : {}),
            boxes: empty.map(written),
            submit: empty.some((box) => box.submit),
            ...(told?.message === undefined ? {} : { message: normalized(told.message, 200, logins) }),
            ...(told === undefined ? {} : { buttons: buttons.filter((label) => label !== "") }),
            ...(instruction === "" ? {} : { instruction }),
            ...(shown === undefined ? {} : { ways: ways.filter((label) => label !== "") }),
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
      }),
      Effect.orElseSucceed(() => undefined),
    );
