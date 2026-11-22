import { Data, Effect } from "effect";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import {
  appendSignInStates,
  type BoxKind,
  type BoxTakes,
  decodeSignInStateEntry,
  type ObservedState,
  signInStateEntryText,
  type SignInStates,
  signInStatesOf,
  type StateFingerprint,
} from "../../src/destinations/sign-in-states.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { typedValues } from "../../src/runtime/autofill-values.js";

// A scripted sign-in site for a replay from states. Its fill acts on a step as core's own fill
// does on a page: it clicks a covering notice's control the step names before it types, and a
// notice still showing catches the submit's click; a submit another element covers goes only as
// the step says (`submitVia`); a native select picks only the step's `option`; and each value is
// typed as a host types it (`typedValues`).

export class SiteFailure extends Data.TaggedError("SiteFailure")<{ readonly code: string }> {}

export const origin = "https://example.test";

/** One screen of the site. */
export interface Screen {
  readonly path: string;
  /** Each box: as the scan reads it, and the security question shown beside an answer box. */
  readonly boxes: readonly {
    readonly selector: string;
    readonly kind: BoxKind;
    readonly takes?: BoxTakes;
    readonly question?: string;
  }[];
  /** Its buttons, links and selects. */
  readonly controls: readonly string[];
  /** What a screen with no empty box is told by: its message and its buttons' labels. */
  readonly message?: string;
  readonly labels?: readonly string[];
  /** A notice over the screen, shown on arrival or drawn once every box is typed, and its own control. */
  readonly notice?: { readonly control: string; readonly drawn: "arrival" | "filled" };
  /** The submit sits under another element, so it goes only from the keyboard or through it. */
  readonly covered?: NonNullable<AutofillStep["submitVia"]>;
}

/**
 * The site: `start` first, then the screen `next` names for a press there, signed in at `home`. It
 * logs each action (`actions`), keeps each value as typed (`typed`) and each press's step.
 */
export const featureSite = (
  screens: Readonly<Record<string, Screen>>,
  next: (screen: string, pressed: string, step: AutofillStep) => string | undefined,
) => {
  const site = { screen: "start", boxes: new Map<string, string>(), dismissed: false };
  const actions: string[] = [];
  const typed: { readonly slot: string; readonly value: string }[] = [];
  const presses: AutofillStep[] = [];
  const shown = (): Screen => screens[site.screen] ?? { path: "/home", boxes: [], controls: [] };
  const page = () => `${origin}${shown().path}`;
  const here = (): AutofillSignedInCheck =>
    site.screen === "home"
      ? { signedIn: true, url: page() }
      : { signedIn: false, failed: "indicator_not_visible", url: page() };
  const noticeShows = () => {
    const notice = shown().notice;
    return (
      notice !== undefined &&
      !site.dismissed &&
      (notice.drawn === "arrival" || shown().boxes.every((box) => site.boxes.has(box.selector)))
    );
  };
  const controls = () => [...shown().boxes.map((box) => box.selector), ...shown().controls];
  const report = (step: AutofillStep, submit: "clicked" | "blocked" | "none"): AutofillStepReport => ({
    outcome: "filled",
    fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
    submit,
    url: page(),
  });
  const hooks: AutofillHooks<SiteFailure> = {
    open: () =>
      Effect.sync(() => {
        site.screen = "start";
        site.boxes.clear();
        site.dismissed = false;
      }),
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    markerVisible: () => Effect.succeed(false),
    inspect: (step) =>
      Effect.sync((): AutofillInspection | AutofillRefusal => {
        const missing = step.fields.findIndex((field) => !controls().includes(field.selector));
        if (missing >= 0) return { outcome: "refused", reason: "not_found", target: missing };
        if (step.submit !== undefined && !controls().includes(step.submit))
          return { outcome: "refused", reason: "not_found", target: "submit" };
        const target = {
          ownerUrl: null,
          documentOrigin: origin,
          actions: [`${origin}/session`],
          methods: ["post"],
          editable: true,
          control: "text" as const,
        };
        return {
          url: page(),
          page: page(),
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => {
              // The host reads a security question by the field's own question selector alone.
              const question = shown().boxes.find((box) => box.selector === field.selector)?.question;
              return {
                tag: "input",
                role: null,
                formMethod: "post",
                type: "text",
                name: null,
                id: null,
                autocomplete: null,
                inputmode: null,
                label: null,
                placeholder: null,
                ariaLabel: null,
                text: null,
                slot: field.slot,
                ...(field.questionSelector === undefined || question === undefined ? {} : { questionText: question }),
              };
            }),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values }) =>
      Effect.sync((): AutofillStepReport => {
        if (step.dismiss !== undefined && step.dismiss === shown().notice?.control && noticeShows()) {
          actions.push(`dismiss ${step.dismiss}`);
          site.dismissed = true;
        }
        const keyed = typedValues(step, values);
        step.fields.forEach((field, index) => {
          actions.push(`type ${field.selector}`);
          typed.push({ slot: field.slot, value: keyed[index] ?? "" });
          site.boxes.set(field.selector, keyed[index] ?? "");
        });
        const pressed = step.submit ?? (step.submitKey === undefined ? undefined : "Enter");
        if (pressed === undefined) return report(step, "none");
        const covered = shown().covered;
        if (noticeShows() || (covered !== undefined && step.submitKey === undefined && step.submitVia !== covered))
          return report(step, "blocked");
        actions.push(step.option === undefined ? `press ${pressed}` : `select ${pressed} ${step.option}`);
        presses.push(step);
        const to = next(site.screen, pressed, step);
        if (to !== undefined && to !== site.screen) {
          site.screen = to;
          site.boxes.clear();
          site.dismissed = false;
        }
        return report(step, "clicked");
      }),
  };
  const observe = Effect.sync((): ObservedState => {
    const screen = shown();
    const boxes = screen.boxes.map((box) => ({
      ...lookOf(box),
      empty: !site.boxes.has(box.selector),
      submit: true,
    }));
    const empty = boxes.filter((box) => box.empty);
    return {
      fingerprint: {
        top: origin,
        boxes: empty.map(({ empty: _empty, submit: _submit, ...box }) => box),
        submit: empty.length > 0,
        ...(empty.length > 0 ? {} : { message: screen.message ?? "", buttons: [...(screen.labels ?? [])] }),
      },
      boxes,
      texts: screen.message === undefined ? [] : [screen.message],
    };
  });
  return { hooks, observe, site, actions, typed, presses };
};

const lookOf = ({ kind, takes }: Screen["boxes"][number]) => ({
  frame: origin,
  kind,
  ...(takes === undefined ? {} : { takes }),
});

/** The look a screen shows on arrival, every box empty. */
export const arrival = (screen: Screen): StateFingerprint => ({
  top: origin,
  boxes: screen.boxes.map(lookOf),
  submit: screen.boxes.length > 0,
  ...(screen.boxes.length > 0 ? {} : { message: screen.message ?? "", buttons: [...(screen.labels ?? [])] }),
});

/** A step recorded on `screen`. */
export const stepOn = (screen: Screen, step: Omit<AutofillRecipeStep, "page">) =>
  ({ page: `${origin}${screen.path}`, ...step }) as AutofillRecipeStep;

/**
 * A library of recorded sign-ins, each a list of screens with the step taken there, as a host
 * stores it and reads it back: every entry written as text and decoded again.
 */
export const storedLibrary = (
  ...signIns: readonly (readonly (readonly [Screen, AutofillRecipeStep])[])[]
): SignInStates => {
  const library = signIns.reduce<SignInStates>((built, states) => {
    const appended = appendSignInStates(built, {
      states: states.map(([screen, step]) => ({ fingerprint: arrival(screen), step })),
      signedIn: { selector: "#account" },
    });
    if ("refused" in appended) throw new Error(appended.refused);
    return appended.library;
  }, signInStatesOf({}, []));
  const entries = [...library.states, ...library.transitions, ...library.signedIn].map((entry) => {
    const read = decodeSignInStateEntry(signInStateEntryText(entry));
    if (read === undefined) throw new Error(`entry ${entry.key} does not read back`);
    return read;
  });
  return signInStatesOf({}, entries);
};
