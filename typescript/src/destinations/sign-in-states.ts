import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
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

/** An origin, or `workspace` for the login's own workspace host. */
const Origin = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000));
const Label = Schema.String.pipe(Schema.maxLength(200));

/** One visible empty box: its frame's origin, its kind, and a code row's box count. */
export const StateBox = Schema.Struct({
  frame: Origin,
  kind: BoxKind,
  count: Schema.optional(Schema.Int.pipe(Schema.between(2, 12))),
});
export type StateBox = typeof StateBox.Type;

/**
 * What the sign-in shows now, ignoring text, layout and path: the top page's origin, each visible
 * empty box on a sign-in origin, and whether a submit sits in their form. A state with no box is
 * told by its main message and its buttons, normalized so a name, an address or a number never
 * shows; text counts nowhere else.
 */
export const StateFingerprint = Schema.Struct({
  top: Origin,
  boxes: Schema.Array(StateBox).pipe(Schema.maxItems(24)),
  submit: Schema.Boolean,
  message: Schema.optional(Label),
  buttons: Schema.optional(Schema.Array(Label).pipe(Schema.maxItems(8))),
});
export type StateFingerprint = typeof StateFingerprint.Type;

const Key = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{16}$/u));
const Marker = LegacyAutofillRecipe.fields.signedIn;

/** A recorded step on an absolute page, or a workspace step on a path. */
const StateStep = HandOffRecipeStep.pipe(
  Schema.filter(
    (step) =>
      (step.origin === "workspace" ? step.page.startsWith("/") : URL.parse(step.page) !== null) ||
      "a workspace step's page is a path, and any other step's an absolute URL",
  ),
);

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
/**
 * One stored entry of a library, format 1: a state with the step recorded there; a transition
 * from one entry's key to the next; or a signed-in marker. `source` says whether a sign-in recorded
 * the state or it was derived from a recipe.
 */
export const SignInStateEntry = Schema.Union(
  Schema.Struct({
    format: Schema.Literal(1),
    kind: Schema.Literal("state"),
    key: Key,
    source: Schema.Literal("recorded", "derived"),
    fingerprint: StateFingerprint,
    step: StateStep,
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
  }).annotations(strict),
);
export type SignInStateEntry = typeof SignInStateEntry.Type;
export type StateEntry = Extract<SignInStateEntry, { readonly kind: "state" }>;
export type TransitionEntry = Extract<SignInStateEntry, { readonly kind: "transition" }>;
export type SignedInEntry = Extract<SignInStateEntry, { readonly kind: "signed_in" }>;

/** JSON with every object's keys sorted and undefined dropped: the same value is the same bytes. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner)
            .filter(([, field]) => field !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
const keyOf = (content: unknown) =>
  createHash("sha256").update(canonical(content)).digest("hex").slice(0, 16);

/** A fingerprint in its one written form: boxes and buttons sorted. */
export const fingerprintOf = (fingerprint: StateFingerprint): StateFingerprint => ({
  top: fingerprint.top,
  boxes: [...fingerprint.boxes].sort((a, b) => canonical(a).localeCompare(canonical(b))),
  submit: fingerprint.submit,
  ...(fingerprint.message === undefined ? {} : { message: fingerprint.message }),
  ...(fingerprint.buttons === undefined ? {} : { buttons: [...fingerprint.buttons].sort() }),
});
export const fingerprintText = (fingerprint: StateFingerprint) => canonical(fingerprintOf(fingerprint));
export const sameFingerprint = (a: StateFingerprint, b: StateFingerprint) =>
  fingerprintText(a) === fingerprintText(b);
/** Whether a fingerprint shows nothing to tell it by: no box, no message and no button. */
export const blankFingerprint = (fingerprint: StateFingerprint) =>
  fingerprint.boxes.length === 0 &&
  fingerprint.message === undefined &&
  (fingerprint.buttons ?? []).length === 0;

/**
 * Whether `outer` holds every box of `inner` and more, on the same top origin: a page that may
 * still grow from `inner` into `outer`, as a sign-in whose password box draws late.
 */
export const containsFingerprint = (inner: StateFingerprint, outer: StateFingerprint) => {
  if (inner.top !== outer.top || inner.boxes.length === 0) return false;
  const left = outer.boxes.map((box) => canonical(box));
  for (const box of inner.boxes) {
    const at = left.indexOf(canonical(box));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return left.length > 0;
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
  return `A sign-in state on ${fingerprint.top}: ${shown}.`;
};

/** The entry for a state, keyed by its fingerprint and step. */
export const stateEntry = (
  fingerprint: StateFingerprint,
  step: AutofillRecipeStep,
  source: "recorded" | "derived" = "recorded",
): StateEntry => {
  const written = fingerprintOf(fingerprint);
  return {
    format: 1,
    kind: "state",
    key: keyOf({ fingerprint: written, step }),
    source,
    fingerprint: written,
    step,
  };
};
const transitionEntry = (from: string, to: string): TransitionEntry => ({
  format: 1,
  kind: "transition",
  key: keyOf({ from, to }),
  from,
  to,
});
const signedInEntry = (marker: AutofillSignedIn): SignedInEntry => {
  const fields = {
    ...(marker.selector === undefined ? {} : { selector: marker.selector }),
    ...(marker.urlPath === undefined ? {} : { urlPath: marker.urlPath }),
    ...(marker.openPath === undefined ? {} : { openPath: marker.openPath }),
  };
  return { format: 1, kind: "signed_in", key: keyOf(fields), ...fields };
};
const keyed = (entry: SignInStateEntry) => {
  if (entry.kind === "state") return stateEntry(entry.fingerprint, entry.step, entry.source).key;
  if (entry.kind === "transition") return transitionEntry(entry.from, entry.to).key;
  return signedInEntry(entry).key;
};

/** A counted box as read: whether it is empty, and whether a submit sits in its form. */
export interface ObservedBox extends StateBox {
  readonly empty: boolean;
  readonly submit: boolean;
}

/**
 * The page as read: `fingerprint` from its empty boxes, or from its message and buttons when it
 * shows none; every counted box (`boxes`); and its visible texts, normalized (`texts`).
 */
export interface ObservedState {
  readonly fingerprint: StateFingerprint;
  readonly boxes: readonly ObservedBox[];
  readonly texts: readonly string[];
}

/** The page's boxes as they stand since `reached`: the empty ones, and the ones filled since. */
export const standingFingerprint = (reached: ObservedState, now: ObservedState): StateFingerprint => {
  const before = reached.boxes.filter((box) => !box.empty).map((box) => boxText(box));
  const boxes = now.boxes.filter((box) => {
    const at = box.empty ? -1 : before.indexOf(boxText(box));
    if (at >= 0) before.splice(at, 1);
    return at < 0;
  });
  return fingerprintOf({
    top: now.fingerprint.top,
    boxes: boxes.map(({ frame, kind, count }) => ({ frame, kind, ...(count === undefined ? {} : { count }) })),
    submit: boxes.some((box) => box.submit),
  });
};
const boxText = ({ frame, kind, count }: StateBox) => canonical({ frame, kind, count });
const sameBoxes = (a: StateFingerprint, b: StateFingerprint) =>
  a.top === b.top &&
  canonical(fingerprintOf(a).boxes.map(boxText)) === canonical(fingerprintOf(b).boxes.map(boxText));

/**
 * The state the page shows after an action in the state it showed when read as `reached`: the
 * same boxes, typed or not, with a text that was not there then, as a notice under a sign-in form
 * after its submit, is that state's boxes and the first such text; the same boxes alone are that
 * state again; anything else is the page's own fingerprint. Text counts beside boxes nowhere else.
 */
export const stateAfter = (reached: ObservedState | undefined, now: ObservedState): StateFingerprint => {
  if (reached === undefined || reached.fingerprint.boxes.length === 0) return now.fingerprint;
  const { top, boxes, submit } = reached.fingerprint;
  const plain = fingerprintOf({ top, boxes, submit });
  if (!sameBoxes(standingFingerprint(reached, now), plain)) return now.fingerprint;
  const fresh = now.texts.find((text) => !reached.texts.includes(text));
  return fresh === undefined ? plain : fingerprintOf({ ...plain, message: fresh });
};

/** The plain fields a recorded step and its sign-in carry for states, which survive a copy. */
const fingerprintField = "stateFingerprint";
const readingField = "stateReading";

/**
 * Notes the state a build's or repair's sign-in step was taken in, read just before that step's
 * fill or approval: on the step the sign-in recorded last, as the state the page showed after the
 * one noted before (`stateAfter`). A recipe never holds it: its steps are written field by field.
 */
export const noteSignInState = (
  signIn: { readonly steps: readonly object[] },
  observed: ObservedState,
) => {
  const step = signIn.steps.at(-1);
  if (step === undefined) return;
  const before: unknown = Reflect.get(signIn, readingField);
  Object.assign(step, {
    [fingerprintField]: stateAfter(Schema.is(ObservedShape)(before) ? before : undefined, observed),
  });
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
      step,
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

/**
 * The library as one login's recipe, for the checks a host runs on a recipe's steps and marker:
 * its steps in library order, written as `autofillRecipe` writes them, and the marker the login
 * reached last (`choices.signedIn`), else the newest. A view, never a recipe to store: it may hold
 * more steps than a recipe may. Undefined with no state or no marker.
 */
export const signInStatesRecipe = (
  library: SignInStates,
  choices?: SignInStatesChoices,
): AutofillRecipe | undefined => {
  const marker =
    library.signedIn.find((entry) => entry.key === choices?.signedIn) ?? library.signedIn.at(-1);
  if (marker === undefined || library.states.length === 0) return undefined;
  const steps = signInStatesSteps(library).map((step) => ({
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
 * A sign-in a build or repair recorded: each state it arrived at, as observed before it acted,
 * with the step it took there, and the marker it signed in by. `from` is the known state a repair
 * went on from, where the library's replay stopped at a state it did not know.
 */
export interface ObservedSignIn {
  readonly from?: string | undefined;
  readonly states: readonly {
    readonly fingerprint: StateFingerprint;
    readonly step: AutofillRecipeStep;
  }[];
  readonly signedIn: AutofillSignedIn;
}

/** How many states a library holds at most. */
export const maximumStates = 64;

/**
 * The library with a recorded sign-in's new entries appended after every existing one, which stay
 * as they are, and those entries (`added`), none when it knew them all. A state is known by its
 * key, its fingerprint and step alike. Refused: a hand-off step, which a library never runs; a
 * state that shows nothing to tell it by; and a library that would pass `maximumStates`.
 */
export const appendSignInStates = (
  library: SignInStates,
  observed: ObservedSignIn,
):
  | { readonly library: SignInStates; readonly added: readonly SignInStateEntry[] }
  | { readonly refused: "unsupported_step" | "blank_state" | "library_full" } => {
  if (observed.states.some(({ step }) => step.approval === "handoff"))
    return { refused: "unsupported_step" };
  if (observed.states.some(({ fingerprint }) => blankFingerprint(fingerprint)))
    return { refused: "blank_state" };
  const states = observed.states.map(({ fingerprint, step }) => stateEntry(fingerprint, step));
  const marker = signedInEntry(observed.signedIn);
  const path = [...(observed.from === undefined ? [] : [observed.from]), ...states.map((s) => s.key), marker.key];
  const fresh = [
    ...states,
    marker,
    ...path.slice(1).map((to, index) => transitionEntry(path[index] ?? "", to)),
  ];
  const known = new Set(
    [...library.states, ...library.transitions, ...library.signedIn].map((entry) => entry.key),
  );
  const added = fresh.filter((entry) => !known.has(entry.key) && known.add(entry.key));
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
 * states it used last, which win where two known states match; the code method it chose; and the
 * signed-in marker it reached.
 */
export const SignInStatesChoices = Schema.Struct({
  states: Schema.optional(Schema.Array(Key).pipe(Schema.maxItems(32))),
  method: Schema.optional(SignInMethodChoice),
  signedIn: Schema.optional(Key),
});
export type SignInStatesChoices = typeof SignInStatesChoices.Type;
