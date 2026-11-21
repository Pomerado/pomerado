import { inspect } from "node:util";
import { Clock, Data, Duration, Effect, Either, Fiber, Option, TestClock, TestContext } from "effect";
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
  type SignInStatesChoices,
  signInStatesOf,
  type StateFingerprint,
  stateEntry,
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
  /** The button labels a page with no empty box is told by, as the scan normalizes them. */
  readonly labels?: readonly string[];
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
          // As a host's inspection reads it: origin and path alone.
          page: page().split("#")[0] ?? "",
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
        const pressed = step.submit ?? (step.submitKey === undefined ? undefined : "Enter");
        if (pressed !== undefined) {
          clicks.push(pressed);
          const to = next(site.screen, pressed);
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
        ...(empty.length > 0 ? {} : { message: screen.texts?.[0] ?? "", buttons: [...(screen.labels ?? [])] }),
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
  ...(screen.boxes.length === 0
    ? { message: message ?? screen.texts?.[0] ?? "", buttons: [...(screen.labels ?? [])] }
    : {}),
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
  options: {
    readonly password?: string;
    readonly valueFree?: boolean;
    readonly siteAnswer?: "link" | "refused";
    readonly stepWaitMs?: number;
    readonly choices?: SignInStatesChoices;
    readonly events?: Readonly<Record<string, unknown>>[];
  } = {},
) => {
  const asked: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push(question.id);
            return [
              question.id,
              question.id === "sign_in_link"
                ? link
                : question.type === "confirm"
                  ? { confirmed: true }
                  : String(246810 + asked.length),
            ];
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
        emit: (details) => Effect.sync(() => void options.events?.push(details)),
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        ...(options.siteAnswer === undefined
          ? {}
          : { hosted: { siteAnswer: () => Effect.succeed(options.siteAnswer) } }),
        ...(options.choices === undefined ? {} : { choices: options.choices }),
        timing: { stepWaitMs: options.stepWaitMs ?? 300, pollMs: 2 },
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
  expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(repeated.fills).toEqual(["password"]);
  expect(repeated.clicks).toEqual(["#go"]);
  // The site's error marker shows with a text of its own, as most do.
  const wrong = { ...passwordScreen, errors: ["#wrong"], texts: ["that password is not right"] };
  const marked = scriptedSite({ start: passwordScreen, wrong }, () => "wrong");
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
  // The top page on the recorded origin, the box in a frame on another.
  const onTop = libraryOf([{ fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") }]);
  const inFrame = scriptedSite({ start: { ...emailScreen, frame: "https://other.example.test" } }, () => "home");
  const looksTop = Effect.map(inFrame.observe, (observed) => ({ ...observed, fingerprint: arrival(emailScreen) }));
  expect(await replay({ ...inFrame, observe: looksTop }, onTop)).toMatchObject({ reason: "screen_origin_changed" });
  expect(inFrame.fills).toEqual([]);
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
  // A press that sent the email, in a state that may lead to a code, is never made again.
  const kept = scriptedSite({ start: emailScreen }, () => undefined);
  expect(await replay(kept, branches)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(kept.clicks).toEqual(["#continue"]);
});

// A storefront with no box, told by its message and buttons, can show one label otherwise in
// another browser or place: the state that presses its control at the same address is still it.
const storefront: Screen = {
  path: "/",
  boxes: [],
  buttons: ["#log-in", "#deals"],
  texts: ["fresh groceries, fast"],
  labels: ["~ in", "~", "~ up", "~"],
};
const storefrontState = { fingerprint: arrival(storefront), step: stepAt("/", [], "#log-in") };
const typedEmail = { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") };
const typedPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
const viaStorefront = libraryOf([storefrontState, typedEmail, typedPassword]);
const storefrontNext: Readonly<Record<string, string>> = {
  "#log-in": "email",
  "#sign-in": "email",
  "#continue": "password",
  "#go": "home",
};
const toSignIn = { email: emailScreen, password: passwordScreen };

it("takes a page with no box whose label gained a word for the state whose control shows at its address", async () => {
  const relabeled = { ...storefront, labels: ["~ in", "~ ~", "~ up", "~"] };
  const site = scriptedSite({ start: relabeled, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  const events: Readonly<Record<string, unknown>>[] = [];
  expect(await replay(site, viaStorefront, { events })).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#log-in", "#continue", "#go"]);
  expect(events).toContainEqual({ stage: "state", state: viaStorefront.states[0]?.key, reason: "same_control" });
});

it("presses once more a state told by its control when the page kept its look", async () => {
  const relabeled = { ...storefront, labels: ["~ in", "~ ~", "~ up", "~"] };
  let presses = 0;
  const site = scriptedSite({ start: relabeled, ...toSignIn }, (at, clicked) =>
    clicked === "#log-in" && ++presses === 1 ? at : storefrontNext[clicked],
  );
  expect(await replay(site, viaStorefront)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#log-in", "#log-in", "#continue", "#go"]);
});

it("never takes a page with no box at another address for a state, though its control shows", async () => {
  const elsewhere = { ...storefront, path: "/deals", labels: ["~ in", "~ ~", "~ up", "~"] };
  const site = scriptedSite({ start: elsewhere, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(site, viaStorefront)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(site.clicks).toEqual([]);
});

it("still needs the whole look of a state with boxes, though the control it presses shows", async () => {
  const library = libraryOf([
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [], "#continue") },
    typedPassword,
  ]);
  const grown: Screen = { ...emailScreen, boxes: [...emailScreen.boxes, { selector: "#code", kind: "code" }] };
  const site = scriptedSite({ start: grown, password: passwordScreen }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(site, library)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(site.clicks).toEqual([]);
});

it("never takes a page with no box by its control alone where its press may have a code sent", async () => {
  const sendPage: Screen = { path: "/send", boxes: [], buttons: ["#send"], texts: ["we will text you a code"], labels: ["~ ~"] };
  const library = libraryOf([
    { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#send") },
    { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
  ]);
  const site = scriptedSite({ start: { ...sendPage, labels: ["~ ~ ~"] }, code: codeScreen }, () => "code");
  expect(await replay(site, library)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(site.clicks).toEqual([]);
});

// Two storefront states at one address, learned in turn, each pressing its own control.
const both: Screen = { ...storefront, buttons: ["#log-in", "#sign-in"] };
const twoStorefronts = libraryOf(
  [storefrontState, typedEmail, typedPassword],
  [{ fingerprint: arrival({ ...both, labels: ["~ ~", "~"] }), step: stepAt("/", [], "#sign-in") }, typedEmail, typedPassword],
);

it("takes a state whose whole look the page shows before one told by its control alone", async () => {
  const site = scriptedSite({ start: both, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  const events: Readonly<Record<string, unknown>>[] = [];
  expect(await replay(site, twoStorefronts, { events })).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#log-in", "#continue", "#go"]);
  expect(events).not.toContainEqual(expect.objectContaining({ reason: "same_control" }));
});

it("orders states told by their control alone as states of one look, the login's own first", async () => {
  const relabeled = { ...both, labels: ["~"] };
  const site = scriptedSite({ start: relabeled, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(site, twoStorefronts)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#sign-in", "#continue", "#go"]);
  const own = scriptedSite({ start: relabeled, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  const route = twoStorefronts.states.filter((state) => state.step.submit !== "#sign-in").map((state) => state.key);
  expect(await replay(own, twoStorefronts, { choices: { states: route } })).toMatchObject({ outcome: "signed_in" });
  expect(own.clicks).toEqual(["#log-in", "#continue", "#go"]);
});

it("takes a state by its control alone only once the page held still, as a whole look may still draw", async () => {
  // The header's control draws first, then the rest of the storefront.
  const header: Screen = { ...both, buttons: ["#sign-in"], labels: ["~"] };
  const drawing = scriptedSite({ start: (looks) => (looks < 4 ? header : both), ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(drawing, twoStorefronts)).toMatchObject({ outcome: "signed_in" });
  expect(drawing.clicks).toEqual(["#log-in", "#continue", "#go"]);
  // A page passing by after a press, with another state's control on it, is no state to press.
  const passing: Screen = { path: "/", boxes: [], buttons: ["#sign-in"], texts: ["one moment"], labels: ["~"] };
  let pressedAt = 0;
  const moving = scriptedSite(
    { start: both, loading: (looks) => (looks < pressedAt + 4 ? passing : emailScreen), password: passwordScreen },
    (_at, clicked) => {
      if (clicked !== "#log-in") return storefrontNext[clicked];
      pressedAt = moving.site.looks;
      return "loading";
    },
  );
  expect(await replay(moving, twoStorefronts)).toMatchObject({ outcome: "signed_in" });
  expect(moving.clicks).toEqual(["#log-in", "#continue", "#go"]);
});

it("never takes another login's state by its control where the login's own state should show", async () => {
  const route = twoStorefronts.states.filter((state) => state.step.submit !== "#sign-in").map((state) => state.key);
  // The page has the login's own state's whole look, but only the other state's control.
  const ownLook = scriptedSite({ start: { ...storefront, buttons: ["#sign-in"] }, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(ownLook, twoStorefronts, { choices: { states: route } })).toMatchObject({ reason: "not_found" });
  expect(ownLook.clicks).toEqual([]);
  // No state has the page's whole look, and the login's own state's control is gone.
  const relabeled = scriptedSite({ start: { ...both, labels: ["~"], buttons: ["#sign-in"] }, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  expect(await replay(relabeled, twoStorefronts, { choices: { states: route } })).toMatchObject({ reason: "unknown_state" });
  expect(relabeled.clicks).toEqual([]);
});

// After a press, a page at the address of the state just pressed that still shows another state's
// control, as one waiting on that press, is a state only where the press was learned to lead there.
const changed: Screen = { ...storefront, buttons: ["#sign-in"], labels: ["~"] };
const pressedOn = () =>
  scriptedSite({ start: both, changed, ...toSignIn }, (_at, clicked) => (clicked === "#log-in" ? "changed" : storefrontNext[clicked]));

it("never takes by its control, on the page of a state just pressed, a state that press never led to", async () => {
  const route = twoStorefronts.states.filter((state) => state.step.submit !== "#sign-in").map((state) => state.key);
  for (const choices of [undefined, { states: route }]) {
    const site = pressedOn();
    expect(await replay(site, twoStorefronts, choices === undefined ? {} : { choices })).toMatchObject({
      reason: "unknown_state",
    });
    expect(site.clicks).toEqual(["#log-in"]);
  }
  // A state a repair learned right after that press is taken there.
  const [first] = twoStorefronts.states;
  const learned = appendSignInStates(twoStorefronts, {
    from: first?.key,
    states: [{ fingerprint: arrival(changed), step: stepAt("/", [], "#sign-in") }, typedEmail, typedPassword],
    signedIn: { selector: "#account" },
  });
  if ("refused" in learned) throw new Error(learned.refused);
  const relabeled = { ...changed, labels: ["~ ~"] };
  const site = scriptedSite({ start: both, changed: relabeled, ...toSignIn }, (_at, clicked) =>
    clicked === "#log-in" ? "changed" : storefrontNext[clicked],
  );
  expect(await replay(site, learned.library)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#log-in", "#sign-in", "#continue", "#go"]);
});

it("never takes a state by its control where the page's main message differs or an address has a hash", async () => {
  const step: Screen = { path: "/app", boxes: [], buttons: ["button.go"], texts: ["one more step"], labels: ["~"] };
  const plain = libraryOf([{ fingerprint: arrival(step), step: stepAt("/app", [], "button.go") }, typedPassword]);
  // A hash route's state: the control's inspection reads the origin and path alone, so it can't
  // confirm the hash, even one the page shows when read.
  const routed = libraryOf([
    { fingerprint: arrival({ ...step, path: "/app#/stay" }), step: stepAt("/app#/stay", [], "button.go") },
    typedPassword,
  ]);
  const relabeled = { ...step, labels: ["~ ~"] };
  for (const [library, start] of [
    [plain, { ...relabeled, texts: ["send a new link"] }],
    [plain, { ...relabeled, path: "/app#/reset" }],
    [routed, { ...relabeled, path: "/app#/reset" }],
    [routed, { ...relabeled, path: "/app#/stay" }],
  ] as const) {
    const site = scriptedSite({ start, password: passwordScreen }, () => "password");
    expect(await replay(site, library)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
    expect(site.clicks).toEqual([]);
  }
  // The same page with one label otherwise is still that state.
  const site = scriptedSite({ start: relabeled, password: passwordScreen }, (_at, clicked) =>
    clicked === "button.go" ? "password" : "home",
  );
  expect(await replay(site, plain)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["button.go", "#go"]);
});

it("never takes a state by its control once anything may have reached the site", async () => {
  const stay: Screen = { path: "/stay", boxes: [], buttons: ["#yes"], texts: ["stay signed in"], labels: ["~"] };
  const library = libraryOf([typedEmail, typedPassword, { fingerprint: arrival(stay), step: stepAt("/stay", [], "#yes") }]);
  const next: Readonly<Record<string, string>> = { "#continue": "password", "#go": "stay", "#yes": "home" };
  const site = scriptedSite({ start: emailScreen, password: passwordScreen, stay: { ...stay, labels: ["~ ~"] } }, (_at, clicked) => next[clicked]);
  expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(site.clicks).toEqual(["#continue", "#go"]);
});

it("tells, at a state no one knows, its shape and the stored ones it was told from, value-free", async () => {
  const elsewhere: Screen = {
    ...storefront,
    path: "/sign-in/owner@example.test/42/AbCd",
    texts: ["fresh groceries in 30 minutes"],
    labels: ["~ in", "~ ~"],
  };
  const site = scriptedSite({ start: elsewhere, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
  const ended = await replay(site, viaStorefront);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(ended.unknownState?.shapes).toEqual({
    observed: {
      host: "example.test",
      path: "/sign-in/~/#/~",
      boxes: [],
      submit: false,
      message: "~ ~ ~ # ~",
      buttons: ["~ ~", "~ ~"],
    },
    stored: [
      {
        key: viaStorefront.states[0]?.key,
        host: "example.test",
        path: "/",
        boxes: [],
        submit: false,
        message: "~ ~ ~",
        buttons: ["~", "~", "~ ~", "~ ~"],
      },
    ],
  });
});

it("asks for a new code when the site refuses one, as many times as a recipe's replay does", async () => {
  const library = libraryOf([
    {
      fingerprint: arrival(codeScreen),
      step: stepAt("/verify", [code], "#verify", { rejectedMarkers: [{ selector: "#bad-code", slot: "code" }] }),
    },
  ]);
  let tries = 0;
  const site = scriptedSite(
    { start: codeScreen, refused: { ...codeScreen, errors: ["#bad-code"] } },
    () => (++tries > 1 ? "home" : "refused"),
  );
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["code", "code"]);
  const always = scriptedSite({ start: codeScreen, refused: { ...codeScreen, errors: ["#bad-code"] } }, () => "refused");
  expect(await replay(always, library)).toMatchObject({ outcome: "unclear", reason: "code_rejected" });
  expect(always.fills).toEqual(["code", "code", "code"]);
});

it("waits for a slow site to check a code before asking for another", async () => {
  const library = libraryOf([
    {
      fingerprint: arrival(codeScreen),
      step: stepAt("/verify", [code], "#verify", { rejectedMarkers: [{ selector: "#bad-code", slot: "code" }] }),
    },
  ]);
  const slow = scriptedSite({ start: codeScreen }, () => {
    setTimeout(() => {
      slow.site.screen = "home";
    }, 50);
    return undefined;
  });
  expect(await replay(slow, library)).toMatchObject({ outcome: "signed_in" });
  expect(slow.fills).toEqual(["code"]);
});

it("presses Enter in the email box when its Continue went once the email was typed", async () => {
  const library = libraryOf([
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
  ]);
  const site = scriptedSite(
    { start: () => ({ ...emailScreen, buttons: site.site.typed.has("#email") ? [] : ["#continue"] }) },
    (_at, pressed) => (pressed === "Enter" ? "home" : undefined),
  );
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["Enter"]);
});

it("opens the link the site's own answer says it emailed when the password state shows again", async () => {
  const library = libraryOf([
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const site = scriptedSite({ start: passwordScreen }, () => "start");
  const ended = await replay(site, library, { siteAnswer: "link" });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.site.opened).toEqual([link]);
  expect(site.fills).toEqual(["password"]);
  // The site's answer is a new page: the same box, empty again, under a notice of its own.
  const told = scriptedSite(
    { start: passwordScreen, notice: { ...passwordScreen, texts: ["check your email for a link that signs you in."] } },
    () => "notice",
  );
  expect(await replay(told, library, { siteAnswer: "link" })).toMatchObject({ outcome: "signed_in" });
  expect(told.site.opened).toEqual([link]);
  expect(told.fills).toEqual(["password"]);
});

const notice = "check your email for a sign-in link";
const linkLibrary = libraryOf([
  { fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") },
  {
    fingerprint: { ...arrival(combined), message: notice },
    step: stepAt("/", [], undefined, { approval: "email_link", delivery: "paste" }),
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
  // The outcome holds no typed value, however a host logs it.
  for (const logged of [JSON.stringify(ended), inspect(ended, { depth: null })])
    expect(logged).not.toMatch(/owner@example\.test|secret-1/u);
});

it("stops when the site goes back to a state it acted in before, typing nothing again", async () => {
  const emailState = { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") };
  const passwordState = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  // A second recording of the email state, its step told apart only by a marker, looks the same.
  const twin = {
    ...emailState,
    step: stepAt("/sign-in", [email], "#continue", { rejectedMarkers: [{ selector: "#unknown", slot: "email" }] }),
  };
  for (const library of [branches, libraryOf([emailState, passwordState], [twin])]) {
    const site = scriptedSite({ start: emailScreen, password: passwordScreen }, (_at, clicked) =>
      clicked === "#continue" ? "password" : "start",
    );
    const ended = await replay(site, library);
    expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
    expect(site.fills).toEqual(["email", "password"]);
    expect(site.clicks).toEqual(["#continue", "#go"]);
  }
});

it("waits at a notice state's boxes after its approval until the site signs in", async () => {
  const request = "we sent a sign-in request to your phone";
  const library = libraryOf([
    { fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") },
    { fingerprint: { ...arrival(combined), message: request }, step: stepAt("/", [], undefined, { approval: "device" }) },
  ]);
  // The site's page keeps the form and its request a moment after the owner approves.
  const site = scriptedSite({ start: combined, requested: { ...combined, texts: [request] } }, (_at, clicked) => {
    if (clicked !== "#continue") return undefined;
    setTimeout(() => {
      site.site.screen = "home";
    }, 100);
    return "requested";
  });
  const ended = await replay(site, library);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.asked).toEqual(["approved"]);
  expect(site.clicks).toEqual(["#continue"]);
});

it("asks for a new code when the site refuses one from a code box that sends itself", async () => {
  const library = libraryOf([
    {
      fingerprint: arrival(codeScreen),
      step: stepAt("/verify", [code], undefined, { rejectedMarkers: [{ selector: "#bad-code", slot: "code" }] }),
    },
  ]);
  const site = scriptedSite({ start: codeScreen, refused: { ...codeScreen, errors: ["#bad-code"] } }, () => undefined);
  let typed = 0;
  // The code box sends its form on its last digit.
  const fill: typeof site.hooks.fill = (call) =>
    Effect.map(site.hooks.fill(call), (report) => {
      site.site.screen = ++typed > 1 ? "home" : "refused";
      site.site.typed.clear();
      return report;
    });
  expect(await replay({ ...site, hooks: { ...site.hooks, fill } }, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["code", "code"]);
});

it("never picks a sign-in method a second time when the page keeps the choice", async () => {
  const choose: Screen = { path: "/method", boxes: [], buttons: ["#text-me", "#use-password"], texts: ["how should we reach you"] };
  const methods = [
    { method: "sms", selector: "#text-me" },
    { method: "password", selector: "#use-password" },
  ];
  const library = libraryOf([{ fingerprint: arrival(choose), step: stepAt("/method", [], "#text-me", { methods }) }]);
  const site = scriptedSite({ start: choose }, () => undefined);
  expect(await replay(site, library)).toMatchObject({ reason: "state_repeated" });
  expect(site.clicks).toEqual(["#text-me"]);
});

it("never signs in on a page that can't tell before the password went in", { timeout: 8_000 }, async () => {
  const library = libraryOf([
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const between: Screen = { path: "/next", boxes: [], texts: ["taking you to your sign-in page"] };
  const site = scriptedSite({ start: emailScreen, between, password: passwordScreen }, (_at, clicked) => {
    if (clicked !== "#continue") return "home";
    setTimeout(() => {
      site.site.screen = "password";
    }, 2_000);
    return "between";
  });
  const hooks = { ...site.hooks, startedEmpty: true, confirmCantTell: () => Effect.void };
  const ended = await replay({ ...site, hooks }, library, { stepWaitMs: 10_000 });
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(ended).not.toHaveProperty("cantTell");
  expect(site.fills).toEqual(["email", "password"]);
  // Nor at a page no state knows with nothing sent.
  const chooser = scriptedSite({ start: { path: "/choose", boxes: [], buttons: ["#here"], texts: ["pick a place"] } }, () => undefined);
  const fresh = { ...chooser.hooks, startedEmpty: true, confirmCantTell: () => Effect.void };
  expect(await replay({ ...chooser, hooks: fresh }, library)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  // Nor, before the step wait ran out, at a page no state knows while the password's code may come.
  const coded = libraryOf([
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
    { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
  ]);
  const phone: Screen = { path: "/phone", boxes: [{ selector: "#phone", kind: "identifier" }], buttons: ["#ok"] };
  const asked = scriptedSite({ start: passwordScreen, phone }, () => "phone");
  const tells = { ...asked.hooks, confirmCantTell: () => Effect.void };
  expect(await replay({ ...asked, hooks: tells }, coded)).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
});

it("never presses a look-alike of a state acted in that names the same control by another selector", async () => {
  const send: Screen = { path: "/send", boxes: [], buttons: ["#send", "button.send"], texts: ["we will text you a code"] };
  const sendState = { fingerprint: arrival(send), step: stepAt("/send", [], "#send") };
  const library = libraryOf(
    [
      { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
      sendState,
      { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
    ],
    [{ ...sendState, step: stepAt("/send", [], "button.send") }],
  );
  const next: Readonly<Record<string, string>> = { "#continue": "send", "#send": "code", "#verify": "send" };
  const site = scriptedSite({ start: emailScreen, send, code: codeScreen }, (_at, clicked) => next[clicked]);
  expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
  expect(site.clicks).toEqual(["#continue", "#send", "#verify"]);
});

it("acts in a text-only state that reads like one acted in before but presses another control", async () => {
  const notice: Screen = { path: "/notice", boxes: [], buttons: ["#next"], texts: ["~"] };
  const remember: Screen = { path: "/remember", boxes: [], buttons: ["#yes"], texts: ["~"] };
  const library = libraryOf([
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(notice), step: stepAt("/notice", [], "#next") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
    { fingerprint: arrival(remember), step: stepAt("/remember", [], "#yes") },
  ]);
  const next: Readonly<Record<string, string>> = { "#continue": "notice", "#next": "password", "#go": "remember", "#yes": "home" };
  const site = scriptedSite({ start: emailScreen, notice, password: passwordScreen, remember }, (_at, clicked) => next[clicked]);
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#continue", "#next", "#go", "#yes"]);
});

it("signs in on a page that can't tell once it held still, before the step wait", { timeout: 4_000 }, async () => {
  const landing: Screen = { path: "/landing", boxes: [], texts: ["welcome back"] };
  const library = libraryOf([{ fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }]);
  const site = scriptedSite({ start: passwordScreen, landing }, () => "landing");
  const confirmed: string[] = [];
  const hooks = { ...site.hooks, confirmCantTell: () => Effect.sync(() => void confirmed.push("confirmed")) };
  const ended = await replay({ ...site, hooks }, library, { stepWaitMs: 10_000 });
  expect(ended).toMatchObject({ outcome: "signed_in", cantTell: true });
  expect(confirmed).toEqual(["confirmed"]);
});

it("ends unclear when the press after a typed password lost its call's answer", async () => {
  const library = libraryOf([{ fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }]);
  const site = scriptedSite({ start: passwordScreen }, () => "home");
  const fill: typeof site.hooks.fill = (call) =>
    call.step.fields.length > 0
      ? site.hooks.fill(call)
      : Effect.succeed({ outcome: "uncertain", reason: "fill_call_failed", failureDetail: {} } as AutofillStepReport);
  expect(await replay({ ...site, hooks: { ...site.hooks, fill } }, library)).toMatchObject({ outcome: "unclear" });
});

it("waits out a known state the page draws in part on arrival", async () => {
  const library = libraryOf([{ fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") }]);
  const site = scriptedSite({ start: (looks) => (looks < 30 ? emailOnly : combined) }, () => "home");
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["email", "password"]);
});

it("verifies the marker in full before a page it does not know, sent or not", async () => {
  const landing: Screen = { path: "/landing", boxes: [], texts: ["welcome back"] };
  const library = libraryOf([{ fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }]);
  for (const start of [passwordScreen, landing]) {
    const site = scriptedSite({ start, landing }, () => "landing");
    // The marker shows only on the account page the full check opens.
    const url = `${origin}/landing`;
    const hooks = {
      ...site.hooks,
      check: () => Effect.succeed<AutofillSignedInCheck>({ signedIn: false, failed: "indicator_not_visible", url }),
      confirm: () =>
        Effect.sync(
          (): AutofillSignedInCheck =>
            site.site.screen === "landing" || start === landing
              ? { signedIn: true, url }
              : { signedIn: false, failed: "indicator_not_visible", url },
        ),
    };
    expect(await replay({ ...site, hooks }, library)).toMatchObject({
      outcome: "signed_in",
      alreadySignedIn: start === landing,
    });
  }
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

/**
 * A replay on the test clock from 0, with the default 30 s step wait and quiet, the host's challenge
 * look `challenge` (none when absent), a host that reads a page state unless `pageState` is false,
 * and `meanwhile` beside it, as a page that changes on its own.
 */
const replayOnClock = (
  site: ReturnType<typeof scriptedSite>,
  library: SignInStates,
  challenge?: AutofillHooks<TestFailure>["challenge"],
  meanwhile: Effect.Effect<void> = Effect.void,
  pageState = true,
  codes = false,
  choices?: SignInStatesChoices,
) => {
  const events: Readonly<Record<string, unknown>>[] = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.fork(meanwhile);
      const running = yield* Effect.fork(
        replaySignInStates({
          library,
          observe: site.observe,
          hooks: {
            ...site.hooks,
            ...(challenge === undefined ? {} : { challenge }),
            ...(pageState ? { pageState: () => Effect.succeed({ parsed: true, shape: site.site.screen }) } : {}),
          },
          entryUrl: `${origin}/sign-in`,
          credentials: { username: "owner@example.test", password: "secret-1" },
          ...(choices === undefined ? {} : { choices }),
          ask: makeInputAsker((request) =>
            codes
              ? Effect.succeed(
                  Object.fromEntries(request.questions.map((question) => [question.id, "246810"])) as InputAnswers,
                )
              : Effect.dieMessage("Unexpected question"),
          ),
          broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
          site: "example.test",
          correlation: undefined,
          emit: (details) => Effect.sync(() => void events.push(details)),
          failures: {
            unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
            unavailable: () => new TestFailure({ code: "unavailable" }),
          },
          timing: { stepWaitMs: 30_000, pollMs: 250 },
          sent: { current: false },
        }),
      );
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(running))) break;
        yield* TestClock.adjust(Duration.millis(250));
      }
      const ended = yield* Fiber.join(running);
      return { ended, endedAt: yield* Clock.currentTimeMillis, events };
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
};

const checkpoint: Screen = { path: "/sign-in", boxes: [], buttons: ["#go-on"], texts: ["press the button to go on"] };
const twoStates = libraryOf([
  { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
  { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
]);
const toPassword = (_at: string, clicked: string) => (clicked === "#continue" ? "password" : "home");

/** The host's look: when the page shows `on`, it clears it into `to`; the time of each look. */
const lookingAt = (site: ReturnType<typeof scriptedSite>, on: string, to: string) => {
  const looks: number[] = [];
  const challenge = Effect.gen(function* () {
    looks.push(yield* Clock.currentTimeMillis);
    if (site.site.screen !== on) return undefined;
    site.site.screen = to;
    return { outcome: "cleared" as const, vendor: "first_party" };
  });
  return { looks, challenge };
};
const lookEvents = (events: readonly Readonly<Record<string, unknown>>[]) =>
  events.filter((event) => event.stage === "challenge_look");

/** The site with the time on the test clock each press and each box last went, by control. */
const timed = (site: ReturnType<typeof scriptedSite>) => {
  const at = new Map<string, number>();
  const fill: AutofillHooks<TestFailure>["fill"] = (request) =>
    Effect.flatMap(Clock.currentTimeMillis, (ms) => {
      at.set(request.step.submit ?? request.step.fields.map((field) => field.selector).join(), ms);
      return site.hooks.fill(request);
    });
  return { timedSite: { ...site, hooks: { ...site.hooks, fill } }, at };
};

it("looks at a checkpoint page once it held still, long before the step wait, and signs in", async () => {
  const site = scriptedSite({ start: checkpoint, email: emailScreen, password: passwordScreen }, toPassword);
  const { looks, challenge } = lookingAt(site, "start", "email");
  const { ended, endedAt, events } = await replayOnClock(site, twoStates, challenge);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(looks).toHaveLength(1);
  // The page held still 1.5 s (`landingSettleMs`, past `quietMs`), then the next look ran.
  expect(looks[0]).toBeGreaterThanOrEqual(1_500);
  expect(looks[0]).toBeLessThan(3_000);
  expect(endedAt).toBeLessThan(5_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "cleared" }]);
});

it("keeps waiting for a slow page whose first state shows at 20 s after a look found nothing", async () => {
  const loading: Screen = { path: "/sign-in", boxes: [], texts: ["loading"] };
  const site = scriptedSite({ start: loading, email: emailScreen, password: passwordScreen }, toPassword);
  const { looks, challenge } = lookingAt(site, "none", "none");
  const drawn = Effect.sleep(Duration.seconds(20)).pipe(Effect.andThen(() => (site.site.screen = "email")));
  const { ended, endedAt, events } = await replayOnClock(site, twoStates, challenge, drawn);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(endedAt).toBeGreaterThanOrEqual(20_000);
  expect(endedAt).toBeLessThan(30_000);
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeLessThan(3_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "none" }]);
});

it("ends at the step wait on a page with no challenge, looking there again", async () => {
  const still: Screen = { path: "/sign-in", boxes: [], texts: ["one moment"] };
  const site = scriptedSite({ start: still }, () => undefined);
  const { looks, challenge } = lookingAt(site, "none", "none");
  const { ended, endedAt, events } = await replayOnClock(site, twoStates, challenge);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(endedAt).toBeGreaterThanOrEqual(30_000);
  expect(looks).toHaveLength(2);
  expect(looks[0]).toBeLessThan(3_000);
  expect(looks[1]).toBeGreaterThanOrEqual(30_000);
  expect(lookEvents(events)).toEqual([
    { stage: "challenge_look", look: "early", outcome: "none" },
    { stage: "challenge_look", look: "deadline", outcome: "none" },
  ]);
});

it("clears at the step wait's end a challenge revealed after the early look on a page that held", async () => {
  const still: Screen = { path: "/sign-in", boxes: [], texts: ["one moment"] };
  const site = scriptedSite({ start: still, email: emailScreen, password: passwordScreen }, toPassword);
  // A widget revealed in a frame from 10 s, which changes none of the page's text.
  const looks: number[] = [];
  const challenge = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    looks.push(now);
    if (now < 10_000 || site.site.screen !== "start") return undefined;
    site.site.screen = "email";
    return { outcome: "cleared" as const, vendor: "first_party" };
  });
  const { ended, events } = await replayOnClock(site, twoStates, challenge);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(looks).toHaveLength(2);
  expect(looks[1]).toBeGreaterThanOrEqual(30_000);
  expect(lookEvents(events)).toEqual([
    { stage: "challenge_look", look: "early", outcome: "none" },
    { stage: "challenge_look", look: "deadline", outcome: "cleared" },
  ]);
});

it("looks early at a page whose known state's controls have not shown", async () => {
  // The code state's fingerprint, with its box under another control than the one recorded.
  const drawnElsewhere: Screen = { path: "/verify", boxes: [{ selector: "#other-code", kind: "code" }] };
  const library = libraryOf([{ fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") }]);
  const site = scriptedSite({ start: drawnElsewhere }, () => undefined);
  const { looks, challenge } = lookingAt(site, "none", "none");
  const { ended, endedAt } = await replayOnClock(site, library, challenge);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "not_found" });
  expect(endedAt).toBeGreaterThanOrEqual(30_000);
  expect(looks).toHaveLength(2);
  expect(looks[0]).toBeLessThan(3_000);
});

it("ends at the step wait as before on a host with no challenge look", async () => {
  const site = scriptedSite({ start: checkpoint, email: emailScreen }, toPassword);
  const { ended, endedAt, events } = await replayOnClock(site, twoStates);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(endedAt).toBeGreaterThanOrEqual(30_000);
  expect(lookEvents(events)).toEqual([]);
});

it("looks only at the step wait's end when a known state sits in a pop-up", async () => {
  const popup = { opener: "primary", origin: "https://accounts.example.test" } as const;
  const library = libraryOf([{ fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue", { popup }) }]);
  const still: Screen = { path: "/sign-in", boxes: [], texts: ["one moment"] };
  const site = scriptedSite({ start: still }, () => undefined);
  const { looks, challenge } = lookingAt(site, "none", "none");
  const { ended, events } = await replayOnClock(site, library, challenge);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeGreaterThanOrEqual(30_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "deadline", outcome: "none" }]);
});

it("never looks early while the state just acted in still stands", async () => {
  const library = libraryOf([{ fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }]);
  const site = scriptedSite({ start: passwordScreen }, () => "start");
  const { looks, challenge } = lookingAt(site, "none", "none");
  const { ended } = await replayOnClock(site, library, challenge);
  expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(looks).toEqual([]);
});

it("ends challenge_unsolved when the early look finds a challenge the host can't clear", async () => {
  const site = scriptedSite({ start: checkpoint, email: emailScreen }, toPassword);
  const looks: number[] = [];
  const challenge = Effect.gen(function* () {
    looks.push(yield* Clock.currentTimeMillis);
    return { outcome: "failed" as const, vendor: "first_party" };
  });
  const { ended, endedAt, events } = await replayOnClock(site, twoStates, challenge);
  expect(ended).toMatchObject({ outcome: "unsent", reason: "challenge_unsolved", challenge: "first_party" });
  expect(endedAt).toBeLessThan(3_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "failed" }]);
});

it("looks only at the step wait's end on a host that reads no page state, as before", async () => {
  const site = scriptedSite({ start: checkpoint, email: emailScreen, password: passwordScreen }, toPassword);
  const { looks, challenge } = lookingAt(site, "start", "email");
  const { ended } = await replayOnClock(site, twoStates, challenge, Effect.void, false);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeGreaterThanOrEqual(30_000);
});

// A site may show, after a state the replay acted in, a page that looks just like a state it acted
// in before, or like the state just acted in, where a sign-in learned another step: a code page
// reached by asking for a text looks like the code page the text was asked from.
const codePage: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#text-me", "#verify"] };
const optionsPage: Screen = { path: "/options", boxes: [], buttons: ["#by-text"], texts: ["how should we send your code"] };
const emailState = { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") };
const askText = { fingerprint: arrival(codePage), step: stepAt("/verify", [], "#text-me") };
const textCode = { fingerprint: arrival(codePage), step: stepAt("/verify", [code], "#verify") };
const pickText = { fingerprint: arrival(optionsPage), step: stepAt("/options", [], "#by-text") };

it("goes on in a learned look-alike of a state it acted in before, where a transition leads there", async () => {
  const next: Readonly<Record<string, string>> = { "#continue": "c1", "#text-me": "options", "#by-text": "c2", "#verify": "home" };
  const pages = { start: emailScreen, c1: codePage, options: optionsPage, c2: codePage };
  const learned = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const ended = await replay(learned, libraryOf([emailState, askText, pickText, textCode]));
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(learned.clicks).toEqual(["#continue", "#text-me", "#by-text", "#verify"]);
  expect(learned.fills).toEqual(["email", "code"]);
  // With no learned transition to it, the look-alike is the state acted in before, come back.
  const unlearned = scriptedSite(pages, (_at, clicked) => next[clicked]);
  expect(await replay(unlearned, libraryOf([emailState, askText, pickText], [textCode]))).toMatchObject({
    outcome: "unclear",
    reason: "state_repeated",
  });
  expect(unlearned.fills).toEqual(["email"]);
  // Nor with one learned from another state than the one just acted in.
  const elsewhere = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const otherFrom = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  expect(
    await replay(elsewhere, libraryOf([emailState, askText, pickText], [otherFrom, textCode])),
  ).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
  expect(elsewhere.fills).toEqual(["email"]);
});

it("goes on in a learned look-alike of the state just acted in, once the page held still", async () => {
  const next: Readonly<Record<string, string>> = { "#continue": "p", "#text-me": "p2", "#verify": "home" };
  const pages = { start: emailScreen, p: codePage, p2: codePage };
  const learned = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const { ended } = await replayOnClock(learned, libraryOf([emailState, askText, textCode]), undefined, Effect.void, true, true);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(learned.clicks).toEqual(["#continue", "#text-me", "#verify"]);
  expect(learned.fills).toEqual(["email", "code"]);
  // With no learned transition, the page is the state just acted in: its press goes once more.
  const unlearned = scriptedSite(pages, (_at, clicked) => next[clicked]);
  expect(await replay(unlearned, libraryOf([emailState, askText], [textCode]))).toMatchObject({
    outcome: "unclear",
    reason: "state_repeated",
  });
  expect(unlearned.clicks).toEqual(["#continue", "#text-me", "#text-me"]);
  expect(unlearned.fills).toEqual(["email"]);
  // Nor with one learned after another state than the one just acted in.
  const elsewhere = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const otherFrom = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  expect(await replay(elsewhere, libraryOf([emailState, askText], [otherFrom, textCode]))).toMatchObject({
    outcome: "unclear",
    reason: "state_repeated",
  });
  expect(elsewhere.clicks).toEqual(["#continue", "#text-me", "#text-me"]);
  expect(elsewhere.fills).toEqual(["email"]);
});

it("never takes a learned look-alike that would type a password or identifier that went out again", async () => {
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#continue2"] };
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#go", "#go2"] };
  const between: Screen = { path: "/next", boxes: [], buttons: ["#next"], texts: ["one more step"] };
  // The page goes on to a state between, whose press brings the first page back fresh, where a
  // sign-in learned a look-alike after the state between that types the same value.
  const backAfter = async (page: Screen, field: AutofillRecipeStep["fields"][number], submit: string, other: string) => {
    const site = scriptedSite({ start: page, between, back: page }, (_at, clicked) =>
      clicked === submit ? "between" : clicked === "#next" ? "back" : "home",
    );
    const library = libraryOf([
      { fingerprint: arrival(page), step: stepAt(page.path, [field], submit) },
      { fingerprint: arrival(between), step: stepAt("/next", [], "#next") },
      { fingerprint: arrival(page), step: stepAt(page.path, [field], other) },
    ]);
    return { ended: await replay(site, library), site };
  };
  for (const { ended, site } of [
    await backAfter(idPage, email, "#continue", "#continue2"),
    await backAfter(pwPage, password, "#go", "#go2"),
  ]) {
    expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
    expect(site.fills).toHaveLength(1);
    expect(site.clicks).toHaveLength(2);
  }
});

it("stops where a page that typed its value comes back fresh, whatever look-alike a sign-in learned after it", async () => {
  // An identifier's page, where a sign-in learned a single sign-on press after it; a password's,
  // where it learned a press that has a code emailed.
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#sso"] };
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#go", "#email-code"] };
  const cases = [
    { page: idPage, states: [{ fingerprint: arrival(idPage), step: stepAt("/sign-in", [email], "#continue") }, { fingerprint: arrival(idPage), step: stepAt("/sign-in", [], "#sso") }] },
    {
      page: pwPage,
      states: [
        { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#go") },
        { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#email-code") },
        { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
      ],
    },
  ];
  for (const { page, states } of cases) {
    const site = scriptedSite({ start: page, back: page }, () => "back");
    expect(await replay(site, libraryOf(states))).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
    expect(site.clicks).toHaveLength(1);
    expect(site.fills).toHaveLength(1);
  }
});

it("never takes a learned look-alike that presses alone before the step wait, while a press may be under way", async () => {
  // A page slow to answer a press, where a sign-in learned another press alone that the library
  // knows sends nothing: the first press may still be under way.
  const sendPage: Screen = { path: "/send", boxes: [], buttons: ["#send", "#other"], texts: ["one moment"] };
  let sentAt: number | undefined;
  const sending = (looks: number) => {
    sentAt ??= looks;
    return looks - sentAt < 12 ? sendPage : passwordScreen;
  };
  const next: Readonly<Record<string, string>> = { "#continue": "send", "#send": "sending", "#other": "sending", "#go": "home" };
  const site = scriptedSite({ start: emailScreen, send: sendPage, sending }, (_at, clicked) => next[clicked]);
  const send = { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#send") };
  const library = libraryOf(
    [emailState, send, { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }],
    [emailState, send, { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#other") }],
  );
  expect((await replayOnClock(site, library)).ended).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#continue", "#send", "#go"]);
});

it("never takes a learned look-alike that asks for an approval or picks a method", async () => {
  // The identifier's page comes back fresh after a state between, where a sign-in learned an
  // approval, or a method choice, with its look after that state.
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#sso"] };
  const between: Screen = { path: "/next", boxes: [], buttons: ["#next"], texts: ["one more step"] };
  for (const alike of [
    stepAt("/sign-in", [], undefined, { approval: "device" }),
    stepAt("/sign-in", [], "#sso", { methods: [{ method: "sms", selector: "#sso" }] }),
  ]) {
    const site = scriptedSite({ start: idPage, between, back: idPage }, (_at, clicked) =>
      clicked === "#continue" ? "between" : clicked === "#next" ? "back" : "home",
    );
    const library = libraryOf([
      { fingerprint: arrival(idPage), step: stepAt("/sign-in", [email], "#continue") },
      { fingerprint: arrival(between), step: stepAt("/next", [], "#next") },
      { fingerprint: arrival(idPage), step: alike },
    ]);
    const ended = await replay(site, library);
    expect(ended).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
    expect(ended.asked).toEqual([]);
    expect(site.clicks).toEqual(["#continue", "#next"]);
  }
});

it("never takes a learned look-alike that presses alone and may have a code sent again, on a slow page", async () => {
  const sendPage: Screen = { path: "/send", boxes: [], buttons: ["#send", "#resend"], texts: ["we will text you a code"] };
  let sentAt: number | undefined;
  const sending = (looks: number) => {
    sentAt ??= looks;
    return looks - sentAt < 40 ? sendPage : codeScreen;
  };
  const next: Readonly<Record<string, string>> = { "#continue": "send", "#send": "sending", "#resend": "sending", "#verify": "home" };
  const site = scriptedSite({ start: emailScreen, send: sendPage, sending }, (_at, clicked) => next[clicked]);
  const library = libraryOf([
    emailState,
    { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#send") },
    { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#resend") },
    { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
  ]);
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(site.clicks).toEqual(["#continue", "#send", "#verify"]);
  expect(site.fills).toEqual(["email", "code"]);
});

it("never takes a learned look-alike after an approval, as a press that sends the sign-in link again", async () => {
  const sentPage: Screen = { path: "/sent", boxes: [], buttons: ["#resend"], texts: ["check your email for a sign-in link"] };
  let shownAt: number | undefined;
  // The site signs in a while after the owner opened the link, its page unchanged meanwhile.
  const sent = (looks: number) => {
    shownAt ??= looks;
    if (looks - shownAt > 40) site.site.screen = "home";
    return sentPage;
  };
  const site = scriptedSite({ start: emailScreen, sent }, (_at, clicked) => (clicked === "#continue" ? "sent" : undefined));
  const library = libraryOf([
    emailState,
    { fingerprint: arrival(sentPage), step: stepAt("/sent", [], undefined, { approval: "email_link" }) },
    { fingerprint: arrival(sentPage), step: stepAt("/sent", [], "#resend") },
  ]);
  const ended = await replay(site, library);
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.asked).toEqual(["approved"]);
  expect(site.clicks).toEqual(["#continue"]);
});

it("looks for a challenge before it goes on in a learned look-alike, and stops at one it can't clear", async () => {
  const choice: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#use-password", "#go"] };
  const library = libraryOf([
    emailState,
    { fingerprint: arrival(choice), step: stepAt("/password", [], "#use-password") },
    { fingerprint: arrival(choice), step: stepAt("/password", [password], "#go") },
  ]);
  const next: Readonly<Record<string, string>> = { "#continue": "choice", "#use-password": "again", "#go": "home" };
  const site = scriptedSite({ start: emailScreen, choice, again: choice }, (_at, clicked) => next[clicked]);
  const { ended, events } = await replayOnClock(site, library, Effect.succeed(undefined));
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(site.clicks).toEqual(["#continue", "#use-password", "#go"]);
  expect(site.fills).toEqual(["email", "password"]);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "none" }]);
  const blocked = scriptedSite({ start: emailScreen, choice, again: choice }, (_at, clicked) => next[clicked]);
  const failed = Effect.sync(() =>
    blocked.site.screen === "again" ? { outcome: "failed" as const, vendor: "first_party" } : undefined,
  );
  expect((await replayOnClock(blocked, library, failed)).ended).toMatchObject({ reason: "challenge_unsolved" });
  expect(blocked.fills).toEqual(["email"]);
});

it("takes a learned look-alike only once the page settled as for an early look, and again after a challenge it cleared", async () => {
  const choice: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#use-password", "#go"] };
  const library = libraryOf([
    emailState,
    { fingerprint: arrival(choice), step: stepAt("/password", [], "#use-password") },
    { fingerprint: arrival(choice), step: stepAt("/password", [password], "#go") },
  ]);
  const next: Readonly<Record<string, string>> = { "#continue": "choice", "#use-password": "again", "#go": "home" };
  const site = scriptedSite({ start: emailScreen, choice, again: choice }, (_at, clicked) => next[clicked]);
  const { timedSite, at } = timed(site);
  expect((await replayOnClock(timedSite, library, Effect.succeed(undefined))).ended).toMatchObject({ outcome: "signed_in" });
  expect((at.get("#password") ?? 0) - (at.get("#use-password") ?? 0)).toBeGreaterThanOrEqual(1_500);
  const cleared = scriptedSite({ start: emailScreen, choice, again: choice, past: choice }, (_at, clicked) => next[clicked]);
  const { looks, challenge } = lookingAt(cleared, "again", "past");
  const clearedTimed = timed(cleared);
  const { ended, events } = await replayOnClock(clearedTimed.timedSite, library, challenge);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "cleared" }]);
  expect((clearedTimed.at.get("#password") ?? 0) - (looks[0] ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(1_500);
});

// A repair that went on from a known state the replay stopped at appends what it walked from there
// (`from`): a look-alike of a known state, and the states after it.
type Recorded = { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep };
const repairedFrom = (built: readonly Recorded[], from: Recorded, walked: readonly Recorded[]) => {
  const source = appendSignInStates(signInStatesOf({}, []), { states: built, signedIn: { selector: "#identity" } });
  if ("refused" in source) throw new Error(source.refused);
  const repair = appendSignInStates(source.library, {
    from: stateEntry(from.fingerprint, from.step).key,
    states: walked,
    signedIn: { selector: "#identity" },
  });
  if ("refused" in repair) throw new Error(repair.refused);
  return repair.library;
};

it("goes on in the look-alike a repair walked from a press that left the page as it was", async () => {
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#username", kind: "identifier" }], buttons: ["#next"] };
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#continue"] };
  const verify: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
  const identifier = { fingerprint: arrival(idPage), step: stepAt("/sign-in", [{ selector: "#username", accepts: ["email" as const] }], "#next") };
  const pressOnly = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#continue") };
  const typesPassword = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#continue") };
  const codeState = { fingerprint: arrival(verify), step: stepAt("/verify", [code], "#verify") };
  // Its press goes on only once the password is typed; the page stays as it was before.
  const site = scriptedSite({ start: idPage, password: pwPage, verify }, (at, clicked) =>
    clicked === "#next"
      ? "password"
      : clicked === "#continue"
        ? site.site.typed.has("#password") ? "verify" : at
        : clicked === "#verify" ? "home" : undefined,
  );
  const library = repairedFrom([identifier, pressOnly], pressOnly, [typesPassword, codeState]);
  const { ended } = await replayOnClock(site, library, undefined, Effect.void, true, true);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(site.clicks).toEqual(["#next", "#continue", "#continue", "#verify"]);
  expect(site.fills).toEqual(["email", "password", "code"]);
  // Before the repair, the press is made once more and the replay stops.
  const before = scriptedSite({ start: idPage, password: pwPage, verify }, (at, clicked) =>
    clicked === "#next" ? "password" : clicked === "#continue" ? at : undefined,
  );
  expect(await replay(before, libraryOf([identifier, pressOnly]))).toMatchObject({ reason: "state_repeated" });
  expect(before.clicks).toEqual(["#next", "#continue", "#continue"]);
});

it("takes no look-alike whose press may have a code sent after a press that may have had one sent", async () => {
  // A press that may have had the site send a code leaves the page as it was, where a repair
  // learned to type the password and go on to the code: the site could send a second code. The
  // library knows the press sends one, or it picks a method.
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#send-code", "#go"] };
  const verify: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
  const typesPassword = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#go") };
  const codeState = { fingerprint: arrival(verify), step: stepAt("/verify", [code], "#verify") };
  const sendCode = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#send-code") };
  const picksText = {
    fingerprint: arrival(pwPage),
    step: stepAt("/password", [], "#send-code", { methods: [{ method: "sms" as const, selector: "#send-code" }] }),
  };
  for (const [press, built, choices] of [
    [sendCode, [emailState, sendCode, codeState], undefined],
    [picksText, [emailState, picksText], { method: "sms" as const }],
  ] as const) {
    const site = scriptedSite({ start: emailScreen, password: pwPage, verify }, (at, clicked) =>
      clicked === "#continue"
        ? "password"
        : clicked === "#send-code"
          ? at
          : clicked === "#go" ? "verify" : clicked === "#verify" ? "home" : undefined,
    );
    const library = repairedFrom(built, press, [typesPassword, codeState]);
    const { ended } = await replayOnClock(site, library, undefined, Effect.void, true, true, choices);
    expect(ended).toMatchObject({ reason: "state_repeated" });
    expect(site.clicks).toEqual(["#continue", "#send-code"]);
    expect(site.fills).toEqual(["email"]);
  }
});

it("goes on in the look-alike of an earlier state a repair walked from the state just acted in", async () => {
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#skip", "#go"] };
  const notice: Screen = { path: "/notice", boxes: [], buttons: ["#ok"], texts: ["one more thing"] };
  const skip = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#skip") };
  const ok = { fingerprint: arrival(notice), step: stepAt("/notice", [], "#ok") };
  const typesPassword = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#go") };
  const next: Readonly<Record<string, string>> = { "#continue": "password", "#skip": "notice", "#ok": "back", "#go": "home" };
  const pages = { start: emailScreen, password: pwPage, notice, back: pwPage };
  const site = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const ended = await replay(site, repairedFrom([emailState, skip, ok], ok, [typesPassword]));
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(site.clicks).toEqual(["#continue", "#skip", "#ok", "#go"]);
  expect(site.fills).toEqual(["email", "password"]);
  // Before the repair, the page is the earlier state come back.
  const before = scriptedSite(pages, (_at, clicked) => next[clicked]);
  expect(await replay(before, libraryOf([emailState, skip, ok]))).toMatchObject({ reason: "state_repeated" });
  expect(before.fills).toEqual(["email"]);
});

it("presses a learned look-alike's other control at the step wait, in place of pressing the same one again", async () => {
  const pick: Screen = { path: "/pick", boxes: [], buttons: ["#a", "#b"], texts: ["how do you want to sign in"] };
  const pickA = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#a") };
  const pickB = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#b") };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  const next: Readonly<Record<string, string>> = { "#continue": "pick", "#a": "pick", "#b": "password", "#go": "home" };
  const { timedSite, at } = timed(scriptedSite({ start: emailScreen, pick, password: passwordScreen }, (_at, clicked) => next[clicked]));
  const { looks, challenge } = lookingAt(timedSite, "none", "none");
  const { ended, events } = await replayOnClock(timedSite, libraryOf([emailState, pickA, pickB, typesPassword]), challenge);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(timedSite.clicks).toEqual(["#continue", "#a", "#b", "#go"]);
  expect((at.get("#b") ?? 0) - (at.get("#a") ?? 0)).toBeGreaterThanOrEqual(30_000);
  // The look before the press-only look-alike runs at the step wait, and is heard so.
  expect(looks).toHaveLength(1);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "deadline", outcome: "none" }]);
});

it("takes no learned look-alike after an approval, as on a page like an earlier state's", async () => {
  // The identifier's page comes back fresh once the owner confirmed, where a sign-in learned a
  // single sign-on press after the approval.
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#sso"] };
  const sentPage: Screen = { path: "/sent", boxes: [], texts: ["check your email for a sign-in link"] };
  let shownAt: number | undefined;
  const sent = (looks: number) => {
    shownAt ??= looks;
    if (looks - shownAt > 3) site.site.screen = "back";
    return sentPage;
  };
  const site = scriptedSite({ start: idPage, sent, back: idPage }, (_at, clicked) =>
    clicked === "#continue" ? "sent" : clicked === "#sso" ? "home" : undefined,
  );
  const library = libraryOf([
    { fingerprint: arrival(idPage), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(sentPage), step: stepAt("/sent", [], undefined, { approval: "email_link" }) },
    { fingerprint: arrival(idPage), step: stepAt("/sign-in", [], "#sso") },
  ]);
  const ended = await replay(site, library);
  expect(ended).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
  expect(ended.asked).toEqual(["approved"]);
  expect(site.clicks).toEqual(["#continue"]);
});

// Logins that took different routes through states with one look: each keeps its own.
const keyOf = (state: Recorded) => stateEntry(state.fingerprint, state.step).key;
const pick: Screen = { path: "/pick", boxes: [], buttons: ["#text", "#email"], texts: ["where should we send your code"] };
const byText = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#text") };
const byEmail = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#email") };
const picked = () =>
  scriptedSite({ start: emailScreen, pick }, (_at, clicked) => (clicked === "#continue" ? "pick" : "home"));

it("goes on along the login's own route where known states share a look, never another login's", async () => {
  // Another login's route was learned last and its press shows too.
  const library = libraryOf([emailState, byEmail], [emailState, byText]);
  const own = { states: [keyOf(emailState), keyOf(byEmail)] };
  const site = picked();
  expect(await replay(site, library, { choices: own })).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#continue", "#email"]);
  // Its own state no longer shows: it stops there as on a page it does not know, for a repair of
  // its own to go on from, pressing no other login's.
  const gone = scriptedSite({ start: emailScreen, pick: { ...pick, buttons: ["#text"] } }, (_at, clicked) =>
    clicked === "#continue" ? "pick" : "home",
  );
  const ended = await replay(gone, library, { choices: own });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(ended.unknownState).toMatchObject({ after: keyOf(emailState) });
  expect(gone.clicks).toEqual(["#continue"]);
});

it("takes, for a login with no route there, the state of its own method, else the most recently learned", async () => {
  const methods = [
    { method: "sms" as const, selector: "#text" },
    { method: "email" as const, selector: "#email" },
  ];
  const textMethod = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#text", { methods }) };
  const emailMethod = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#email", { methods }) };
  const library = libraryOf([emailState, emailMethod], [emailState, textMethod]);
  const site = picked();
  const ended = await replay(site, library, { choices: { method: "email" } });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.visited).toContain(keyOf(emailMethod));
  expect(ended.visited).not.toContain(keyOf(textMethod));
  // A login with no route or method takes the state learned last.
  const fresh = picked();
  expect(await replay(fresh, libraryOf([emailState, byEmail], [emailState, byText]))).toMatchObject({ outcome: "signed_in" });
  expect(fresh.clicks).toEqual(["#continue", "#text"]);
});

it("goes on along its own route from the state last acted in where the route holds a look twice", async () => {
  const step: Screen = { path: "/step", boxes: [], buttons: ["#a", "#b"], texts: ["one more step"] };
  const middle: Screen = { path: "/middle", boxes: [], buttons: ["#m"], texts: ["almost there"] };
  const first = { fingerprint: arrival(step), step: stepAt("/step", [], "#a") };
  const between = { fingerprint: arrival(middle), step: stepAt("/middle", [], "#m") };
  const last = { fingerprint: arrival(step), step: stepAt("/step", [], "#b") };
  const site = scriptedSite({ start: step, middle, again: step }, (_at, clicked) =>
    clicked === "#a" ? "middle" : clicked === "#m" ? "again" : "home",
  );
  const route = { states: [first, between, last].map(keyOf) };
  expect(await replay(site, libraryOf([first, between, last]), { choices: route })).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#a", "#m", "#b"]);
  // The site goes through a page of another login's in between: the route still goes on from the
  // last state of its own.
  const detour: Screen = { path: "/detour", boxes: [], buttons: ["#d"], texts: ["one moment please"] };
  const elsewhere = { fingerprint: arrival(detour), step: stepAt("/detour", [], "#d") };
  const around = scriptedSite({ start: step, detour, again: step }, (_at, clicked) =>
    clicked === "#a" ? "detour" : clicked === "#d" ? "again" : "home",
  );
  const library = libraryOf([first, between, last], [first, elsewhere, last]);
  expect(await replay(around, library, { choices: route })).toMatchObject({ outcome: "signed_in" });
  expect(around.clicks).toEqual(["#a", "#d", "#b"]);
});

it("keeps to its own state when it is looked for again, and waits for its controls on a page with boxes", async () => {
  const signIn: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#next"] };
  const own = { fingerprint: arrival(signIn), step: stepAt("/sign-in", [email], "#continue") };
  const other = { fingerprint: arrival(signIn), step: stepAt("/sign-in", [email], "#next") };
  // Another login's state with the same look was learned later.
  const library = libraryOf([own], [other]);
  const route = { states: [keyOf(own)] };
  const onward = (_at: string, clicked: string) => (clicked === "#continue" ? "home" : "elsewhere");
  // Its first fill fails with nothing sent, so the state is looked for once more.
  const site = scriptedSite({ start: signIn }, onward);
  let failed = false;
  const fill: AutofillHooks<TestFailure>["fill"] = (request) => {
    if (failed) return site.hooks.fill(request);
    failed = true;
    return Effect.succeed({ outcome: "refused", reason: "not_found", target: 0 } as const);
  };
  const redrawn = { ...site, hooks: { ...site.hooks, fill } };
  expect(await replay(redrawn, library, { choices: route })).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#continue"]);
  // Its own control shows late, the other login's at once: it waits for its own.
  const late = scriptedSite(
    { start: (looks) => ({ ...signIn, buttons: looks < 60 ? ["#next"] : ["#next", "#continue"] }) },
    onward,
  );
  expect(await replay(late, library, { choices: route })).toMatchObject({ outcome: "signed_in" });
  expect(late.clicks).toEqual(["#continue"]);
});

it("reads no other press on the page, a way in, or a code page after the code as a second send", async () => {
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#username", kind: "identifier" }], buttons: ["#next"] };
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#continue", "#email-code", "#use-password"] };
  const verify: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
  const identifier = { fingerprint: arrival(idPage), step: stepAt("/sign-in", [{ selector: "#username", accepts: ["email" as const] }], "#next") };
  const pressOnly = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#continue") };
  const typesPassword = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#continue") };
  const codeState = { fingerprint: arrival(verify), step: stepAt("/verify", [code], "#verify") };
  const site = () => {
    const shown = scriptedSite({ start: idPage, password: pwPage, verify }, (at, clicked) =>
      clicked === "#next"
        ? "password"
        : clicked === "#continue"
          ? shown.site.typed.has("#password") ? "verify" : at
          : clicked === "#verify" ? "home" : at,
    );
    return shown;
  };
  // Another login's repair learned another press on the page, before a code: it is no press of
  // this one's, so this login's own route goes on.
  const emailCode = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#email-code") };
  const other = repairedFrom([identifier, pressOnly], pressOnly, [emailCode, codeState]);
  const both = appendSignInStates(other, { from: keyOf(pressOnly), states: [typesPassword, codeState], signedIn: { selector: "#identity" } });
  if ("refused" in both) throw new Error(both.refused);
  const own = { states: [identifier, pressOnly, typesPassword, codeState].map(keyOf) };
  const beside = site();
  const { ended } = await replayOnClock(beside, both.library, undefined, Effect.void, true, true, own);
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(beside.clicks).toEqual(["#next", "#continue", "#continue", "#verify"]);
  // A press that picked a way in sends nothing.
  const wayIn = {
    fingerprint: arrival(pwPage),
    step: stepAt("/password", [], "#use-password", { methods: [{ method: "password" as const, selector: "#use-password" }] }),
  };
  const passwordWay = site();
  const fromWay = repairedFrom([identifier, wayIn], wayIn, [typesPassword, codeState]);
  expect((await replayOnClock(passwordWay, fromWay, undefined, Effect.void, true, true)).ended).toMatchObject({ outcome: "signed_in" });
  expect(passwordWay.clicks).toEqual(["#next", "#use-password", "#continue", "#verify"]);
  // A look-alike that types the code the press sent goes on, though another sign-in learned a
  // second code page after it.
  const second: Screen = { path: "/verify-again", boxes: [{ selector: "#code", kind: "code" }], texts: ["enter the second code"] };
  const secondCode = { fingerprint: arrival(second), step: stepAt("/verify-again", [code], "#verify") };
  const next: Readonly<Record<string, string>> = { "#continue": "p", "#text-me": "p2", "#verify": "home" };
  const texted = scriptedSite({ start: emailScreen, p: codePage, p2: codePage }, (_at, clicked) => next[clicked]);
  const library = repairedFrom([emailState, askText, textCode], textCode, [secondCode]);
  expect((await replayOnClock(texted, library, undefined, Effect.void, true, true)).ended).toMatchObject({ outcome: "signed_in" });
  expect(texted.clicks).toEqual(["#continue", "#text-me", "#verify"]);
});

it("goes on in a learned look-alike along the login's own route, or after a state its route goes no further from", async () => {
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#username", kind: "identifier" }], buttons: ["#next"] };
  const pwPage: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#continue", "#go"] };
  const verify: Screen = { path: "/verify", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
  const identifier = { fingerprint: arrival(idPage), step: stepAt("/sign-in", [{ selector: "#username", accepts: ["email" as const] }], "#next") };
  const pressOnly = { fingerprint: arrival(pwPage), step: stepAt("/password", [], "#continue") };
  const typesPassword = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#continue") };
  const typesAndGoes = { fingerprint: arrival(pwPage), step: stepAt("/password", [password], "#go") };
  const codeState = { fingerprint: arrival(verify), step: stepAt("/verify", [code], "#verify") };
  // Two logins' repairs went on from the press, each its own way.
  const first = repairedFrom([identifier, pressOnly], pressOnly, [typesPassword, codeState]);
  const both = appendSignInStates(first, { from: keyOf(pressOnly), states: [typesAndGoes, codeState], signedIn: { selector: "#identity" } });
  if ("refused" in both) throw new Error(both.refused);
  // Its presses go on only once the password is typed; the page stays as it was before.
  const site = () => {
    const made = scriptedSite({ start: idPage, password: pwPage, verify }, (at, clicked) =>
      clicked === "#next"
        ? "password"
        : clicked === "#continue" || clicked === "#go"
          ? made.site.typed.has("#password") ? "verify" : at
          : clicked === "#verify" ? "home" : undefined,
    );
    return made;
  };
  for (const [own, press] of [
    [typesPassword, "#continue"],
    [typesAndGoes, "#go"],
  ] as const) {
    const login = site();
    const route = [identifier, pressOnly, own, codeState].map(keyOf);
    const { ended } = await replayOnClock(login, both.library, undefined, Effect.void, true, true, { states: route });
    expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
    expect(login.clicks).toEqual(["#next", "#continue", press, "#verify"]);
  }
  // A login whose route stops at the press, as before its own repair, has no other state of its
  // own there: it takes the look-alike a repair learned after the press, the latest.
  const before = site();
  const { ended } = await replayOnClock(before, both.library, undefined, Effect.void, true, true, {
    states: [identifier, pressOnly].map(keyOf),
  });
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(before.clicks).toEqual(["#next", "#continue", "#go", "#verify"]);
});

it("presses a learned look-alike alone only where the press would go once more, and never the same control", async () => {
  const sendPage: Screen = { path: "/send", boxes: [], buttons: ["#send"], texts: ["get a code"] };
  const goPage: Screen = { path: "/go", boxes: [], buttons: ["#go"], texts: ["go on"] };
  // A press the library knows may have a code sent goes once; a learned look-alike pressing the
  // same control from another page is never pressed in its place.
  const send = { fingerprint: arrival(sendPage), step: stepAt("/send", [], "#send") };
  const sendElsewhere = { fingerprint: arrival(sendPage), step: stepAt("/send/again", [], "#send") };
  const codeState = { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  const sends = scriptedSite({ start: emailScreen, send: sendPage }, (at, clicked) => (clicked === "#continue" ? "send" : at));
  const sent = await replayOnClock(sends, repairedFrom([emailState, send, codeState], send, [sendElsewhere, typesPassword]));
  expect(sent.ended).toMatchObject({ reason: "state_repeated" });
  expect(sends.clicks).toEqual(["#continue", "#send"]);
  // Nor one pressing another control there, as no press goes once more after one that may send.
  const sendOrOther: Screen = { ...sendPage, buttons: ["#send", "#other"] };
  const sendFirst = { fingerprint: arrival(sendOrOther), step: stepAt("/send", [], "#send") };
  const other = { fingerprint: arrival(sendOrOther), step: stepAt("/send", [], "#other") };
  const others = scriptedSite({ start: emailScreen, send: sendOrOther, password: passwordScreen }, (at, clicked) =>
    clicked === "#continue" ? "send" : clicked === "#other" ? "password" : clicked === "#go" ? "home" : at,
  );
  const otherEnded = await replayOnClock(others, repairedFrom([emailState, sendFirst, codeState], sendFirst, [other, typesPassword]));
  expect(otherEnded.ended).toMatchObject({ reason: "state_repeated" });
  expect(others.clicks).toEqual(["#continue", "#send"]);
  // A press made once more stays the state's own, never a look-alike's of the same control.
  const go = { fingerprint: arrival(goPage), step: stepAt("/go", [], "#go") };
  const goElsewhere = { fingerprint: arrival(goPage), step: stepAt("/go/again", [], "#go") };
  const goes = scriptedSite({ start: emailScreen, go: goPage }, (at, clicked) => (clicked === "#continue" ? "go" : at));
  const went = await replayOnClock(goes, repairedFrom([emailState, go, typesPassword], go, [goElsewhere, typesPassword]));
  expect(went.ended).toMatchObject({ reason: "state_repeated" });
  expect(goes.clicks).toEqual(["#continue", "#go", "#go"]);
});
