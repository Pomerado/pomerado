import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import { framedOn } from "../runtime/workspace-origin.js";
import {
  type AutofillRecipe,
  autofillRecipe,
  type AutofillRecipeStep,
  HandOffRecipeStep,
  LegacyAutofillRecipe,
  SignInMethodChoice,
} from "./autofill-recipe.js";
import type { AutofillField, AutofillSignedIn } from "./autofill-step.js";

// A sign-in as a library of states: what the sign-in shows now, what to do there, and where that
// led. A build or repair only appends entries, each keyed by a hash of its own content, so two
// writers never collide and no entry is ever changed or removed. A library lives beside a recipe
// and never replaces one.

/** The kind of value a visible box takes, as the page's own attributes say. */
export const BoxKind = Schema.Literal("identifier", "password", "code", "date_of_birth", "zip");
export type BoxKind = typeof BoxKind.Type;

/**
 * What an identifier box takes, as its own attributes and labels say: an email, a phone, either
 * (`email_or_phone`), or neither said (`other`).
 */
export const BoxTakes = Schema.Literal("email", "phone", "email_or_phone", "other");
export type BoxTakes = typeof BoxTakes.Type;

/** An origin, or `workspace` for the login's own workspace host. */
const Origin = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000));
const Label = Schema.String.pipe(Schema.maxLength(200));

/**
 * One visible empty box: its frame's origin, its kind, and a code row's box count; a code box also
 * its role (`role`, as `textbox` or `spinbutton`) and its label's shape (`label`), so two code
 * screens whose boxes differ in either are two looks; an identifier box also what it takes
 * (`takes`), so an email box and a phone box are two looks. A look read before boxes had them has
 * none of them. A code row that says what it takes is one of identifier boxes, which a look read
 * before code rows were read held one by one, as identifier boxes taking that (`paired`). A code
 * box with role `checkbox` is a code picked from named checkboxes, on a page with no box that takes
 * typing.
 * A box with role `captcha` is a picture code box, a site's own picture CAPTCHA on a sign-in form,
 * which a gate fills, never a step, read as before it was told apart (`paired`).
 */
export const StateBox = Schema.Struct({
  frame: Origin,
  kind: BoxKind,
  count: Schema.optional(Schema.Int.pipe(Schema.between(2, 12))),
  role: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{1,20}$/u))),
  label: Schema.optional(Label),
  takes: Schema.optional(BoxTakes),
});
export type StateBox = typeof StateBox.Type;

/**
 * What the sign-in shows now, ignoring layout and path: the top page's origin, each visible empty
 * box on a sign-in origin, and whether a submit sits in their form. A state with no box is told by
 * its main message and its buttons, normalized so a name, an address or a number never shows. A
 * state with boxes keeps its main instruction (`instruction`) and the ways in it offers, its
 * buttons and links (`ways`), normalized alike, which only order states of one look
 * (`toldApart`); a look read before it kept them has neither. A look read in a pop-up the primary
 * tab opened is marked `popup`, with the pop-up's origin as `top`; a pop-up state recorded before
 * pop-ups were read holds the look of the tab that opened it (`heldOpener`). A core before the one
 * that reads `popup` leaves out a state that has it, as it leaves out any field it does not know.
 * A state with no box read in a dialog is told by the dialog's message and buttons, and keeps the
 * page behind it as its instruction and ways (`inDialog`), which no other look with no box has.
 */
export const StateFingerprint = Schema.Struct({
  top: Origin,
  popup: Schema.optional(Schema.Literal(true)),
  boxes: Schema.Array(StateBox).pipe(Schema.maxItems(24)),
  submit: Schema.Boolean,
  message: Schema.optional(Label),
  buttons: Schema.optional(Schema.Array(Label).pipe(Schema.maxItems(8))),
  instruction: Schema.optional(Label),
  ways: Schema.optional(Schema.Array(Label).pipe(Schema.maxItems(12))),
});
export type StateFingerprint = typeof StateFingerprint.Type;

const Key = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/u));
const Marker = LegacyAutofillRecipe.fields.signedIn;

/**
 * A recorded step on an absolute page, or a workspace step on a path. `pageSends` marks a code
 * screen whose page sent the code itself as it was recorded, beside the submit or submit key the
 * page took away then: a replay types the code alone and, on a host that tells a code the page
 * sent itself, presses that control only when the page didn't send it. A recipe never holds it. A core before this one leaves out a state that has it,
 * as it leaves out any field it does not know, so a host records it only once every core that
 * replays its libraries is this one or later (`AutofillSignInState.recordsPageSends`).
 */
const StateStep = Schema.extend(
  HandOffRecipeStep,
  Schema.Struct({ pageSends: Schema.optional(Schema.Literal(true)) }),
).pipe(
  Schema.filter(
    (step) =>
      step.pageSends === undefined ||
      step.submit !== undefined ||
      step.submitKey !== undefined ||
      "a pageSends step names a submit or submit key",
  ),
  Schema.filter(
    (step) =>
      (step.origin === "workspace" ? step.page.startsWith("/") : URL.parse(step.page) !== null) ||
      "a workspace step's page is a path, and any other step's an absolute URL",
  ),
);
/** A state's step: a recipe's, which may say the page sends it itself (`pageSends`). */
export type SignInStateStep = typeof StateStep.Type;

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
/**
 * One stored entry of a library, format 1: a state with the step recorded there; a transition
 * from one entry's key to the next; or a signed-in marker. `source` says whether a sign-in recorded
 * the state or it was derived from a recipe. `stepUp` marks a state or marker of a step-up, a
 * sign-in a signed-in session's later page asks for again, which only a replay in place reads; a
 * core without it refuses such an entry, as it refuses any field it does not know.
 */
export const SignInStateEntry = Schema.Union(
  Schema.Struct({
    format: Schema.Literal(1),
    kind: Schema.Literal("state"),
    key: Key,
    source: Schema.Literal("recorded", "derived"),
    fingerprint: StateFingerprint,
    step: StateStep,
    stepUp: Schema.optional(Schema.Literal(true)),
  }).annotations(strict),
  Schema.Struct({
    format: Schema.Literal(1),
    kind: Schema.Literal("transition"),
    key: Key,
    from: Key,
    to: Key,
  }).annotations(strict),
  Schema.Struct({
    format: Schema.Literal(1),
    kind: Schema.Literal("signed_in"),
    key: Key,
    ...Marker.fields,
    stepUp: Schema.optional(Schema.Literal(true)),
  }).annotations(strict),
);
export type SignInStateEntry = typeof SignInStateEntry.Type;
export type StateEntry = Extract<SignInStateEntry, { readonly kind: "state" }>;
export type TransitionEntry = Extract<SignInStateEntry, { readonly kind: "transition" }>;
export type SignedInEntry = Extract<SignInStateEntry, { readonly kind: "signed_in" }>;

/** Whether an entry is a step-up's state or marker (`stepUp`). */
export const isStepUpEntry = (entry: SignInStateEntry) => entry.kind !== "transition" && entry.stepUp === true;

/** Code-unit order, the same on every host whatever its locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** JSON with every object's keys sorted and undefined dropped: the same value is the same bytes. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner)
            .filter(([, field]) => field !== undefined)
            .sort(([a], [b]) => byCodeUnit(a, b)),
        )
      : inner,
  );
const keyOf = (content: unknown) =>
  createHash("sha256").update(canonical(content)).digest("hex").slice(0, 32);

/** A fingerprint in its one written form: boxes, buttons and ways sorted. */
export const fingerprintOf = (fingerprint: StateFingerprint): StateFingerprint => ({
  top: fingerprint.top,
  ...(fingerprint.popup === true ? { popup: true } : {}),
  boxes: [...fingerprint.boxes].sort((a, b) => byCodeUnit(canonical(a), canonical(b))),
  submit: fingerprint.submit,
  ...(fingerprint.message === undefined ? {} : { message: fingerprint.message }),
  ...(fingerprint.buttons === undefined ? {} : { buttons: [...fingerprint.buttons].sort() }),
  ...(fingerprint.instruction === undefined ? {} : { instruction: fingerprint.instruction }),
  ...(fingerprint.ways === undefined ? {} : { ways: [...fingerprint.ways].sort() }),
});
/**
 * A look's text as looks compare and as a page holds still: its instruction and ways left out, as
 * they only order states of one look (`toldApart`).
 */
export const fingerprintText = (fingerprint: StateFingerprint) =>
  canonical({ ...fingerprintOf(fingerprint), instruction: undefined, ways: undefined });
/** Whether a look gives its code boxes' role and label, as one read since they had them does. */
const labelled = (fingerprint: StateFingerprint) => fingerprint.boxes.some((box) => box.role !== undefined);
/** Whether a look says what its identifier boxes take, as one read since they had it does. */
const kinded = (fingerprint: StateFingerprint) => fingerprint.boxes.some((box) => box.takes !== undefined);
/**
 * A look, or a known state's look with the step recorded there, whose identifier fields say what
 * its boxes take where its look does not (`takesAgree`).
 */
export type Look =
  | StateFingerprint
  | { readonly fingerprint: StateFingerprint; readonly step?: AutofillRecipeStep | undefined };
const lookOf = (look: Look) => ("fingerprint" in look ? look : { fingerprint: look, step: undefined });
/** What two identifier boxes take may be one: the same, or either says nothing (`other`, or none). */
const takesFits = (a: BoxTakes | undefined, b: BoxTakes | undefined) =>
  a === undefined || b === undefined || a === "other" || b === "other" || a === b;
/** How many code fields a known state's step types, one for each box of a row. */
const codesOf = (step: AutofillRecipeStep | undefined) =>
  step?.fields.filter((field) => "slot" in field && field.slot === "code").length ?? 0;
/**
 * Whether a known state sits in a pop-up and holds the look of the tab that opened it, as one
 * recorded before pop-ups were read does: a page is compared with it by that tab's look.
 */
export const heldOpener = (look: Look) => {
  const { fingerprint, step } = lookOf(look);
  return step?.popup !== undefined && fingerprint.popup !== true;
};
/** Each page's look read in a pop-up, or taken from one, by the look its opener showed then. */
const openerLooks = new WeakMap<StateFingerprint, StateFingerprint>();
/**
 * A copy of a page's look read in a pop-up, held with the look the tab that opened the pop-up
 * showed beside it (`opener`), which a state that holds an opener's look is compared with.
 */
export const withOpenerLook = (look: StateFingerprint, opener: StateFingerprint | undefined) => {
  if (opener === undefined) return look;
  const copy = { ...look };
  openerLooks.set(copy, opener);
  return copy;
};
/** The look the tab that opened a page's pop-up showed beside it (`withOpenerLook`), else the page's own. */
export const openerLook = (look: StateFingerprint) => openerLooks.get(look) ?? look;
/**
 * Two looks as they compare: a page's beside a state that holds an opener's look (`heldOpener`)
 * by the look its opener showed (`openerLook`), with its step.
 */
const facing = (a: Look, b: Look): readonly [Look, Look] => {
  const opened = (look: Look): Look => {
    const { fingerprint, step } = lookOf(look);
    return { fingerprint: openerLook(fingerprint), step };
  };
  return [heldOpener(b) ? opened(a) : a, heldOpener(a) ? opened(b) : b];
};
/**
 * Two looks' boxes paired, and those of each left: each with one alike by `key`; else, as a look
 * read before such code rows were read held it, a code row of either with as many boxes of the
 * other's frame, each with no count: code boxes, as one-character boxes read one by one, or
 * identifier boxes taking what it says they took (`takes`). A row of any kind pairs with a lone such
 * box where the other look's step types as many codes as the row has boxes, or one code the fill
 * spreads across the row from its first box (`codes`), as a look read before a page switched each
 * box on in turn held its first box alone. A row pairs only with boxes read one by one, never with
 * another row, whose role and label tell it.
 * A picture code box left pairs with a box of its kind and frame the other look holds, else with
 * none, as a site may show it only at times. `folded` holds every box paired so, whose takes are
 * never compared (`takesAgree`).
 */
const paired = (
  held: readonly StateBox[],
  holding: readonly StateBox[],
  key: (box: StateBox) => string,
  codes: readonly [number, number] = [0, 0],
) => {
  const left = [...held];
  const right = [...holding];
  for (let at = left.length - 1; at >= 0; at -= 1) {
    const match = right.findIndex((box) => key(box) === key(left[at] as StateBox));
    if (match < 0) continue;
    right.splice(match, 1);
    left.splice(at, 1);
  }
  const folded = new Set<StateBox>();
  const fold = (rows: StateBox[], alone: StateBox[], codesThere: number) => {
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      const row = rows[at] as StateBox;
      if (row.kind !== "code" || row.count === undefined) continue;
      const kind = row.takes === undefined ? "code" : "identifier";
      const boxes = alone.filter(
        (box) =>
          box.frame === row.frame &&
          box.kind === kind &&
          box.count === undefined &&
          box.role !== "captcha" &&
          (kind === "identifier" ? takesFits(box.takes, row.takes) : box.takes === undefined),
      );
      const taken =
        boxes.length >= row.count
          ? boxes.slice(0, row.count)
          : codesThere === row.count || codesThere === 1
            ? boxes.slice(0, 1)
            : [];
      if (taken.length === 0) continue;
      for (const box of [row, ...taken]) folded.add(box);
      for (const box of taken) alone.splice(alone.indexOf(box), 1);
      rows.splice(at, 1);
    }
  };
  fold(left, right, codes[1]);
  fold(right, left, codes[0]);
  // A picture code box (role `captcha`), which a site may show only at times, pairs with a box of
  // its kind and frame the other look holds, as a look read before held it, or with none.
  const optional = (boxes: StateBox[], others: StateBox[]) => {
    for (let at = boxes.length - 1; at >= 0; at -= 1) {
      const box = boxes[at] as StateBox;
      if (box.role !== "captcha") continue;
      const match = others.findIndex((other) => other.frame === box.frame && other.kind === box.kind && other.count === undefined);
      if (match >= 0) folded.add(others.splice(match, 1)[0] as StateBox);
      folded.add(box);
      boxes.splice(at, 1);
    }
  };
  optional(left, right);
  optional(right, left);
  return { held: left, holding: right, folded };
};
/**
 * Two looks' boxes paired (`paired`), as looks compare: their code boxes' role and label where both
 * give them, else neither, so a state recorded before code boxes had them matches every page it
 * matched then; what identifier boxes take never, as `takesAgree` compares it; with `place`, by
 * frame, kind and count alone. A known state's step stands in for a row's codes.
 */
const pairedLooks = (a: Look, b: Look, place = false) => {
  const [left, right] = [lookOf(a), lookOf(b)];
  const labels = labelled(left.fingerprint) && labelled(right.fingerprint);
  // A picture code box pairs by its role always, so it never stands in for another box (`paired`).
  const marked = (role: string | undefined) => (role === "captcha" ? { role } : {});
  const key = place
    ? ({ frame, kind, count, role }: StateBox) => canonical({ frame, kind, count, ...marked(role) })
    : ({ role, label, takes: _takes, ...box }: StateBox) =>
        canonical({ ...box, ...(labels ? { role, label } : marked(role)) });
  return paired(left.fingerprint.boxes, right.fingerprint.boxes, key, [codesOf(left.step), codesOf(right.step)]);
};
/** A look less the boxes `paired` folded, whose takes it compared already. */
const unfolded = (look: Look, folded: ReadonlySet<StateBox>): Look => {
  const { fingerprint, step } = lookOf(look);
  return { fingerprint: { ...fingerprint, boxes: fingerprint.boxes.filter((box) => !folded.has(box)) }, step };
};
/** A look's text but its boxes, as looks compare. */
const textBesideBoxes = (fingerprint: StateFingerprint) =>
  canonical({ ...fingerprintOf(fingerprint), boxes: undefined, instruction: undefined, ways: undefined });
/** Each frame's identifier boxes by what they take. */
const takenOn = (fingerprint: StateFingerprint) => {
  const frames = new Map<string, BoxTakes[]>();
  for (const box of fingerprint.boxes)
    if (box.takes !== undefined) frames.set(box.frame, [...(frames.get(box.frame) ?? []), box.takes]);
  return frames;
};
/**
 * Whether each identifier box of `inner` pairs with one of `outer`'s on its frame: both take the
 * same, or either says nothing (`other`), as a box whose label a site reworded.
 */
const takesFit = (inner: StateFingerprint, outer: StateFingerprint) => {
  const others = takenOn(outer);
  for (const [frame, held] of takenOn(inner)) {
    const left = [...held];
    const right = [...(others.get(frame) ?? [])];
    for (let at = left.length - 1; at >= 0; at -= 1) {
      const match = left[at] === "other" ? -1 : right.indexOf(left[at] as BoxTakes);
      if (match < 0) continue;
      right.splice(match, 1);
      left.splice(at, 1);
    }
    const said = left.filter((takes) => takes !== "other").length;
    if (left.length > right.length || said > right.filter((takes) => takes === "other").length) return false;
  }
  return true;
};
/** What a recorded step's identifier fields accept: an email alone, a phone alone, else `other`. */
const fieldTakes = (step: AutofillRecipeStep) =>
  step.fields.flatMap((field) =>
    "accepts" in field
      ? [field.accepts.length === 1 && (field.accepts[0] === "email" || field.accepts[0] === "phone") ? field.accepts[0] : "other"]
      : [],
  );
/**
 * Whether two looks' identifier boxes may be one, as they take values: where both say it, each box
 * pairs with one of the other's (`takesFit`), `inner`'s into `outer`'s where one only holds the
 * other (`within`); where one look says it and the other is a known state's that doesn't, as one
 * recorded before boxes said it, that state's step stands in, and they part only where every box of
 * the one takes a phone alone and every identifier field of the step accepts an email alone, or
 * the reverse.
 */
const takesAgree = (inner: Look, outer: Look, within = false) => {
  const [left, right] = [lookOf(inner), lookOf(outer)];
  const [leftSays, rightSays] = [kinded(left.fingerprint), kinded(right.fingerprint)];
  if (leftSays && rightSays)
    return takesFit(left.fingerprint, right.fingerprint) && (within || takesFit(right.fingerprint, left.fingerprint));
  const [said, step] = leftSays ? [left.fingerprint, right.step] : rightSays ? [right.fingerprint, left.step] : [];
  if (said === undefined || step === undefined) return true;
  const boxes = said.boxes.flatMap((box) => (box.takes === undefined ? [] : [box.takes]));
  const fields = fieldTakes(step);
  const all = (kinds: readonly string[], kind: string) => kinds.length > 0 && kinds.every((taken) => taken === kind);
  return !((all(boxes, "phone") && all(fields, "email")) || (all(boxes, "email") && all(fields, "phone")));
};
/**
 * Whether a look with no box was read apart from what covers the page, a dialog or a notice the
 * library dismisses: it keeps the page as read whole as its instruction and ways
 * (`observeSignInState`).
 */
const inDialog = (fingerprint: StateFingerprint) =>
  fingerprint.boxes.length === 0 && (fingerprint.instruction !== undefined || fingerprint.ways !== undefined);
/**
 * Whether a look's only boxes are codes picked from named checkboxes (role `checkbox`), with the
 * page as a look with no box reads it kept as its instruction and ways (`observeSignInState`).
 */
const pickedOnly = (fingerprint: StateFingerprint) =>
  fingerprint.boxes.length > 0 &&
  fingerprint.boxes.every((box) => box.kind === "code" && box.role === "checkbox") &&
  (fingerprint.instruction !== undefined || fingerprint.ways !== undefined);
/**
 * A look as it reads: itself, and one read apart from a dialog or notice, or with codes picked from
 * checkboxes, as the page with no box too, as a look read before either was read holds that page.
 */
const readings = (look: Look): readonly Look[] => {
  const { fingerprint, step } = lookOf(look);
  if (!inDialog(fingerprint) && !pickedOnly(fingerprint)) return [look];
  const whole: StateFingerprint = {
    top: fingerprint.top,
    ...(fingerprint.popup === true ? { popup: true } : {}),
    boxes: [],
    submit: false,
    ...(fingerprint.instruction === undefined ? {} : { message: fingerprint.instruction }),
    buttons: fingerprint.ways ?? [],
  };
  return [look, { fingerprint: whole, step }];
};
/** `readsOn` for two looks as they face each other (`facing`). */
const reads = (look: Look, state: Look) => {
  const [{ fingerprint, step }, known] = [lookOf(look), lookOf(state)];
  return (
    step === undefined &&
    known.step !== undefined &&
    fingerprint.top !== known.fingerprint.top &&
    framedOn(known.fingerprint.top, fingerprint.top, fingerprint.boxes.map((box) => [box.frame]))
  );
};
/**
 * Whether a page's look, one given with no step, reads on the top origin of a known state's, one
 * given with its step, as a screen recorded there runs on that page (`framedOn`): their top origins
 * differ, and every box of the page sits in a frame on the state's, on the page's own registrable
 * domain, as a site's page shows its sign-in host's form. The look leaves out the rest of that
 * rule, which the replay's origin rule judges before anything is typed.
 */
export const readsOn = (look: Look, state: Look) => reads(...facing(look, state));
/** A look as it compares with another it faces (`reads`). */
const readOn = (look: Look, other: Look): StateFingerprint =>
  reads(look, other) ? { ...lookOf(look).fingerprint, top: lookOf(other).fingerprint.top } : lookOf(look).fingerprint;
/** Two looks as they face each other, each as it compares with the other (`readOn`). */
const readBoth = (x: Look, y: Look): readonly [Look, Look] => [
  { fingerprint: readOn(x, y), step: lookOf(x).step },
  { fingerprint: readOn(y, x), step: lookOf(y).step },
];
/**
 * Whether two looks are one: alike by text and their boxes (`pairedLooks`), their identifier boxes
 * taking values alike (`takesAgree`), as either reads (`readings`), so a page read in a dialog is
 * still the page behind it, as a look read before held it; a page beside a state that holds an
 * opener's look by its opener's (`facing`), and a page's read on a known state's (`readOn`).
 */
export const sameFingerprint = (a: Look, b: Look) => {
  const [x, y] = readBoth(...facing(a, b));
  return readings(x).some((left) =>
    readings(y).some((right) => {
      if (textBesideBoxes(lookOf(left).fingerprint) !== textBesideBoxes(lookOf(right).fingerprint)) return false;
      const rest = pairedLooks(left, right);
      return (
        rest.held.length === 0 &&
        rest.holding.length === 0 &&
        takesAgree(unfolded(left, rest.folded), unfolded(right, rest.folded))
      );
    }),
  );
};
/**
 * The controls a library's steps dismiss a covering notice by (`dismiss`), each once: the scan
 * reads a page with no box apart from the notices they sit in (`observeSignInState`).
 */
export const signInDismisses = (library: SignInStates) => [
  ...new Set(library.states.flatMap((state) => (state.step.dismiss === undefined ? [] : [state.step.dismiss]))),
];
/** Whether two looks with no box show one message, as either reads (`readings`). */
export const sameMessage = (a: StateFingerprint, b: StateFingerprint) =>
  readings(a).some((left) => readings(b).some((right) => lookOf(left).fingerprint.message === lookOf(right).fingerprint.message));
/**
 * Whether `twin` is `state` with a `dismiss` added and nothing else: one look, or two the `page`
 * matches, as a page read apart from a notice is both the look recorded under it and the one
 * recorded with it (`readings`), and one step but for the covering notice's control `twin` clicks,
 * which a fill clicks only where the page shows it.
 */
export const addsDismiss = (twin: StateEntry, state: StateEntry, page?: StateFingerprint) =>
  twin.step.dismiss !== undefined &&
  state.step.dismiss === undefined &&
  (sameFingerprint(twin, state) ||
    (page !== undefined && sameFingerprint(twin, page) && sameFingerprint(state, page))) &&
  canonical({ ...twin.step, dismiss: undefined }) === canonical(state.step);
/** Whether a fingerprint shows nothing to tell it by: no box, no message and no button. */
export const blankFingerprint = (fingerprint: StateFingerprint) =>
  fingerprint.boxes.length === 0 &&
  fingerprint.message === undefined &&
  (fingerprint.buttons ?? []).length === 0;

/**
 * Whether `outer` holds every box of `inner` and more, on the same top origin, in a pop-up or not
 * alike, as looks compare (`facing`, `readOn`, `pairedLooks`, `takesAgree`): a page that may still
 * grow from `inner` into `outer`, as a sign-in whose password box draws late.
 */
export const containsFingerprint = (inner: Look, outer: Look) => {
  const [x, y] = readBoth(...facing(inner, outer));
  const [held, holding] = [lookOf(x).fingerprint, lookOf(y).fingerprint];
  if (held.top !== holding.top || held.popup !== holding.popup || held.boxes.length === 0) return false;
  const rest = pairedLooks(x, y);
  return (
    rest.held.length === 0 &&
    rest.holding.length > 0 &&
    takesAgree(unfolded(x, rest.folded), unfolded(y, rest.folded), true)
  );
};

/**
 * How far a known look's instruction and ways stand from a page's: a differing instruction counts
 * more than any count of ways only one of them offers. Undefined where either gives neither, as a
 * look read before they were kept. They only order states of one look, never part them, so a page
 * the site reworded keeps its match.
 */
export const toldApart = (known: StateFingerprint, page: StateFingerprint): number | undefined => {
  // Two looks with no box: one read as the page reads stands nearer than one that matched it only
  // as the page behind a dialog either was read in (`readings`).
  if (known.boxes.length === 0 && page.boxes.length === 0)
    return fingerprintText(known) === fingerprintText(page) ? 0 : inDialog(known) || inDialog(page) ? 100 : undefined;
  const told = (look: StateFingerprint) => look.instruction !== undefined || look.ways !== undefined;
  if (!told(known) || !told(page)) return undefined;
  const [ours, theirs] = [known.ways ?? [], page.ways ?? []];
  return (
    (known.instruction !== undefined && page.instruction !== undefined && known.instruction !== page.instruction ? 100 : 0) +
    ours.filter((way) => !theirs.includes(way)).length +
    theirs.filter((way) => !ours.includes(way)).length
  );
};

/** A fingerprint in words, value-free: what a repair is told it found. */
export const describeFingerprint = (fingerprint: StateFingerprint) => {
  const boxes = fingerprint.boxes.map(
    (box) =>
      `${box.count === undefined ? "" : `${box.count} `}${box.kind.replaceAll("_", " ")} box${
        box.count === undefined ? "" : "es"
      }${box.frame === fingerprint.top ? "" : ` in a frame on ${box.frame}`}`,
  );
  const shown =
    boxes.length > 0
      ? `${boxes.join(", ")}${fingerprint.submit ? ", with a submit" : ""}${
          fingerprint.message === undefined ? "" : `; new message "${fingerprint.message}"`
        }`
      : `no box; message "${fingerprint.message ?? ""}"; buttons ${JSON.stringify(fingerprint.buttons ?? [])}`;
  return `A sign-in state ${fingerprint.popup === true ? "in a pop-up " : ""}on ${fingerprint.top}: ${shown}.`;
};

/** A text as its shape alone: each word "~" and each number "#". */
const textShape = (text: string) =>
  text
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => (!/\p{L}/u.test(word) && /[\p{Nd}#]/u.test(word) ? "#" : "~"))
    .join(" ");

/**
 * A path as a log may hold it, each number "#". Given `known`, recorded pages' URLs, a segment no
 * known page on `host` has at that place, which may be a name or a value, is "#" when a number,
 * else "~".
 */
const pathShape = (host: string, path: string, known: readonly string[] | undefined) => {
  const paths = known?.flatMap((page) => {
    const url = URL.parse(page);
    return url?.host === host ? [url.pathname.split("/")] : [];
  });
  return path
    .split("/")
    .map((segment, index) =>
      segment === "" || paths === undefined || paths.some((other) => other[index] === segment)
        ? segment.replace(/\p{Nd}+/gu, "#")
        : /^\p{Nd}+$/u.test(segment)
          ? "#"
          : "~",
    )
    .join("/");
};

/**
 * A fingerprint as a log may hold it, with no text and no value: its boxes, a code box's label,
 * its message and its buttons as shapes (`textShape`), and the host and path of `page`, an absolute
 * URL, as `pathShape` writes it against `known`.
 */
export const fingerprintShape = (fingerprint: StateFingerprint, page?: string, known?: readonly string[]) => {
  const url = page === undefined ? null : URL.parse(page);
  return {
    ...(url === null ? {} : { host: url.host, path: pathShape(url.host, url.pathname, known) }),
    ...(fingerprint.popup === true ? { popup: true } : {}),
    boxes: fingerprintOf(fingerprint).boxes.map((box) =>
      box.label === undefined ? box : { ...box, label: textShape(box.label) },
    ),
    submit: fingerprint.submit,
    ...(fingerprint.message === undefined ? {} : { message: textShape(fingerprint.message) }),
    ...(fingerprint.buttons === undefined ? {} : { buttons: fingerprint.buttons.map(textShape).sort() }),
  };
};
export type FingerprintShape = ReturnType<typeof fingerprintShape>;

/** The entry for a state, keyed by its fingerprint, step and whether a step-up's. */
export const stateEntry = (
  fingerprint: StateFingerprint,
  step: SignInStateStep,
  source: "recorded" | "derived" = "recorded",
  stepUp?: true,
): StateEntry => {
  const written = fingerprintOf(fingerprint);
  return {
    format: 1,
    kind: "state",
    key: keyOf({ fingerprint: written, step, stepUp }),
    source,
    fingerprint: written,
    step,
    ...(stepUp === undefined ? {} : { stepUp }),
  };
};
const transitionEntry = (from: string, to: string): TransitionEntry => ({
  format: 1,
  kind: "transition",
  key: keyOf({ from, to }),
  from,
  to,
});
const signedInEntry = (marker: AutofillSignedIn, stepUp?: true): SignedInEntry => {
  const fields = {
    ...(marker.selector === undefined ? {} : { selector: marker.selector }),
    ...(marker.urlPath === undefined ? {} : { urlPath: marker.urlPath }),
    ...(marker.openPath === undefined ? {} : { openPath: marker.openPath }),
    ...(stepUp === undefined ? {} : { stepUp }),
  };
  return { format: 1, kind: "signed_in", key: keyOf(fields), ...fields };
};
const keyed = (entry: SignInStateEntry) => {
  if (entry.kind === "state") return stateEntry(entry.fingerprint, entry.step, entry.source, entry.stepUp).key;
  if (entry.kind === "transition") return transitionEntry(entry.from, entry.to).key;
  return signedInEntry(entry, entry.stepUp).key;
};

/** A counted box as read: whether it is empty, and whether a submit sits in its form. */
export interface ObservedBox extends StateBox {
  readonly empty: boolean;
  readonly submit: boolean;
}

/**
 * The page as read: `fingerprint` from its empty boxes, or from its message and buttons when it
 * shows none; every counted box (`boxes`); and its visible texts, normalized (`texts`). A page
 * read in a pop-up may hold the tab that opened it as read beside it (`opener`), for the states
 * that hold an opener's look (`heldOpener`).
 */
export interface ObservedState {
  readonly fingerprint: StateFingerprint;
  readonly boxes: readonly ObservedBox[];
  readonly texts: readonly string[];
  readonly opener?: ObservedState | undefined;
}
/** The page as the tab that opened its pop-up read beside it (`opener`), else as read. */
export const openerOf = (observed: ObservedState) => observed.opener ?? observed;

/** The page's boxes as read now, less those it held filled already when read as `reached`. */
const standingBoxes = (reached: ObservedState, now: ObservedState) => {
  const before = reached.boxes.filter((box) => !box.empty).map((box) => boxText(box));
  return now.boxes.filter((box) => {
    const at = box.empty ? -1 : before.indexOf(boxText(box));
    if (at >= 0) before.splice(at, 1);
    return at < 0;
  });
};
/**
 * The page's boxes as they stand since `reached`, as `standingFingerprint` reads them; a code box
 * keeps what the identifier boxes a look read before held there took (`takes`), so it still pairs
 * with them (`paired`).
 */
const standingLook = (reached: ObservedState, now: ObservedState): StateFingerprint => {
  const boxes = standingBoxes(reached, now);
  return fingerprintOf({
    top: now.fingerprint.top,
    ...(now.fingerprint.popup === true ? { popup: true } : {}),
    boxes: boxes.map(({ frame, kind, count, takes }) => ({
      frame,
      kind,
      ...(count === undefined ? {} : { count }),
      ...(kind === "code" && takes !== undefined ? { takes } : {}),
    })),
    submit: boxes.some((box) => box.submit),
  });
};
/**
 * The page's boxes as they stand since `reached`: the empty ones, and the ones filled since; read
 * in a pop-up beside its opener, with the opener's alike (`withOpenerLook`).
 */
export const standingFingerprint = (reached: ObservedState, now: ObservedState): StateFingerprint =>
  reached.opener === undefined && now.opener === undefined
    ? standingLook(reached, now)
    : withOpenerLook(standingLook(reached, now), standingLook(openerOf(reached), openerOf(now)));
const boxText = ({ frame, kind, count }: StateBox) => canonical({ frame, kind, count });
/**
 * Whether two looks show the same boxes on the same top origin, a page's read on a known state's
 * (`readOn`), in a pop-up or not alike, whatever their text, as boxes pair by place (`facing`,
 * `pairedLooks`), their identifier boxes taking values alike (`takesAgree`); with `asRead`, as
 * either reads too (`readings`), as a stored look is matched with a page, never where a state acted
 * in is judged to stand still, as a look with codes picked from checkboxes reads as any page with
 * no box then.
 */
export const sameBoxes = (a: Look, b: Look, asRead = false) => {
  const [x, y] = readBoth(...facing(a, b));
  return (asRead ? readings(x) : [x]).some((left) =>
    (asRead ? readings(y) : [y]).some((right) => {
      const [held, holding] = [lookOf(left).fingerprint, lookOf(right).fingerprint];
      const rest = pairedLooks(left, right, true);
      return (
        held.top === holding.top &&
        held.popup === holding.popup &&
        rest.held.length === 0 &&
        rest.holding.length === 0 &&
        takesAgree(unfolded(left, rest.folded), unfolded(right, rest.folded))
      );
    }),
  );
};
/**
 * Whether an identifier box the page shows empty takes an email alone where the box on its frame,
 * when read as `reached`, took a phone alone, or the reverse: a phone box where an email box was.
 * Only a box that takes one kind alone counts, on either side, so a box whose label gained an
 * error's words, or drew late, changes nothing.
 */
export const takesLost = (reached: ObservedState, now: ObservedState) => {
  const sole = (box: StateBox) => box.takes === "email" || box.takes === "phone";
  const before = reached.boxes.filter(sole);
  // Each box the page still shows as it was is paired first, so only the rest may have changed.
  const changed = now.boxes.filter((box) => {
    if (!box.empty || !sole(box)) return false;
    const at = before.findIndex((other) => other.frame === box.frame && other.takes === box.takes);
    if (at >= 0) before.splice(at, 1);
    return at < 0;
  });
  return changed.some((box) => {
    const at = before.findIndex((other) => other.frame === box.frame && other.takes !== box.takes);
    if (at >= 0) before.splice(at, 1);
    return at >= 0;
  });
};

/**
 * The state the page shows after an action in the state it showed when read as `reached`: the
 * same boxes, typed or not, with a text that was not there then, as a notice under a sign-in form
 * after its submit, is that state's boxes and the first such text; the same boxes alone are that
 * state again; anything else is the page's own fingerprint. Where an identifier box takes the other
 * kind alone (`takesLost`), the boxes are as they stand now, each with what it takes now. Text
 * counts beside boxes nowhere else. Read in a pop-up beside its opener, it holds the opener's
 * alike (`withOpenerLook`).
 */
export const stateAfter = (reached: ObservedState | undefined, now: ObservedState): StateFingerprint =>
  reached?.opener === undefined && now.opener === undefined
    ? pageAfter(reached, now)
    : withOpenerLook(pageAfter(reached, now), pageAfter(reached && openerOf(reached), openerOf(now)));
const pageAfter = (reached: ObservedState | undefined, now: ObservedState): StateFingerprint => {
  if (reached === undefined || reached.fingerprint.boxes.length === 0) return now.fingerprint;
  const { top, popup, boxes, submit } = reached.fingerprint;
  const marked = popup === true ? { popup } : {};
  const plain = fingerprintOf({ top, ...marked, boxes, submit });
  if (!sameBoxes(standingLook(reached, now), plain)) return now.fingerprint;
  const shown = takesLost(reached, now)
    ? fingerprintOf({
        top,
        ...marked,
        boxes: standingBoxes(reached, now).map(({ frame, kind, count, takes }) => ({
          frame,
          kind,
          ...(count === undefined ? {} : { count }),
          ...(takes === undefined ? {} : { takes }),
        })),
        submit,
      })
    : plain;
  const fresh = now.texts.find((text) => !reached.texts.includes(text));
  return fresh === undefined ? shown : fingerprintOf({ ...shown, message: fresh });
};

/** The plain fields a recorded step and its sign-in carry for states, which survive a copy. */
const fingerprintField = "stateFingerprint";
const readingField = "stateReading";

/**
 * Notes the state a build's or repair's sign-in step was taken in, read just before that step's
 * fill or approval: on the step the sign-in recorded last, as the state the page showed after the
 * one noted before (`stateAfter`). A step that takes a private answer is noted with no instruction
 * or ways, which may hold its question, and with `questionShape` its message, which may hold it
 * too, as a shape alone (`textShape`): a core before the one that reads such a message doesn't
 * match it. A recipe never holds it: its steps are written field by field.
 */
export const noteSignInState = (
  signIn: { readonly steps: readonly object[] },
  observed: ObservedState,
  options?: { readonly questionShape?: boolean },
) => {
  const step = signIn.steps.at(-1);
  if (step === undefined) return;
  const before: unknown = Reflect.get(signIn, readingField);
  const after = stateAfter(Schema.is(ObservedShape)(before) ? before : undefined, observed);
  const fields: unknown = Reflect.get(step, "fields");
  const privateAnswer =
    Array.isArray(fields) &&
    fields.some((field: unknown) => typeof field === "object" && field !== null && Reflect.get(field, "slot") === "private_answer");
  const { message, instruction: _instruction, ways: _ways, ...look } = after;
  const shaped =
    message === undefined ? look : { ...look, message: options?.questionShape === true ? textShape(message) : message };
  Object.assign(step, { [fingerprintField]: privateAnswer ? shaped : after });
  Object.assign(signIn, { [readingField]: observed });
};
const ObservedShape = Schema.Struct({
  fingerprint: StateFingerprint,
  boxes: Schema.Array(
    Schema.Struct({ ...StateBox.fields, empty: Schema.Boolean, submit: Schema.Boolean }),
  ),
  texts: Schema.Array(Schema.String),
});

/**
 * The states a recorded sign-in passed through, for `appendSignInStates`: `steps` are the ones its
 * recipe was written from, in order, each noted by `noteSignInState`; leading steps with no note,
 * a replay's own before a repair went on, are left out, and `from` is the known state the repair
 * went on from. A noted step followed by one with no note, a step count that is not the recipe's,
 * or no note at all fails with the first step that has none (`missingFingerprint`), never quietly.
 * A recorded step whose page sent it itself (`pageSends`) marks its recipe step so, when that step
 * names a submit or submit key.
 */
export const observedSignInOf = (
  steps: readonly object[],
  recipe: { readonly steps: readonly AutofillRecipeStep[]; readonly signedIn: AutofillSignedIn },
  from?: string,
): ObservedSignIn | { readonly missingFingerprint: number } => {
  const noted = steps.map((step) =>
    Option.getOrUndefined(
      Schema.decodeUnknownOption(StateFingerprint)(Reflect.get(step, fingerprintField)),
    ),
  );
  const first = noted.findIndex((fingerprint) => fingerprint !== undefined);
  const gap = noted.findIndex((fingerprint, index) => index > first && fingerprint === undefined);
  if (first < 0 || gap >= 0 || steps.length !== recipe.steps.length)
    return { missingFingerprint: first < 0 ? 0 : gap >= 0 ? gap : Math.min(steps.length, recipe.steps.length) };
  return {
    ...(from === undefined ? {} : { from }),
    states: recipe.steps.slice(first).map((step, index) => ({
      fingerprint: noted[first + index] as StateFingerprint,
      step:
        Reflect.get(steps[first + index] ?? {}, "pageSends") === true &&
        (step.submit !== undefined || step.submitKey !== undefined)
          ? { ...step, pageSends: true as const }
          : step,
    })),
    signedIn: recipe.signedIn,
  };
};

/** An entry's stored bytes. */
export const signInStateEntryText = (entry: SignInStateEntry) => canonical(entry);

/**
 * A stored entry read back: undefined for a format this host does not know, a malformed entry, or
 * one whose key is not its content's.
 */
export const decodeSignInStateEntry = (stored: unknown): SignInStateEntry | undefined => {
  const value = typeof stored === "string" ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson())(stored)) : stored;
  const entry = Option.getOrUndefined(Schema.decodeUnknownOption(SignInStateEntry)(value));
  return entry !== undefined && keyed(entry) === entry.key ? entry : undefined;
};

/**
 * Stored entries read back (`decodeSignInStateEntry`), and how many of them this host could not
 * read and left out (`dropped`), for a host to report: a transition to or from one left out then
 * leads nowhere.
 */
export const decodeSignInStateEntries = (stored: readonly unknown[]) => {
  const entries = stored.flatMap((entry) => decodeSignInStateEntry(entry) ?? []);
  return { entries, dropped: stored.length - entries.length };
};

/** A library: the site's header, and its entries of each kind in the order they were stored. */
export interface SignInStates {
  readonly workspace?: { readonly parent: string } | undefined;
  readonly states: readonly StateEntry[];
  readonly transitions: readonly TransitionEntry[];
  readonly signedIn: readonly SignedInEntry[];
}

/**
 * The library of a site's entries in the order they were stored, each key once, the first kept.
 * Earlier is older. A workspace step needs the header's workspace, and is left out without one.
 */
export const signInStatesOf = (
  header: { readonly workspace?: { readonly parent: string } | undefined },
  entries: readonly SignInStateEntry[],
): SignInStates => {
  const seen = new Set<string>();
  const once = entries.filter((entry) => !seen.has(entry.key) && seen.add(entry.key));
  return {
    ...(header.workspace === undefined ? {} : { workspace: header.workspace }),
    states: once.filter(
      (entry): entry is StateEntry =>
        entry.kind === "state" &&
        (entry.step.origin !== "workspace" || header.workspace !== undefined),
    ),
    transitions: once.filter((entry): entry is TransitionEntry => entry.kind === "transition"),
    signedIn: once.filter((entry): entry is SignedInEntry => entry.kind === "signed_in"),
  };
};

/** The library's steps in a recipe's step shape, for the reviews a recipe's steps go through. */
export const signInStatesSteps = (
  entries: SignInStates | readonly SignInStateEntry[],
): readonly AutofillRecipeStep[] =>
  ("states" in entries ? entries.states : entries.filter((entry) => entry.kind === "state")).map(
    (entry) => (entry as StateEntry).step,
  );

/** The library as a recipe: its states' steps, written as `autofillRecipe` writes them, and `marker`. */
const recipeOf = (library: SignInStates, states: readonly StateEntry[], marker: SignedInEntry | undefined) => {
  if (marker === undefined || states.length === 0) return undefined;
  const steps = signInStatesSteps(states).map((step) => ({
    ...step,
    fields: step.fields.map(
      (field): AutofillField => ("accepts" in field ? { ...field, slot: field.accepts[0] ?? "email" } : field),
    ),
  }));
  return autofillRecipe(
    steps,
    {
      ...(marker.selector === undefined ? {} : { selector: marker.selector }),
      ...(marker.urlPath === undefined ? {} : { urlPath: marker.urlPath }),
      ...(marker.openPath === undefined ? {} : { openPath: marker.openPath }),
    },
    library.workspace === undefined ? {} : { workspace: library.workspace },
  ) as AutofillRecipe;
};

/**
 * States in the order a sign-in goes through them, as the transitions between them say, one at a
 * time: the first in library order that every state leading to it comes before, or, where none
 * is, as on a loop, the first not yet listed.
 */
const routeOrder = (states: readonly StateEntry[], transitions: readonly TransitionEntry[]) => {
  const keys = new Set(states.map((state) => state.key));
  const links = transitions.filter(({ from, to }) => from !== to && keys.has(from) && keys.has(to));
  const listed: StateEntry[] = [];
  const unlisted = (state: StateEntry) => !listed.includes(state);
  const ready = (state: StateEntry) =>
    unlisted(state) && links.every(({ from, to }) => to !== state.key || listed.some((before) => before.key === from));
  const pick = () => states.find(ready) ?? states.find(unlisted);
  for (let next = pick(); next !== undefined; next = pick()) listed.push(next);
  return listed;
};

/**
 * The library as one login's recipe, for the checks a host runs on a recipe's steps and marker:
 * the steps of its states but a step-up's (`stepUp`) in the order a sign-in goes through them
 * (`routeOrder`), written as `autofillRecipe` writes them, and the marker the login reached last
 * (`choices.signedIn`), else the newest, never a step-up's. A view, never a recipe to store: it
 * may hold more steps than a recipe may. Undefined with no such state or marker.
 */
export const signInStatesRecipe = (
  library: SignInStates,
  choices?: SignInStatesChoices,
): AutofillRecipe | undefined => {
  const markers = library.signedIn.filter((entry) => entry.stepUp !== true);
  return recipeOf(
    library,
    routeOrder(library.states.filter((entry) => entry.stepUp !== true), library.transitions),
    markers.find((entry) => entry.key === choices?.signedIn) ?? markers.at(-1),
  );
};

/**
 * The library as a replay in place reads it, as any replay reads one with no step-up: the steps of
 * every state, a step-up's and the site's own sign-in's, in library order, and the step-up marker
 * the login reached last (`choices.signedIn`), else the newest step-up marker; with none, the
 * marker `signInStatesRecipe` takes. Undefined with no state or no marker.
 */
export const signInStatesStepUpRecipe = (
  library: SignInStates,
  choices?: SignInStatesChoices,
): AutofillRecipe | undefined => {
  const picked = (markers: readonly SignedInEntry[]) =>
    markers.find((entry) => entry.key === choices?.signedIn) ?? markers.at(-1);
  const own = library.signedIn.filter((entry) => entry.stepUp !== true);
  return recipeOf(library, library.states, picked(library.signedIn.filter(isStepUpEntry)) ?? picked(own));
};

/**
 * Each step-up's recipe, one for each step-up marker in library order: the step-up states that
 * lead to that marker, and a state of the site's own sign-in a step-up was recorded from
 * (`ObservedSignIn.from`), in library order, so the first is where that step-up starts; and the
 * marker. None for a library with no step-up.
 */
export const signInStatesStepUps = (library: SignInStates): readonly AutofillRecipe[] => {
  const tagged = new Set(library.states.filter(isStepUpEntry).map((entry) => entry.key));
  const states = new Set(library.states.map((entry) => entry.key));
  return library.signedIn.filter(isStepUpEntry).flatMap((marker) => {
    const leads = new Set([marker.key]);
    const queue = [marker.key];
    // Back through the step-up's own states, to the site's state it went on from, if any.
    for (const at of queue)
      for (const { from, to } of library.transitions)
        if (to === at && states.has(from) && !leads.has(from)) {
          leads.add(from);
          if (tagged.has(from)) queue.push(from);
        }
    const recipe = recipeOf(library, library.states.filter((entry) => leads.has(entry.key)), marker);
    return recipe === undefined ? [] : [recipe];
  });
};

/**
 * A sign-in a build or repair recorded: each state it arrived at, as observed before it acted,
 * with the step it took there, and the marker it signed in by. `from` is the known state a repair
 * went on from, where the library's replay stopped at a state it did not know. `to` is the look of
 * the page its last step led to, for a sign-in that stopped there before it signed in, such as one
 * whose person left that page's question unanswered: a state the library already knows, of the
 * same sign-in (a step-up's, or the site's own), which its last step leads to in place of the
 * marker it never reached, so `signedIn` is not stored then. `stepUp` says it is a step-up,
 * recorded from a signed-in session's page that asked for the login again.
 */
export interface ObservedSignIn {
  readonly from?: string | undefined;
  readonly to?: StateFingerprint | undefined;
  readonly stepUp?: true | undefined;
  readonly states: readonly {
    readonly fingerprint: StateFingerprint;
    readonly step: SignInStateStep;
  }[];
  readonly signedIn: AutofillSignedIn;
}

/** How many states a library holds at most. */
export const maximumStates = 64;

/**
 * The library with a recorded sign-in's new entries appended after every existing one, which stay
 * as they are, and those entries (`added`), none when it knew them all. A state is known by its
 * key, its fingerprint and step alike. A sign-in that stopped before it signed in (`to`) leads to
 * the oldest known state of its own sign-in with that look and top origin, never one the page only
 * reads on (`readsOn`), a step-up's for a step-up, and adds no marker. Refused: a workspace step in
 * a library with no workspace, or a new entry this core can't read back from its stored bytes
 * (`decodeSignInStateEntry`), as a step with a field no reader knows, which a reader would leave out
 * (`unsupported_step`); a state that shows nothing to tell it by; a `to` no such state looks like
 * (`unknown_state`); and a library that would pass `maximumStates`.
 */
export const appendSignInStates = (
  library: SignInStates,
  observed: ObservedSignIn,
):
  | { readonly library: SignInStates; readonly added: readonly SignInStateEntry[] }
  | { readonly refused: "unsupported_step" | "blank_state" | "unknown_state" | "library_full" } => {
  if (observed.states.some(({ step }) => step.origin === "workspace" && library.workspace === undefined))
    return { refused: "unsupported_step" };
  if (observed.states.some(({ fingerprint }) => blankFingerprint(fingerprint)))
    return { refused: "blank_state" };
  const { to } = observed;
  const led =
    to === undefined
      ? undefined
      : library.states.find(
          (state) =>
            (state.stepUp === true) === (observed.stepUp === true) &&
            state.fingerprint.top === to.top &&
            sameFingerprint(state, to),
        );
  if (to !== undefined && led === undefined) return { refused: "unknown_state" };
  const states = observed.states.map(({ fingerprint, step }) => stateEntry(fingerprint, step, "recorded", observed.stepUp));
  const end = led ?? signedInEntry(observed.signedIn, observed.stepUp);
  const path = [...(observed.from === undefined ? [] : [observed.from]), ...states.map((s) => s.key), end.key];
  const fresh = [
    ...states,
    ...(led === undefined ? [end] : []),
    ...path.slice(1).map((next, index) => transitionEntry(path[index] ?? "", next)),
  ];
  const known = new Set(
    [...library.states, ...library.transitions, ...library.signedIn].map((entry) => entry.key),
  );
  const added = fresh.filter((entry) => !known.has(entry.key) && known.add(entry.key));
  if (added.some((entry) => decodeSignInStateEntry(signInStateEntryText(entry)) === undefined))
    return { refused: "unsupported_step" };
  const growth = added.filter((entry) => entry.kind === "state").length;
  if (library.states.length + growth > maximumStates) return { refused: "library_full" };
  return {
    library: signInStatesOf(library, [
      ...library.states,
      ...library.transitions,
      ...library.signedIn,
      ...added,
    ]),
    added,
  };
};

/**
 * A login's own picks, which the host keeps and gives the next replay as they came back: the
 * states it used last, its route, which alone it takes where known states share a look it holds;
 * the code method it chose; and the signed-in marker it reached.
 */
export const SignInStatesChoices = Schema.Struct({
  states: Schema.optional(Schema.Array(Key).pipe(Schema.maxItems(32))),
  method: Schema.optional(SignInMethodChoice),
  signedIn: Schema.optional(Key),
});
export type SignInStatesChoices = typeof SignInStatesChoices.Type;
