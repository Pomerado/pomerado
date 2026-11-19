import { Data, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import {
  appendSignInStates,
  type BoxKind,
  decodeSignInStateEntry,
  noteSignInState,
  type ObservedState,
  observedSignInOf,
  signInStateEntryText,
  type SignInStates,
  signInStatesOf,
  type StateFingerprint,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";

// A sign-in replayed from a library of states on a scripted site: the page is read as a state
// after each action, matched to a known one and handled there.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const link = `${origin}/magic?token=abc`;

/** A screen: its path, its boxes by selector and kind, its buttons, and its visible texts. */
interface Screen {
  readonly path: string;
  readonly boxes: readonly { readonly selector: string; readonly kind: BoxKind }[];
  readonly buttons?: readonly string[];
  readonly texts?: readonly string[];
  /** The origin of the frame the boxes sit in, when not the page's own. */
  readonly frame?: string;
  /** Recorded error markers the screen shows. */
  readonly errors?: readonly string[];
}

/**
 * A scripted site on fixture hooks: `next` says the screen a click on a screen goes to; `home` is
 * signed in. `looks` counts the page reads, for a screen that draws late.
 */
const scriptedSite = (
  screens: Readonly<Record<string, Screen | ((looks: number) => Screen)>>,
  next: (screen: string, clicked: string) => string | undefined,
) => {
  const site = { screen: "start", looks: 0, typed: new Map<string, string>(), opened: [] as string[] };
  const clicks: string[] = [];
  const fills: string[] = [];
  const shown = (): Screen => {
    const screen = screens[site.screen];
    return typeof screen === "function" ? screen(site.looks) : (screen ?? { path: "/home", boxes: [] });
  };
  const page = () => `${origin}${shown().path}`;
  const here = (): AutofillSignedInCheck =>
    site.screen === "home"
      ? { signedIn: true, url: page() }
      : { signedIn: false, failed: "indicator_not_visible", url: page() };
  const controls = () => [...shown().boxes.map((box) => box.selector), ...(shown().buttons ?? [])];
  const hooks: AutofillHooks<TestFailure> = {
    open: (url) =>
      Effect.sync(() => {
        if (url === link) {
          site.opened.push(url);
          site.screen = "home";
          return;
        }
        site.screen = "start";
        site.typed.clear();
      }),
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    markerVisible: (selector) => Effect.sync(() => (shown().errors ?? []).includes(selector)),
    inspect: (step) =>
      Effect.sync((): AutofillInspection | AutofillRefusal => {
        const missing = step.fields.findIndex((field) => !controls().includes(field.selector));
        if (missing >= 0) return { outcome: "refused", reason: "not_found", target: missing };
        if (step.submit !== undefined && !controls().includes(step.submit))
          return { outcome: "refused", reason: "not_found", target: "submit" };
        const target = {
          ownerUrl: shown().frame ?? null,
          documentOrigin: shown().frame ?? origin,
          actions: [`${origin}/session`],
          methods: ["post"],
          editable: true,
          control: "text" as const,
        };
        return {
          url: page(),
          page: page(),
          targets: {
            fields: step.fields.map(() => target),
            submit: step.submit === undefined ? null : target,
          },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({
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
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values }) =>
      Effect.sync((): AutofillStepReport => {
        step.fields.forEach((field, index) => {
          fills.push(field.slot);
          site.typed.set(field.selector, values[index] ?? "");
        });
        if (step.submit !== undefined) {
          clicks.push(step.submit);
          const to = next(site.screen, step.submit);
          if (to !== undefined && to !== site.screen) {
            site.screen = to;
            site.typed.clear();
          }
        }
        return {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submit === undefined ? "none" : "clicked",
          url: page(),
        };
      }),
  };
  const observe = Effect.sync((): ObservedState => {
    site.looks += 1;
    const screen = shown();
    const boxes = screen.boxes.map((box) => ({
      frame: screen.frame ?? origin,
      kind: box.kind,
      empty: !site.typed.has(box.selector),
      submit: true,
    }));
    const empty = boxes.filter((box) => box.empty);
    return {
      fingerprint: {
        top: origin,
        boxes: empty.map(({ frame, kind }) => ({ frame, kind })),
        submit: empty.length > 0,
        ...(empty.length > 0 ? {} : { message: screen.texts?.[0] ?? "", buttons: [] }),
      },
      boxes,
      texts: screen.texts ?? [],
    };
  });
  return { hooks, observe, site, clicks, fills };
};

/** The fingerprint a screen shows on arrival, every box empty. */
const arrival = (screen: Screen, message?: string): StateFingerprint => ({
  top: origin,
  boxes: screen.boxes.map((box) => ({ frame: screen.frame ?? origin, kind: box.kind })),
  submit: screen.boxes.length > 0,
  ...(message === undefined ? {} : { message }),
  ...(screen.boxes.length === 0 ? { message: message ?? screen.texts?.[0] ?? "", buttons: [] } : {}),
});

/** A library of recorded sign-ins, each a list of states with their steps, appended in order. */
const libraryOf = (
  ...signIns: readonly (readonly { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep }[])[]
): SignInStates =>
  signIns.reduce<SignInStates>((library, states) => {
    const appended = appendSignInStates(library, { states, signedIn: { selector: "#account" } });
    if ("refused" in appended) throw new Error(appended.refused);
    return appended.library;
  }, signInStatesOf({}, []));

const email = { selector: "#email", accepts: ["email" as const] };
const password = { selector: "#password", slot: "password" as const };
const code = { selector: "#code", slot: "code" as const };
const stepAt = (path: string, fields: AutofillRecipeStep["fields"], submit?: string, more: object = {}) =>
  ({ page: `${origin}${path}`, fields, ...(submit === undefined ? {} : { submit }), ...more }) as AutofillRecipeStep;

const replay = (
  site: ReturnType<typeof scriptedSite>,
  library: SignInStates,
  options: { readonly password?: string; readonly valueFree?: boolean } = {},
) => {
  const asked: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push(question.id);
            return [question.id, question.id === "sign_in_link" ? link : "246810"];
          }),
        ) as InputAnswers,
    ),
  );
  return Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe: site.observe,
        hooks: site.hooks,
        entryUrl: `${origin}/sign-in`,
        credentials: options.valueFree
          ? undefined
          : { username: "owner@example.test", password: options.password ?? "secret-1" },
        ask,
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 300, pollMs: 2 },
        quiet: { quietMs: 20, capMs: 120 },
        sent: { current: false },
      }),
    ),
  ).then((outcome) => {
    if (Either.isLeft(outcome)) throw outcome.left;
    return { ...outcome.right, asked };
  });
};

const emailScreen: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue"] };
const passwordScreen: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#go"] };
const codeScreen: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
const branches = libraryOf(
  [
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ],
  [
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
  ],
);

it("takes the password or the code state the site shows after the same email state", async () => {
  for (const [branch, screen] of [["password", passwordScreen], ["code", codeScreen]] as const) {
    const site = scriptedSite({ start: emailScreen, [branch]: screen }, (at, clicked) =>
      at === "start" && clicked === "#continue" ? branch : clicked === "#continue" ? undefined : "home",
    );
    const ended = await replay(site, branches);
    expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, loginProved: true });
    expect(site.fills).toEqual(["email", branch]);
    expect(ended.choices?.states).toEqual(ended.visited);
  }
});

const combined: Screen = {
  path: "/",
  boxes: [{ selector: "#email", kind: "identifier" }, { selector: "#password", kind: "password" }],
  buttons: ["#continue"],
};
const emailOnly: Screen = { path: "/", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue"] };

it("waits before pressing in a state another known state holds, and takes the fuller one it draws", async () => {
  const library = libraryOf(
    [{ fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") }],
    [
      { fingerprint: arrival(emailOnly), step: stepAt("/", [email], "#continue") },
      { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
    ],
  );
  // The password box draws late: the page first reads as the email-only state.
  const site = scriptedSite({ start: (looks) => (looks < 4 ? emailOnly : combined), code: codeScreen }, (_at, clicked) =>
    clicked === "#continue" ? (site.site.typed.has("#password") ? "home" : "code") : "home",
  );
  const ended = await replay(site, library);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["email", "password"]);
  expect(site.clicks).toEqual(["#continue"]);
});

it("stops when the state it pressed in shows again, never sending the password twice", async () => {
  const library = libraryOf([
    {
      fingerprint: arrival(passwordScreen),
      step: stepAt("/password", [password], "#go", {
        rejectedMarkers: [{ selector: "#wrong", slot: "password" }],
      }),
    },
  ]);
  const repeated = scriptedSite({ start: passwordScreen }, () => "start");
  const ended = await replay(repeated, library);
  expect(ended).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
  expect(repeated.fills).toEqual(["password"]);
  expect(repeated.clicks).toEqual(["#go"]);
  const marked = scriptedSite({ start: passwordScreen, wrong: { ...passwordScreen, errors: ["#wrong"] } }, () => "wrong");
  expect(await replay(marked, library)).toMatchObject({ outcome: "unclear", reason: "password_rejected" });
  expect(marked.fills).toEqual(["password"]);
});

it("never types into a state whose box sits in a frame off its recorded origin", async () => {
  const framed: Screen = { ...emailScreen, frame: "https://auth.example.test" };
  const library = libraryOf([
    { fingerprint: arrival(framed), step: stepAt("/sign-in", [email], "#continue", { page: "https://auth.example.test/sign-in" }) },
  ]);
  const site = scriptedSite({ start: { ...framed, frame: "https://other.example.test" } }, () => "home");
  // The page reads as the recorded state, but its box's frame is on another origin.
  const observe = Effect.map(site.observe, (observed) => ({
    ...observed,
    fingerprint: arrival(framed),
  }));
  const ended = await replay({ ...site, observe }, library);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "screen_origin_changed" });
  expect(site.fills).toEqual([]);
});

it("presses once more a press that typed no secret when the page kept its state", async () => {
  const start: Screen = { path: "/", boxes: [], buttons: ["#sign-in"], texts: ["welcome"] };
  const library = libraryOf([
    { fingerprint: arrival(start), step: stepAt("/", [], "#sign-in") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  let presses = 0;
  const site = scriptedSite({ start, password: passwordScreen }, (at, clicked) =>
    clicked === "#sign-in" ? (++presses > 1 ? "password" : at) : "home",
  );
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#sign-in", "#sign-in", "#go"]);
});

const notice = "check your email for a sign-in link";
const linkLibrary = libraryOf([
  { fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") },
  {
    fingerprint: { ...arrival(combined), message: notice },
    step: stepAt("/", [], undefined, { approval: "email_link" }),
  },
]);

it("opens the pasted link at the same boxes with a new notice after the press, a state of its own", async () => {
  const site = scriptedSite(
    { start: combined, sent: { ...combined, texts: [notice] } },
    (_at, clicked) => (clicked === "#continue" ? "sent" : undefined),
  );
  const ended = await replay(site, linkLibrary);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.site.opened).toEqual([link]);
  expect(ended.asked).toEqual(["sign_in_link"]);
  expect(site.clicks).toEqual(["#continue"]);
});

it("ends at a notice it does not know after the password went, sending nothing again", async () => {
  const site = scriptedSite(
    { start: combined, other: { ...combined, texts: ["we could not find that account"] } },
    (_at, clicked) => (clicked === "#continue" ? "other" : undefined),
  );
  const ended = await replay(site, linkLibrary);
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(ended.unknownState).toMatchObject({ sent: true, fingerprint: { message: "we could not find that account" } });
  expect(site.fills).toEqual(["email", "password"]);
  expect(site.site.opened).toEqual([]);
});

it("stops a value-free check before a press that has the site send a link", async () => {
  const choose: Screen = { path: "/sign-in", boxes: [], buttons: ["#email-me"], texts: ["sign in"] };
  const sent: Screen = { path: "/sent", boxes: [], texts: ["check your inbox"] };
  const library = libraryOf([
    { fingerprint: arrival(choose), step: stepAt("/sign-in", [], "#email-me") },
    { fingerprint: arrival(sent), step: stepAt("/sent", [], undefined, { approval: "email_link" }) },
  ]);
  const site = scriptedSite({ start: choose, sent }, () => "sent");
  expect(await replay(site, library, { valueFree: true })).toMatchObject({
    outcome: "unsent",
    reason: "values_needed",
  });
  expect(site.clicks).toEqual([]);
});

it("appends only what a library did not hold, leaving every stored entry as it was", () => {
  const first = appendSignInStates(signInStatesOf({}, []), {
    states: [{ fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") }],
    signedIn: { selector: "#account" },
  });
  if ("refused" in first) throw new Error(first.refused);
  const stored = first.added.map(signInStateEntryText);
  const again = appendSignInStates(first.library, {
    states: [
      { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
      { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
    ],
    signedIn: { selector: "#account" },
  });
  if ("refused" in again) throw new Error(again.refused);
  const read = [...stored, ...again.added.map(signInStateEntryText)].map(decodeSignInStateEntry);
  expect(read.every((entry) => entry !== undefined)).toBe(true);
  expect(again.added.map((entry) => entry.kind)).toEqual(["state", "transition", "transition"]);
  expect(signInStatesOf({}, read.flatMap((entry) => entry ?? [])).states.map(signInStateEntryText).slice(0, 1)).toEqual(
    stored.slice(0, 1),
  );
  // A stored entry whose key is not its content's reads as none.
  expect(decodeSignInStateEntry(stored[0]?.replace("#continue", "#other"))).toBeUndefined();
});

it("fails loudly when a recorded step carries no state", () => {
  const signIn = { steps: [{ page: `${origin}/sign-in` }, { page: `${origin}/password` }] };
  const reading = (screen: Screen): ObservedState => ({
    fingerprint: arrival(screen),
    boxes: screen.boxes.map((box) => ({ frame: origin, kind: box.kind, empty: true, submit: true })),
    texts: [],
  });
  const recipe = {
    steps: [stepAt("/sign-in", [email], "#continue"), stepAt("/password", [password], "#go")],
    signedIn: { selector: "#account" },
  };
  noteSignInState({ steps: signIn.steps.slice(0, 1) }, reading(emailScreen));
  expect(observedSignInOf(signIn.steps, recipe)).toEqual({ missingFingerprint: 1 });
  noteSignInState(signIn, reading(passwordScreen));
  expect(observedSignInOf(signIn.steps, recipe)).toMatchObject({
    states: [{ fingerprint: arrival(emailScreen) }, { fingerprint: arrival(passwordScreen) }],
  });
});
