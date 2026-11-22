import { inspect } from "node:util";
import { Clock, Data, Duration, Effect, Either, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedIn,
  AutofillSignedInCheck,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import {
  appendSignInStates,
  type BoxKind,
  type BoxTakes,
  decodeSignInStateEntry,
  noteSignInState,
  type ObservedState,
  observedSignInOf,
  signInStateEntryText,
  type SignInStates,
  type SignInStatesChoices,
  signInStatesOf,
  type StateEntry,
  type StateFingerprint,
  stateEntry,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { SiteAnswer } from "../../src/runtime/autofill-replay-steps.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { codeRowFields } from "../../src/runtime/autofill-unrecorded-code.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates, type SignInStatesStop } from "../../src/runtime/sign-in-states-replay.js";

// A sign-in replayed from a library of states on a scripted site: the page is read as a state
// after each action, matched to a known one and handled there.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const link = `${origin}/magic?token=abc`;

/**
 * A screen: its path, its boxes by selector and kind, a code box's role and label as the scan
 * reads them, its buttons, and its visible texts.
 */
interface Screen {
  readonly path: string;
  readonly boxes: readonly {
    readonly selector: string;
    readonly kind: BoxKind;
    readonly role?: string;
    readonly label?: string;
    readonly takes?: BoxTakes;
  }[];
  /** A page with boxes: its main instruction and its ways, as the scan normalizes them. */
  readonly instruction?: string;
  readonly ways?: readonly string[];
  readonly buttons?: readonly string[];
  readonly texts?: readonly string[];
  /** The origin of the frame the boxes sit in, when not the page's own. */
  readonly frame?: string;
  /** Recorded error markers the screen shows. */
  readonly errors?: readonly string[];
  /** The button labels a page with no empty box is told by, as the scan normalizes them. */
  readonly labels?: readonly string[];
  /** Boxes the inspection finds that the look never counts, as boxes drawn transparent. */
  readonly unseen?: readonly string[];
  /** Boxes the site shows filled already, as an email it kept. */
  readonly filled?: readonly string[];
}

/**
 * A scripted site on fixture hooks: `next` says the screen a click on a screen goes to; `home` is
 * signed in. `looks` counts the page reads, for a screen that draws late. With `resubmit`, the host
 * can click a screen again, typing nothing, as for a submit key pressed in its last field.
 */
const scriptedSite = (
  screens: Readonly<Record<string, Screen | ((looks: number) => Screen)>>,
  next: (screen: string, clicked: string) => string | undefined,
  options: { readonly resubmit?: boolean } = {},
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
  const controls = () => [...shown().boxes.map((box) => box.selector), ...(shown().unseen ?? []), ...(shown().buttons ?? [])];
  const press = (pressed: string) => {
    clicks.push(pressed);
    const to = next(site.screen, pressed);
    if (to !== undefined && to !== site.screen) {
      site.screen = to;
      site.typed.clear();
    }
  };
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
              ariaLabel: shown().boxes.find(({ selector }) => selector === field.selector)?.label ?? null,
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
        if (pressed !== undefined) press(pressed);
        return {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submit === undefined ? "none" : "clicked",
          url: page(),
        };
      }),
    ...(options.resubmit !== true
      ? {}
      : {
          resubmit: ({ step }) =>
            Effect.sync((): AutofillStepReport => {
              press(step.submit ?? step.submitKey ?? "");
              return {
                outcome: "filled",
                fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
                submit: "clicked",
                url: page(),
              };
            }),
        }),
  };
  const observe = Effect.sync((): ObservedState => {
    site.looks += 1;
    const screen = shown();
    const boxes = screen.boxes.map((box) => ({
      ...lookOf(screen, box),
      empty: !site.typed.has(box.selector) && !(screen.filled ?? []).includes(box.selector),
      submit: true,
    }));
    const empty = boxes.filter((box) => box.empty);
    return {
      fingerprint: {
        top: origin,
        boxes: empty.map(({ empty: _empty, submit: _submit, ...box }) => box),
        submit: empty.length > 0,
        ...(empty.length > 0 ? told(screen) : { message: screen.texts?.[0] ?? "", buttons: [...(screen.labels ?? [])] }),
      },
      boxes,
      texts: screen.texts ?? [],
    };
  });
  return { hooks, observe, site, clicks, fills };
};

/** A box as a look holds it. */
const lookOf = (screen: Screen, { kind, role, label, takes }: Screen["boxes"][number]) => ({
  frame: screen.frame ?? origin,
  kind,
  ...(role === undefined ? {} : { role }),
  ...(label === undefined ? {} : { label }),
  ...(takes === undefined ? {} : { takes }),
});
/** A page with boxes as its look tells it beside them: its instruction and its ways. */
const told = (screen: Screen) => ({
  ...(screen.instruction === undefined ? {} : { instruction: screen.instruction }),
  ...(screen.ways === undefined ? {} : { ways: [...screen.ways].sort() }),
});
/** A look as one read before boxes said what they take and pages kept their instruction and ways. */
const unkinded = ({ instruction: _instruction, ways: _ways, ...fingerprint }: StateFingerprint): StateFingerprint => ({
  ...fingerprint,
  boxes: fingerprint.boxes.map(({ takes: _takes, ...box }) => box),
});

/** The fingerprint a screen shows on arrival, every box empty. */
const arrival = (screen: Screen, message?: string): StateFingerprint => ({
  top: origin,
  boxes: screen.boxes.map((box) => lookOf(screen, box)),
  submit: screen.boxes.length > 0,
  ...(message === undefined ? {} : { message }),
  ...(screen.boxes.length === 0
    ? { message: message ?? screen.texts?.[0] ?? "", buttons: [...(screen.labels ?? [])] }
    : told(screen)),
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
    /** The host's read of the site's answer: a fixed answer, or one read on each call. */
    readonly siteAnswer?: SiteAnswer | ((page?: readonly string[]) => SiteAnswer | undefined);
    readonly stepWaitMs?: number;
    readonly choices?: SignInStatesChoices;
    readonly rankMethod?: SignInStatesChoices["method"];
    /** The method the host picks at a method choice. */
    readonly hostMethod?: SignInStatesChoices["method"];
    readonly events?: Readonly<Record<string, unknown>>[];
    readonly from?: SignInStatesStop;
    /** The codes the owner gives in turn, the last one again after them, else a new one each time. */
    readonly codes?: readonly string[];
    /** Each question's prompt, in order. */
    readonly prompts?: string[];
    /** The host gives every code itself, a new one each time, as from an authenticator app. */
    readonly hostCodes?: boolean;
    readonly codeRowByPlace?: boolean;
    readonly inPlace?: boolean;
    /** The replay may hand off: what the person does in the browser before marking it done. */
    readonly handOff?: () => void;
  } = {},
) => {
  const asked: string[] = [];
  let codesGiven = 0;
  let hostGiven = 0;
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push(question.id);
            options.prompts?.push(question.prompt);
            return [
              question.id,
              question.id === "sign_in_link"
                ? link
                : question.type === "browser_handoff"
                  ? (options.handOff?.(), { done: true })
                  : question.type === "confirm"
                  ? { confirmed: true }
                  : question.id === "code" && options.codes !== undefined
                    ? (options.codes[Math.min(codesGiven++, options.codes.length - 1)] ?? "")
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
        ...(options.siteAnswer === undefined && options.hostMethod === undefined && options.hostCodes !== true
          ? {}
          : {
              hosted: {
                ...(options.hostCodes === true
                  ? { code: () => Effect.sync(() => ({ slot: "code" as const, value: String(100000 + ++hostGiven) })) }
                  : {}),
                ...(options.siteAnswer === undefined
                  ? {}
                  : {
                      siteAnswer: (page?: readonly string[]) =>
                        Effect.sync(() => {
                          const said = options.siteAnswer;
                          return typeof said === "function" ? said(page) : said;
                        }),
                    }),
                ...(options.hostMethod === undefined
                  ? {}
                  : { method: (offered) => Effect.succeed(offered.find((option) => option.method === options.hostMethod)) }),
              },
            }),
        ...(options.choices === undefined ? {} : { choices: options.choices }),
        ...(options.rankMethod === undefined ? {} : { rankMethod: options.rankMethod }),
        timing: { stepWaitMs: options.stepWaitMs ?? 300, pollMs: 2 },
        quiet: { quietMs: 20, capMs: 120, enterMs: 40 },
        sent: { current: false },
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.codeRowByPlace === undefined ? {} : { codeRowByPlace: options.codeRowByPlace }),
        ...(options.inPlace === undefined ? {} : { inPlace: options.inPlace }),
        ...(options.handOff === undefined ? {} : { handOff: true }),
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

it("takes a state whose step types a box the site shows filled already, as an email it kept, only where no state has the page's look", async () => {
  const both = { fingerprint: arrival(combined), step: stepAt("/", [email, password], "#continue") };
  const events: Readonly<Record<string, unknown>>[] = [];
  const kept = scriptedSite({ start: { ...combined, filled: ["#email"] } }, () => "home");
  const library = libraryOf([both]);
  expect(await replay(kept, library, { events })).toMatchObject({ outcome: "signed_in", visited: [library.states[0]?.key] });
  expect(kept.fills).toEqual(["email", "password"]);
  expect(events).toContainEqual({ stage: "state", state: library.states[0]?.key, reason: "filled_boxes" });
  // A known state with the page's own look is taken as before.
  const passwordHere: Screen = { path: "/", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#continue"] };
  const again = scriptedSite({ start: { ...combined, filled: ["#email"] } }, () => "home");
  await replay(again, libraryOf([both], [{ fingerprint: arrival(passwordHere), step: stepAt("/", [password], "#continue") }]));
  expect(again.fills).toEqual(["password"]);
});

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

it("takes a page with no box by its control where its path is the recorded one but a per-account segment or a trailing slash", async () => {
  for (const [recorded, live, more] of [
    ["/shop/", "/shop", {}],
    ["/u/*/shop", "/u/7/shop", { anySegments: [1] }],
  ] as const) {
    const library = libraryOf([
      { fingerprint: arrival({ ...storefront, path: recorded }), step: stepAt(recorded, [], "#log-in", more) },
      typedEmail,
      typedPassword,
    ]);
    const relabeled = { ...storefront, path: live, labels: ["~ in", "~ ~", "~ up", "~"] };
    const site = scriptedSite({ start: relabeled, ...toSignIn }, (_at, clicked) => storefrontNext[clicked]);
    expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
    expect(site.clicks).toEqual(["#log-in", "#continue", "#go"]);
  }
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
    [routed, relabeled],
  ] as const) {
    const site = scriptedSite({ start, password: passwordScreen }, () => "password");
    expect(await replay(site, library)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
    expect(site.clicks).toEqual([]);
  }
  // Nor where the host's marker check reads the address without its hash: the control's own
  // inspection reads the live address too.
  const unhashed = scriptedSite({ start: { ...relabeled, path: "/app#/reset" }, password: passwordScreen }, () => "password");
  const hooks: AutofillHooks<TestFailure> = {
    ...unhashed.hooks,
    check: (...args) =>
      Effect.map(unhashed.hooks.check(...args), (checked) =>
        checked.url === undefined ? checked : ({ ...checked, url: checked.url.split("#")[0] ?? "" } as AutofillSignedInCheck),
      ),
  };
  expect(await replay({ ...unhashed, hooks }, plain)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(unhashed.clicks).toEqual([]);
  // Nor where the inspection reads no live address at all.
  const unread = scriptedSite({ start: relabeled, password: passwordScreen }, () => "password");
  const blind: AutofillHooks<TestFailure> = {
    ...unread.hooks,
    inspect: (...args) =>
      Effect.map(unread.hooks.inspect(...args), (inspection) => {
        if (!("targets" in inspection)) return inspection;
        const { url: _url, ...rest } = inspection;
        return rest;
      }),
  };
  expect(await replay({ ...unread, hooks: blind }, plain)).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(unread.clicks).toEqual([]);
  // The same page with one label otherwise is still that state.
  const site = scriptedSite({ start: relabeled, password: passwordScreen }, (_at, clicked) =>
    clicked === "button.go" ? "password" : "home",
  );
  expect(await replay(site, plain)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["button.go", "#go"]);
});

it("takes by its control, once the login went out, only a state the state just acted in led to, with its buttons", async () => {
  const stay: Screen = { path: "/stay", boxes: [], buttons: ["#yes"], texts: ["stay signed in"], labels: ["~"] };
  const stayState = { fingerprint: arrival(stay), step: stepAt("/stay", [], "#yes") };
  const next: Readonly<Record<string, string>> = { "#continue": "password", "#go": "stay", "#yes": "home" };
  const reworded = { ...stay, texts: ["stay signed in on this browser"] };
  const relabeled = { ...stay, labels: ["~ ~"] };
  const site = (shown: Screen) =>
    scriptedSite({ start: emailScreen, password: passwordScreen, stay: shown }, (_at, clicked) => next[clicked]);
  // The password state led to it: taken whatever its message, and heard as told by its control.
  const led = libraryOf([typedEmail, typedPassword, stayState]);
  const events: Readonly<Record<string, unknown>>[] = [];
  const taken = site(reworded);
  expect(await replay(taken, led, { events })).toMatchObject({ outcome: "signed_in" });
  expect(taken.clicks).toEqual(["#continue", "#go", "#yes"]);
  expect(events).toContainEqual({ stage: "state", state: led.states[2]?.key, reason: "same_control" });
  // Never with buttons other than its own, as another page asking for more with the same control;
  // never one no sign-in learned after the password state, by its message either, once the login
  // went out; nor one that presses the password state's own submit, which would send it again.
  const apart = libraryOf([typedEmail, typedPassword], [stayState]);
  const again = libraryOf([typedEmail, typedPassword, { fingerprint: arrival(stay), step: stepAt("/stay", [], "#go") }]);
  for (const [library, shown] of [
    [led, relabeled],
    [apart, reworded],
    [apart, relabeled],
    [again, { ...reworded, buttons: ["#go"] }],
  ] as const) {
    const stopped = site(shown);
    expect(await replay(stopped, library)).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
    expect(stopped.clicks).toEqual(["#continue", "#go"]);
  }
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

// A code state recorded with no button: its page was to send the code by itself.
const autoCode = (more: object = {}) =>
  libraryOf([{ fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], undefined, more) }]);
const entered = (events: readonly Readonly<Record<string, unknown>>[]) =>
  events.filter((event) => event.stage === "retried" && event.reason === "enter_after_typing").length;

it("presses Enter once in the code box of a state with no button whose page never sends the code", async () => {
  const site = scriptedSite({ start: codeScreen }, (_at, pressed) => (pressed === "Enter" ? "home" : undefined), {
    resubmit: true,
  });
  const events: Readonly<Record<string, unknown>>[] = [];
  expect(await replay(site, autoCode(), { events })).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(site.fills).toEqual(["code"]);
  expect(site.clicks).toEqual(["Enter"]);
  expect(entered(events)).toBe(1);
});

it("never presses Enter after a fill whose page sent the code itself, while the site checks it", async () => {
  const site = scriptedSite({ start: codeScreen }, () => "home", { resubmit: true });
  // The page sends the code on its last digit and keeps its look a while as the site checks it.
  const fill: typeof site.hooks.fill = (call) =>
    Effect.map(site.hooks.fill(call), (report) => {
      setTimeout(() => {
        site.site.screen = "home";
      }, 150);
      return report.outcome === "filled" ? { ...report, submit: "page" as const } : report;
    });
  expect(await replay({ ...site, hooks: { ...site.hooks, fill } }, autoCode())).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["code"]);
  expect(site.clicks).toEqual([]);
});

it("presses Enter once for each code typed, and still ends at the code retry bound", async () => {
  const site = scriptedSite({ start: codeScreen }, () => undefined, { resubmit: true });
  const events: Readonly<Record<string, unknown>>[] = [];
  const ended = await replay(site, autoCode(), { events });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "code_rejected" });
  // The state stood through each step wait after its Enter: no second Enter for the same code.
  expect(site.fills).toEqual(["code", "code", "code"]);
  expect(site.clicks).toEqual(["Enter", "Enter", "Enter"]);
  expect(entered(events)).toBe(3);
});

it("ends at the code retry bound when the host gives each code and the page empties its box with no refusal", async () => {
  // A box that sends its code itself, on a site that empties it after a wrong code, with no error,
  // and that signs in only on a sixth code.
  const site = scriptedSite({ start: codeScreen }, () => undefined);
  const fill: typeof site.hooks.fill = (call) =>
    Effect.map(site.hooks.fill(call), (report) => {
      site.site.typed.clear();
      if (site.fills.length >= 6) site.site.screen = "home";
      return report;
    });
  const ended = await replay({ ...site, hooks: { ...site.hooks, fill } }, autoCode(), { hostCodes: true });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "code_rejected" });
  expect(site.fills).toEqual(["code", "code", "code"]);
  expect(ended.asked).toEqual([]);
});

it("never takes the same code again when the code page stays with no refusal", async () => {
  // The site keeps its code page after the first press, with no error, and signs in on the second.
  // The owner gives the same code again first, which is asked again and never typed.
  let pressed = 0;
  const site = scriptedSite({ start: codeScreen }, () => (++pressed > 1 ? "home" : undefined));
  const typed: string[] = [];
  const fill: typeof site.hooks.fill = (call) =>
    Effect.sync(() => void typed.push(...call.values)).pipe(Effect.zipRight(site.hooks.fill(call)));
  const prompts: string[] = [];
  const library = libraryOf([{ fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") }]);
  const ended = await replay({ ...site, hooks: { ...site.hooks, fill } }, library, {
    codes: ["135790", "135790", "246802"],
    prompts,
  });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(typed).toEqual(["135790", "246802"]);
  expect(prompts[1]).toMatch(/^The site refused the last code\. /u);
});

it("never types again a code the site refused, after a later code whose page stayed with no refusal", async () => {
  // The site refuses the first code at its marker, which goes once a code is typed again; the
  // second code then stays with no marker.
  const site = scriptedSite(
    {
      start: codeScreen,
      refused: () => ({ ...codeScreen, errors: site.site.typed.has("#code") ? [] : ["#bad-code"] }),
    },
    () => "refused",
  );
  const typed: string[] = [];
  const fill: typeof site.hooks.fill = (call) =>
    Effect.sync(() => void typed.push(...call.values)).pipe(Effect.zipRight(site.hooks.fill(call)));
  const prompts: string[] = [];
  const library = libraryOf([
    {
      fingerprint: arrival(codeScreen),
      step: stepAt("/verify", [code], "#verify", { rejectedMarkers: [{ selector: "#bad-code", slot: "code" }] }),
    },
  ]);
  const ended = await replay({ ...site, hooks: { ...site.hooks, fill } }, library, {
    codes: ["111111", "222222", "111111"],
    prompts,
  });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "code_rejected" });
  expect(typed).toEqual(["111111", "222222"]);
  expect(prompts[1]).toMatch(/^The site refused the last code\. /u);
  expect(prompts[2]).toMatch(/^The site refused the last code\. /u);
});

// The host's read of the site's answer at a code page that stayed, counted, with the texts it got.
const reading = (said?: SiteAnswer) => {
  const reads = { count: 0, pages: [] as (readonly string[] | undefined)[] };
  return { reads, siteAnswer: (page?: readonly string[]) => (reads.count++, reads.pages.push(page), said) };
};

it("ends at once as a locked account when the site's answer to a code that didn't sign in says so", async () => {
  const verify = { ...codeScreen, texts: ["enter the code we emailed you."] };
  const site = scriptedSite(
    { start: verify, locked: { ...verify, texts: [...verify.texts, "your account is locked."] } },
    () => "locked",
  );
  const library = libraryOf([{ fingerprint: arrival(verify), step: stepAt("/verify", [code], "#verify") }]);
  const { reads, siteAnswer } = reading("locked");
  const events: Readonly<Record<string, unknown>>[] = [];
  const ended = await replay(site, library, { siteAnswer, events });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "account_locked" });
  expect(ended.asked).toEqual(["code"]);
  expect(site.fills).toEqual(["code"]);
  // One read, of what the page shows that it didn't before the code.
  expect(reads.pages).toEqual([["your account is locked."]]);
  expect(events.some((event) => event.stage === "retried")).toBe(false);
});

it("reads the site's answer once at each code page that stayed, and never on a code that signs in", async () => {
  let pressed = 0;
  const site = scriptedSite({ start: codeScreen }, () => (++pressed > 1 ? "home" : undefined));
  const library = libraryOf([{ fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") }]);
  // Any answer but a locked account asks again for a new code.
  const { reads, siteAnswer } = reading("refused");
  const prompts: string[] = [];
  expect(await replay(site, library, { siteAnswer, prompts })).toMatchObject({ outcome: "signed_in" });
  expect(prompts[1]).toMatch(/^The site refused the last code\. /u);
  expect(site.fills).toEqual(["code", "code"]);
  expect(reads.count).toBe(1);
  const quick = scriptedSite({ start: codeScreen }, () => "home");
  const normal = reading("locked");
  expect(await replay(quick, library, { siteAnswer: normal.siteAnswer })).toMatchObject({ outcome: "signed_in" });
  expect(normal.reads.count).toBe(0);
});

it("asks for a new code the site refused at its marker without reading the site's answer", async () => {
  const library = libraryOf([
    {
      fingerprint: arrival(codeScreen),
      step: stepAt("/verify", [code], "#verify", { rejectedMarkers: [{ selector: "#bad-code", slot: "code" }] }),
    },
  ]);
  const site = scriptedSite({ start: codeScreen, refused: { ...codeScreen, errors: ["#bad-code"] } }, () => "refused");
  const { reads, siteAnswer } = reading("locked");
  expect(await replay(site, library, { siteAnswer })).toMatchObject({ outcome: "unclear", reason: "code_rejected" });
  expect(site.fills).toEqual(["code", "code", "code"]);
  expect(reads.count).toBe(0);
});

it("ends a password state that stayed as it came back, whatever the site's answer says of a lock", async () => {
  const library = libraryOf([{ fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") }]);
  const site = scriptedSite({ start: passwordScreen }, () => "start");
  const ended = await replay(site, library, { siteAnswer: "locked" });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(site.fills).toEqual(["password"]);
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

it("signs in on an account chooser that can't tell after a password whose press may lead to a code", async () => {
  const library = libraryOf([
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
    { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") },
  ]);
  const chooser: Screen = { path: "/choose", boxes: [], texts: ["choose an account"], labels: ["~", "~ ~"] };
  const site = scriptedSite({ start: passwordScreen, chooser }, () => "chooser");
  const hooks = { ...site.hooks, confirmCantTell: () => Effect.void };
  const ended = await replay({ ...site, hooks }, library);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, cantTell: true });
  expect(site.fills).toEqual(["password"]);
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

/** A site whose sign-in opens from a home page's button, and the opens of its entry URL. */
const openerSite = () => {
  const home: Screen = { path: "/", boxes: [], buttons: ["#log-in"], texts: ["welcome"] };
  const site = scriptedSite({ start: home, email: emailScreen, password: passwordScreen }, (at, clicked) =>
    at === "start" && clicked === "#log-in"
      ? "email"
      : at === "email" && clicked === "#continue"
        ? "password"
        : at === "password" && clicked === "#go"
          ? "home"
          : undefined,
  );
  const opened: string[] = [];
  const hooks = {
    ...site.hooks,
    open: (url: string) => Effect.zipRight(Effect.sync(() => opened.push(url)), site.hooks.open(url)),
  };
  const library = libraryOf([
    { fingerprint: arrival(home), step: stepAt("/", [], "#log-in") },
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  return { site: { ...site, hooks }, opened, library };
};

it("goes on with the login from where a value-free check stopped, with no open and no press again", async () => {
  const { site, opened, library } = openerSite();
  const checked = await replay(site, library, { valueFree: true });
  expect(checked).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  expect(site.fills).toEqual([]);
  expect(site.clicks).toEqual(["#log-in"]);
  const from = checked.stop?.();
  expect(from?.state).toBe(checked.visited.at(-1));
  if (from === undefined) throw new Error("no stop");
  const ended = await replay(site, library, { from });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, fromStop: { continued: true } });
  expect(opened).toEqual([`${origin}/sign-in`]);
  expect(site.clicks).toEqual(["#log-in", "#continue", "#go"]);
  expect(site.fills).toEqual(["email", "password"]);
  // The states it acted in count from the check's, the opener once.
  expect(ended.visited).toEqual(library.states.map((state) => state.key));
  expect(ended.choices?.states).toEqual(ended.visited);
});

it("opens the entry URL again when the page changed while the login was read", async () => {
  const { site, opened, library } = openerSite();
  const checked = await replay(site, library, { valueFree: true });
  const from = checked.stop?.();
  if (from === undefined) throw new Error("no stop");
  site.site.screen = "start";
  const ended = await replay(site, library, { from });
  expect(ended).toMatchObject({ outcome: "signed_in", fromStop: { continued: false, reason: "page_changed" } });
  expect(opened).toEqual([`${origin}/sign-in`, `${origin}/sign-in`]);
  expect(site.clicks).toEqual(["#log-in", "#log-in", "#continue", "#go"]);
  expect(ended.visited).toEqual(library.states.map((state) => state.key));
  // Its controls gone though the page reads the same, it opens the entry URL again too.
  const again = openerSite();
  const stop = (await replay(again.site, again.library, { valueFree: true })).stop?.();
  if (stop === undefined) throw new Error("no stop");
  const refused: AutofillRefusal = { outcome: "refused", reason: "not_found", target: 0 };
  const hidden = { ...again.site, hooks: { ...again.site.hooks, inspect: () => Effect.succeed(refused) } };
  const unseen = await replay(hidden, again.library, { from: stop, stepWaitMs: 20 });
  expect(unseen).toMatchObject({ fromStop: { continued: false, reason: "not_found" } });
  expect(again.opened).toHaveLength(2);
  expect(again.site.fills).toEqual([]);
  // The same boxes on another host are no longer the state: it opens the entry URL again.
  const moved = openerSite();
  const left = (await replay(moved.site, moved.library, { valueFree: true })).stop?.();
  if (left === undefined) throw new Error("no stop");
  const elsewhere = Effect.map(moved.site.observe, (observed) => ({
    ...observed,
    fingerprint: { ...observed.fingerprint, top: "https://example-login.test" },
  }));
  let looks = 0;
  const once = Effect.flatMap(Effect.sync(() => ++looks), (look) => (look === 1 ? elsewhere : moved.site.observe));
  expect(await replay({ ...moved.site, observe: once }, moved.library, { from: left })).toMatchObject({
    outcome: "signed_in",
    fromStop: { continued: false, reason: "page_changed" },
  });
  expect(moved.opened).toHaveLength(2);
  expect(moved.site.clicks).toEqual(["#log-in", "#log-in", "#continue", "#go"]);
});

it("goes on in a first state that needs a value as it would after opening the entry URL", async () => {
  const site = scriptedSite({ start: emailScreen, password: passwordScreen }, (at, clicked) =>
    at === "start" && clicked === "#continue" ? "password" : clicked === "#go" ? "home" : undefined,
  );
  const library = libraryOf([
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const checked = await replay(site, library, { valueFree: true });
  expect(checked).toMatchObject({ outcome: "unsent", reason: "values_needed", visited: [library.states[0]?.key] });
  expect(site.clicks).toEqual([]);
  const from = checked.stop?.();
  if (from === undefined) throw new Error("no stop");
  expect(await replay(site, library, { from })).toMatchObject({ outcome: "signed_in", fromStop: { continued: true } });
  expect(site.fills).toEqual(["email", "password"]);
  expect(site.clicks).toEqual(["#continue", "#go"]);
  // A replay with the values hands back no stop, and one given none says nothing of one.
  const valued = scriptedSite({ start: emailScreen, password: passwordScreen }, (at, clicked) =>
    at === "start" && clicked === "#continue" ? "password" : "home",
  );
  const fresh = await replay(valued, library);
  expect(fresh.stop).toBeUndefined();
  expect(fresh).not.toHaveProperty("fromStop");
});

it("goes on in a state told by its text after the state before, as the check told it", async () => {
  // The same email box, with a line the press brought: the state after the press is told by it.
  const start: Screen = { path: "/", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#use-email"] };
  const notice: Screen = { ...start, buttons: ["#continue"], texts: ["type your email"] };
  const library = libraryOf([
    { fingerprint: arrival(start), step: stepAt("/", [], "#use-email") },
    { fingerprint: arrival(start, "type your email"), step: stepAt("/", [email], "#continue") },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const site = scriptedSite({ start, notice, password: passwordScreen }, (at, clicked) =>
    at === "start" && clicked === "#use-email"
      ? "notice"
      : at === "notice" && clicked === "#continue"
        ? "password"
        : clicked === "#go"
          ? "home"
          : undefined,
  );
  const checked = await replay(site, library, { valueFree: true });
  expect(checked).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  const from = checked.stop?.();
  if (from === undefined) throw new Error("no stop");
  expect(await replay(site, library, { from })).toMatchObject({ outcome: "signed_in", fromStop: { continued: true } });
  expect(site.clicks).toEqual(["#use-email", "#continue", "#go"]);
});

it("opens the entry URL again for a stop in a look-alike of a state the check acted in", async () => {
  // A press with nothing typed, then the same page as a learned look-alike that takes the password.
  const start: Screen = { path: "/", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#next", "#go"] };
  const pressed: Screen = { ...start, buttons: ["#go"] };
  const library = libraryOf([
    { fingerprint: arrival(start), step: stepAt("/", [], "#next") },
    { fingerprint: arrival(start), step: stepAt("/", [password], "#go") },
  ]);
  const site = scriptedSite({ start, pressed }, (at, clicked) =>
    at === "start" && clicked === "#next" ? "pressed" : at === "pressed" && clicked === "#go" ? "home" : undefined,
  );
  // A look-alike that types is taken once the page held still 1.5 s, long before the 30 s step wait.
  const checked = await replayOnClock(site, library, undefined, Effect.void, true, false, { valueFree: true });
  expect(checked.ended).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  expect(checked.endedAt).toBeGreaterThanOrEqual(1_500);
  expect(checked.endedAt).toBeLessThan(5_000);
  const from = checked.ended.stop?.();
  if (from === undefined) throw new Error("no stop");
  // The page went back to the state before while the login was read; it looks the same.
  site.site.screen = "start";
  const { timedSite, at } = timed(site);
  const { ended, endedAt } = await replayOnClock(timedSite, library, undefined, Effect.void, true, false, { from });
  expect(ended).toMatchObject({ outcome: "signed_in", fromStop: { continued: false, reason: "state_alike" } });
  expect(site.clicks).toEqual(["#next", "#next", "#go"]);
  expect(site.fills).toEqual(["password"]);
  // From the entry URL, the look-alike waits for the settle again, and no step wait.
  expect((at.get("#password") ?? 0) - (at.get("#next") ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(1_500);
  expect(endedAt).toBeLessThan(5_000);
});

it("goes on from a check's stop into a learned look-alike once the page settled, long before the step wait", async () => {
  const landing: Screen = { path: "/", boxes: [], buttons: ["#log-in"], texts: ["welcome"] };
  const choice: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#use-password", "#go"] };
  const library = libraryOf([
    { fingerprint: arrival(landing), step: stepAt("/", [], "#log-in") },
    { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
    { fingerprint: arrival(choice), step: stepAt("/password", [], "#use-password") },
    { fingerprint: arrival(choice), step: stepAt("/password", [password], "#go") },
  ]);
  const next: Readonly<Record<string, string>> = { "#log-in": "email", "#continue": "choice", "#use-password": "again", "#go": "home" };
  const site = scriptedSite({ start: landing, email: emailScreen, choice, again: choice }, (_at, clicked) => next[clicked]);
  const checked = await replay(site, library, { valueFree: true });
  expect(checked).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  const from = checked.stop?.();
  if (from === undefined) throw new Error("no stop");
  const { timedSite, at } = timed(site);
  const { ended, endedAt } = await replayOnClock(timedSite, library, undefined, Effect.void, true, false, { from });
  expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true, fromStop: { continued: true } });
  expect(site.clicks).toEqual(["#log-in", "#continue", "#use-password", "#go"]);
  expect(site.fills).toEqual(["email", "password"]);
  // The states it acted in count from the check's, so the look-alike is the one learned after the
  // press, taken once the page held still 1.5 s.
  expect(ended.visited).toEqual(library.states.map((state) => state.key));
  expect((at.get("#password") ?? 0) - (at.get("#use-password") ?? Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(1_500);
  expect(endedAt).toBeLessThan(10_000);
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

it("counts a press that leads to a code page as sending, though the sign-in left that page by other ways", async () => {
  const start: Screen = { path: "/", boxes: [], buttons: ["#continue"], texts: ["welcome back"] };
  const texted: Screen = { path: "/code", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#other-ways"] };
  const ways: Screen = { path: "/ways", boxes: [], buttons: ["#email", "#call"], texts: ["other ways"] };
  const called: Screen = { path: "/call", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#verify"] };
  const methods = [
    { method: "email" as const, selector: "#email" },
    { method: "call" as const, selector: "#call" },
  ];
  const library = libraryOf([
    { fingerprint: arrival(start), step: stepAt("/", [], "#continue") },
    { fingerprint: arrival(texted), step: stepAt("/code", [], "#other-ways") },
    { fingerprint: arrival(ways), step: stepAt("/ways", [], "#call", { methods }) },
    { fingerprint: arrival(called, "we called you"), step: stepAt("/call", [code], "#verify") },
  ]);
  // A value-free check stops before the press that has the site text a code.
  const check = scriptedSite({ start, texted }, (_at, clicked) => (clicked === "#continue" ? "texted" : undefined));
  expect(await replay(check, library, { valueFree: true })).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  expect(check.clicks).toEqual([]);
  // A page slow to leave it never gets that press again.
  const slow = scriptedSite({ start }, () => undefined);
  expect(await replay(slow, library)).toMatchObject({ reason: "state_repeated" });
  expect(slow.clicks).toEqual(["#continue"]);
});

// A sign-in whose text the site couldn't send: its code page showed a notice, dismissed by OK, and
// the sign-in went on by other ways to a call, whose code went into the same box. The page whose
// text went holds that box alone.
const texting: Screen = { path: "/", boxes: [], buttons: ["#sms"], texts: ["welcome back"] };
const textedCode: Screen = { path: "/code", boxes: [{ selector: "#code", kind: "code" }], buttons: ["#other-ways", "#verify"] };
const otherWays: Screen = { path: "/ways", boxes: [], buttons: ["#email", "#call"], texts: ["other ways"] };
const sendsText = stepAt("/", [], "#sms", { methods: [{ method: "sms", selector: "#sms" }] });
const callInstead = stepAt("/ways", [], "#call", {
  methods: [
    { method: "email", selector: "#email" },
    { method: "call", selector: "#call" },
  ],
});

it("waits for a texted code page to hold still before typing a code recorded for another way, so a late notice goes first", async () => {
  const notice: Screen = { ...textedCode, buttons: ["#ok", ...(textedCode.buttons ?? [])] };
  const library = libraryOf([
    { fingerprint: arrival(texting), step: sendsText },
    { fingerprint: arrival(notice), step: stepAt("/code", [], "#ok") },
    { fingerprint: arrival(textedCode), step: stepAt("/code", [], "#other-ways") },
    { fingerprint: arrival(otherWays), step: callInstead },
    { fingerprint: arrival(textedCode), step: stepAt("/code", [code], "#verify") },
  ]);
  // The notice draws a few reads after the box.
  let pressedAt = 0;
  const site = scriptedSite({ start: texting, code: (looks) => (looks < pressedAt + 4 ? textedCode : notice) }, (_at, clicked) => {
    if (clicked !== "#sms") return "home";
    pressedAt = site.site.looks;
    return "code";
  });
  const ended = await replay(site, library, { hostMethod: "sms" });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#sms", "#ok"]);
  expect(ended.asked).toEqual([]);
});

it("never presses again a press on a code page that the page kept, as it may have the site send once more", async () => {
  const library = libraryOf([
    { fingerprint: arrival(texting), step: sendsText },
    { fingerprint: arrival(textedCode), step: stepAt("/code", [], "#resend") },
    { fingerprint: arrival(textedCode), step: stepAt("/code", [], "#other-ways") },
    { fingerprint: arrival(otherWays), step: callInstead },
    { fingerprint: arrival(textedCode, "we called you"), step: stepAt("/code", [code], "#verify") },
  ]);
  const resendOnly: Screen = { ...textedCode, buttons: ["#resend"] };
  const site = scriptedSite({ start: texting, code: resendOnly }, (_at, clicked) => (clicked === "#sms" ? "code" : undefined));
  expect(await replay(site, library, { hostMethod: "sms" })).toMatchObject({ reason: "state_repeated" });
  expect(site.clicks).toEqual(["#sms", "#resend"]);
});

it("hands the browser to a person at a hand-off state after the presses before it, then checks the marker", async () => {
  const start: Screen = { path: "/", boxes: [], buttons: ["#sign-in"], texts: ["welcome"] };
  const provider: Screen = { path: "/sso", boxes: [{ selector: "#user", kind: "identifier" }], buttons: ["#next"] };
  const library = libraryOf([
    { fingerprint: arrival(start), step: stepAt("/", [], "#sign-in") },
    { fingerprint: arrival(provider), step: stepAt("/sso", [], undefined, { approval: "handoff" }) },
  ]);
  const site = () => scriptedSite({ start, provider }, (_at, clicked) => (clicked === "#sign-in" ? "provider" : undefined));
  // A check that may not hand off stops there, unsent.
  const check = site();
  expect(await replay(check, library, { valueFree: true })).toMatchObject({ outcome: "unsent", reason: "values_needed" });
  expect(check.clicks).toEqual(["#sign-in"]);
  const handed = site();
  const prompts: string[] = [];
  const ended = await replay(handed, library, {
    valueFree: true,
    prompts,
    handOff: () => {
      handed.site.screen = "home";
    },
  });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, loginProved: false, handedOff: true });
  expect(prompts).toEqual(["Sign in to example.test in this browser, then mark it done."]);
  expect(handed.fills).toEqual([]);
  // A person who did not sign in leaves no marker.
  expect(await replay(site(), library, { valueFree: true, handOff: () => undefined })).toMatchObject({
    outcome: "unsent",
    reason: "handoff_not_signed_in",
  });
  // A page of another look, as a provider's own account picker, never signs in as one that can't tell.
  const picker: Screen = { path: "/sso/accounts", boxes: [], texts: ["choose an account"], labels: ["~"] };
  const other = scriptedSite({ start, picker }, (_at, clicked) => (clicked === "#sign-in" ? "picker" : undefined));
  const hooks = { ...other.hooks, confirmCantTell: () => Effect.void };
  expect(await replay({ ...other, hooks }, library, { valueFree: true, handOff: () => undefined })).toMatchObject({
    outcome: "unsent",
    reason: "unknown_state",
  });
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
 * and `meanwhile` beside it, as a page that changes on its own; a value-free check, or one going on
 * from a check's stop (`from`), or with the login's `choices`, as `extra` says.
 */
const replayOnClock = (
  site: ReturnType<typeof scriptedSite>,
  library: SignInStates,
  challenge?: AutofillHooks<TestFailure>["challenge"],
  meanwhile: Effect.Effect<void> = Effect.void,
  pageState = true,
  codes = false,
  extra: {
    readonly valueFree?: boolean;
    readonly from?: SignInStatesStop;
    readonly choices?: SignInStatesChoices | undefined;
  } = {},
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
          credentials: extra.valueFree ? undefined : { username: "owner@example.test", password: "secret-1" },
          ...(extra.choices === undefined ? {} : { choices: extra.choices }),
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
          ...(extra.from === undefined ? {} : { from: extra.from }),
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
  // With no learned transition, the page is the state just acted in: a press on a code page, which
  // may have the site send once more, never goes again.
  const unlearned = scriptedSite(pages, (_at, clicked) => next[clicked]);
  expect(await replay(unlearned, libraryOf([emailState, askText], [textCode]))).toMatchObject({
    outcome: "unclear",
    reason: "state_repeated",
  });
  expect(unlearned.clicks).toEqual(["#continue", "#text-me"]);
  expect(unlearned.fills).toEqual(["email"]);
  // Nor with one learned after another state than the one just acted in.
  const elsewhere = scriptedSite(pages, (_at, clicked) => next[clicked]);
  const otherFrom = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  expect(await replay(elsewhere, libraryOf([emailState, askText], [otherFrom, textCode]))).toMatchObject({
    outcome: "unclear",
    reason: "state_repeated",
  });
  expect(elsewhere.clicks).toEqual(["#continue", "#text-me"]);
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
    const { ended } = await replayOnClock(site, library, undefined, Effect.void, true, true, { choices });
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

it("acts in a login's own state with the dismiss of a look-alike that only adds one, along its own route", async () => {
  const plain = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  const dismissing = { ...plain, step: stepAt("/password", [password], "#go", { dismiss: "#reject" }) };
  const coded = { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") };
  // Another login, with no code, learned the look-alike once a notice came to cover the submit.
  const library = libraryOf([emailState, plain, coded], [emailState, dismissing]);
  const route = [keyOf(emailState), keyOf(plain), keyOf(coded)];
  for (const banner of [true, false]) {
    const covering = { ...passwordScreen, buttons: ["#go", "#reject"] };
    const site = scriptedSite({ start: emailScreen, password: covering, code: codeScreen }, (_at, clicked) =>
      clicked === "#continue" ? "password" : clicked === "#go" ? "code" : "home",
    );
    // The notice catches the submit's click until its own control dismisses it.
    let covered = banner;
    const fill: typeof site.hooks.fill = (call) => {
      if (call.step.dismiss !== undefined) covered = false;
      return covered && call.step.submit === "#go"
        ? Effect.succeed({ outcome: "filled", fields: [], submit: "blocked", url: `${origin}/password` } as AutofillStepReport)
        : site.hooks.fill(call);
    };
    const ended = await replay({ ...site, hooks: { ...site.hooks, fill } }, library, { choices: { states: route } });
    expect(ended).toMatchObject({ outcome: "signed_in", visited: route });
    expect(site.fills).toEqual(["email", "password", "code"]);
  }
});

it("waits for a look-alike of an earlier state learned after the last one, where the login's route was kept before it", async () => {
  // After the code, an offer draws a moment late over a page with the start page's look, where a
  // repair learned to press its "no thanks"; the login's own route was kept before that repair.
  const landing: Screen = { path: "/", boxes: [], buttons: ["#sign-in"], texts: ["welcome"] };
  const start = { fingerprint: arrival(landing), step: stepAt("/", [], "#sign-in") };
  const codeState = { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") };
  const noThanks = { fingerprint: arrival(landing), step: stepAt("/", [], "#no-thanks") };
  const library = repairedFrom([start, emailState, codeState], codeState, [noThanks]);
  const route = { states: [keyOf(start), keyOf(emailState), keyOf(codeState)] };
  const next: Readonly<Record<string, string>> = { "#sign-in": "email", "#continue": "code", "#verify": "offer", "#no-thanks": "home" };
  const offered = (drawnAfter: number) => {
    let shownAt: number | undefined;
    const offer = (looks: number): Screen => {
      shownAt ??= looks;
      return { ...landing, buttons: looks - shownAt > drawnAfter ? ["#sign-in", "#no-thanks"] : ["#sign-in"] };
    };
    return scriptedSite({ start: landing, email: emailScreen, code: codeScreen, offer }, (_at, clicked) => next[clicked]);
  };
  const late = offered(3);
  expect(await replay(late, library, { choices: route })).toMatchObject({ outcome: "signed_in", loginProved: true });
  expect(late.clicks).toEqual(["#sign-in", "#continue", "#verify", "#no-thanks"]);
  // One whose "no thanks" never draws is the start page come back, at the step wait.
  const never = offered(Number.POSITIVE_INFINITY);
  expect(await replay(never, library, { choices: route })).toMatchObject({ outcome: "unclear", reason: "state_repeated" });
  expect(never.clicks).toEqual(["#sign-in", "#continue", "#verify"]);
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
  // So does one whose route holds only states this library lacks, as one learned in another library.
  const elsewhere = picked();
  const foreign = { states: [keyOf({ fingerprint: arrival(pick), step: stepAt("/pick", [], "#call") })] };
  expect(await replay(elsewhere, libraryOf([emailState, byEmail], [emailState, byText]), { choices: foreign })).toMatchObject({
    outcome: "signed_in",
  });
  expect(elsewhere.clicks).toEqual(["#continue", "#text"]);
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
  const { ended } = await replayOnClock(beside, both.library, undefined, Effect.void, true, true, { choices: own });
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

it("goes on from a stop only in a state the login's own route takes, else from the entry URL", async () => {
  const idPage: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#continue", "#next"] };
  const own = { fingerprint: arrival(idPage), step: stepAt("/sign-in", [email], "#continue") };
  const other = { fingerprint: arrival(idPage), step: stepAt("/sign-in", [email], "#next") };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  // Another login learned its own step there later, so a check given no choices takes it.
  const library = libraryOf([own, typesPassword], [other, typesPassword]);
  const choices = { states: [keyOf(own), keyOf(typesPassword)] };
  const site = () =>
    scriptedSite({ start: idPage, password: passwordScreen }, (_at, clicked) =>
      clicked === "#continue" || clicked === "#next" ? "password" : clicked === "#go" ? "home" : undefined,
    );
  const unchosen = site();
  const from = (await replay(unchosen, library, { valueFree: true })).stop?.();
  expect(from?.state).toBe(keyOf(other));
  if (from === undefined) throw new Error("no stop");
  const ended = await replay(unchosen, library, { from, choices });
  expect(ended).toMatchObject({ outcome: "signed_in", fromStop: { continued: false, reason: "state_not_own" } });
  expect(unchosen.clicks).toEqual(["#continue", "#go"]);
  expect(ended.visited).toEqual(choices.states);
  // A check given the login's choices stops in its own state, and the replay goes on there.
  const chosen = site();
  const ownStop = (await replay(chosen, library, { valueFree: true, choices })).stop?.();
  expect(ownStop?.state).toBe(keyOf(own));
  if (ownStop === undefined) throw new Error("no stop");
  expect(await replay(chosen, library, { from: ownStop, choices })).toMatchObject({ fromStop: { continued: true } });
  expect(chosen.clicks).toEqual(["#continue", "#go"]);
  // A login with no route there goes on in whichever it stopped in, as before.
  const routeless = site();
  const anyStop = (await replay(routeless, library, { valueFree: true })).stop?.();
  if (anyStop === undefined) throw new Error("no stop");
  expect(await replay(routeless, library, { from: anyStop })).toMatchObject({ fromStop: { continued: true } });
  expect(routeless.clicks).toEqual(["#next", "#go"]);
  // So does a login whose route holds no state with that look, only others.
  const elsewhere = site();
  const otherStop = (await replay(elsewhere, library, { valueFree: true })).stop?.();
  if (otherStop === undefined) throw new Error("no stop");
  expect(await replay(elsewhere, library, { from: otherStop, choices: { states: [keyOf(typesPassword)] } })).toMatchObject({
    fromStop: { continued: true },
  });
  expect(elsewhere.clicks).toEqual(["#next", "#go"]);
});

it("orders states sharing a look by a host's method where the login names none, and picks nothing by it", async () => {
  const methods = [
    { method: "sms" as const, selector: "#text" },
    { method: "email" as const, selector: "#email" },
  ];
  const textMethod = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#text", { methods }) };
  const emailMethod = { fingerprint: arrival(pick), step: stepAt("/pick", [], "#email", { methods }) };
  const library = libraryOf([emailState, emailMethod], [emailState, textMethod]);
  const ended = await replay(picked(), library, { rankMethod: "email", hostMethod: "email" });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(ended.visited).toContain(keyOf(emailMethod));
  // What is pressed and kept is the host's own pick at the method choice, never the hint.
  expect(ended.choices?.method).toBe("email");
  const site = picked();
  const hostsOwn = await replay(site, library, { rankMethod: "email", hostMethod: "sms" });
  expect(site.clicks).toEqual(["#continue", "#text"]);
  expect(hostsOwn.choices?.method).toBe("sms");
  // Without it, the state learned last.
  const unranked = await replay(picked(), library, { hostMethod: "email" });
  expect(unranked.visited).toContain(keyOf(textMethod));
  // The login's own method comes first.
  const own = await replay(picked(), library, { rankMethod: "email", choices: { method: "sms" } });
  expect(own.visited).toContain(keyOf(textMethod));
  // At a method choice, the recorded way in is pressed, not the host's method.
  const choose: Screen = { path: "/choose", boxes: [], buttons: ["#use-password", "#email-code"], texts: ["how do you want to sign in"] };
  const wayIn = {
    fingerprint: arrival(choose),
    step: stepAt("/choose", [], "#use-password", {
      methods: [
        { method: "password" as const, selector: "#use-password" },
        { method: "email" as const, selector: "#email-code" },
      ],
    }),
  };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  const way = scriptedSite({ start: emailScreen, choose, password: passwordScreen }, (_at, clicked) =>
    clicked === "#continue" ? "choose" : clicked === "#use-password" ? "password" : clicked === "#go" ? "home" : undefined,
  );
  const wentIn = await replay(way, libraryOf([emailState, wayIn, typesPassword]), { rankMethod: "email" });
  expect(wentIn).toMatchObject({ outcome: "signed_in" });
  expect(wentIn.choices).not.toHaveProperty("method");
  expect(way.clicks).toEqual(["#continue", "#use-password", "#go"]);
});

it("takes the host's method at a method choice, as a saved authenticator seed's, over the login's remembered pick", async () => {
  const choose: Screen = { path: "/choose", boxes: [], buttons: ["#text", "#app"], texts: ["how should we confirm it's you"] };
  const methods = [
    { method: "sms" as const, selector: "#text" },
    { method: "totp" as const, selector: "#app" },
  ];
  const library = libraryOf([emailState, { fingerprint: arrival(choose), step: stepAt("/choose", [], "#text", { methods }) }]);
  const site = scriptedSite({ start: emailScreen, choose }, (_at, clicked) => (clicked === "#continue" ? "choose" : "home"));
  const ended = await replay(site, library, { hostMethod: "totp", choices: { method: "sms" } });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#continue", "#app"]);
  expect(ended.choices?.method).toBe("totp");
});

it("takes by a host's method only a state whose recorded press is that method, and keeps no method it led to", async () => {
  const choose: Screen = { path: "/choose", boxes: [], buttons: ["#use-password", "#email-code"], texts: ["how do you want to sign in"] };
  const methods = [
    { method: "password" as const, selector: "#use-password" },
    { method: "email" as const, selector: "#email-code" },
  ];
  const byEmailCode = { fingerprint: arrival(choose), step: stepAt("/choose", [], "#email-code", { methods }) };
  const byPassword = { fingerprint: arrival(choose), step: stepAt("/choose", [], "#use-password", { methods }) };
  const codeState = { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  // The password press was learned last.
  const library = libraryOf([emailState, byEmailCode, codeState], [emailState, byPassword, typesPassword]);
  const next: Readonly<Record<string, string>> = {
    "#continue": "choose",
    "#use-password": "password",
    "#email-code": "code",
    "#go": "home",
    "#verify": "home",
  };
  const site = () =>
    scriptedSite({ start: emailScreen, choose, password: passwordScreen, code: codeScreen }, (_at, clicked) => next[clicked]);
  const plain = site();
  expect(await replay(plain, library)).toMatchObject({ outcome: "signed_in" });
  expect(plain.clicks).toEqual(["#continue", "#use-password", "#go"]);
  // The hint takes the state whose recorded press is its method, a route the library walked, and
  // keeps that route, but no method of it as the login's own.
  const hinted = site();
  const ended = await replay(hinted, library, { rankMethod: "email" });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(hinted.clicks).toEqual(["#continue", "#email-code", "#verify"]);
  expect(ended.choices?.states).toEqual([emailState, byEmailCode, codeState].map(keyOf));
  expect(ended.choices).not.toHaveProperty("method");
  // The login's own method is kept, as before.
  const chosen = site();
  expect((await replay(chosen, library, { choices: { method: "email" } })).choices?.method).toBe("email");
  expect(chosen.clicks).toEqual(["#continue", "#email-code", "#verify"]);
  // A hint no recorded press goes to orders nothing: the state learned last.
  const unwalked = site();
  expect(await replay(unwalked, library, { rankMethod: "sms" })).not.toHaveProperty("choices.method");
  expect(unwalked.clicks).toEqual(["#continue", "#use-password", "#go"]);
});

it("keeps a lone method no hint led to, and a real pick on a later page after one the hint led to", async () => {
  const choose: Screen = { path: "/choose", boxes: [], buttons: ["#use-password", "#email-code"], texts: ["how do you want to sign in"] };
  const byEmailCode = {
    fingerprint: arrival(choose),
    step: stepAt("/choose", [], "#email-code", {
      methods: [
        { method: "password" as const, selector: "#use-password" },
        { method: "email" as const, selector: "#email-code" },
      ],
    }),
  };
  const codeState = { fingerprint: arrival(codeScreen), step: stepAt("/verify", [code], "#verify") };
  const flow = (pages: Readonly<Record<string, Screen>>, next: Readonly<Record<string, string>>) =>
    scriptedSite({ start: emailScreen, choose, ...pages }, (_at, clicked) => next[clicked]);
  const toCode = { "#continue": "choose", "#email-code": "code", "#verify": "home" };
  const alone = libraryOf([emailState, byEmailCode, codeState]);
  // With no hint, a lone method is kept as before.
  expect((await replay(flow({ code: codeScreen }, toCode), alone)).choices?.method).toBe("email");
  // A login whose own method the page does not offer keeps the one the page took, hint or not.
  const named = await replay(flow({ code: codeScreen }, toCode), alone, { choices: { method: "sms" }, rankMethod: "email" });
  expect(named.choices?.method).toBe("email");
  // A host's pick on a later page, after a lone method the hint led to, is kept.
  const send: Screen = { path: "/send", boxes: [], buttons: ["#text", "#mail"], texts: ["where should we send your code"] };
  const sendState = {
    fingerprint: arrival(send),
    step: stepAt("/send", [], "#text", {
      methods: [
        { method: "sms" as const, selector: "#text" },
        { method: "email" as const, selector: "#mail" },
      ],
    }),
  };
  const sent = flow({ send }, { "#continue": "choose", "#email-code": "send", "#text": "home", "#mail": "home" });
  const picked = await replay(sent, libraryOf([emailState, byEmailCode, sendState]), { rankMethod: "email", hostMethod: "sms" });
  expect(sent.clicks).toEqual(["#continue", "#email-code", "#text"]);
  expect(picked.choices?.method).toBe("sms");
  // A way in on a later page leaves the method the hint led to unkept; with no hint, it is kept.
  const way: Screen = { path: "/way", boxes: [], buttons: ["#password-instead", "#mail-instead"], texts: ["one more step"] };
  const wayIn = {
    fingerprint: arrival(way),
    step: stepAt("/way", [], "#password-instead", {
      methods: [
        { method: "password" as const, selector: "#password-instead" },
        { method: "email" as const, selector: "#mail-instead" },
      ],
    }),
  };
  const typesPassword = { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") };
  const toWay = { "#continue": "choose", "#email-code": "way", "#password-instead": "password", "#go": "home" };
  const wayLibrary = libraryOf([emailState, byEmailCode, wayIn, typesPassword]);
  const hintedWay = flow({ way, password: passwordScreen }, toWay);
  const wentIn = await replay(hintedWay, wayLibrary, { rankMethod: "email" });
  expect(hintedWay.clicks).toEqual(["#continue", "#email-code", "#password-instead", "#go"]);
  expect(wentIn.choices).not.toHaveProperty("method");
  expect((await replay(flow({ way, password: passwordScreen }, toWay), wayLibrary)).choices?.method).toBe("email");
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
    const { ended } = await replayOnClock(login, both.library, undefined, Effect.void, true, true, { choices: { states: route } });
    expect(ended).toMatchObject({ outcome: "signed_in", loginProved: true });
    expect(login.clicks).toEqual(["#next", "#continue", press, "#verify"]);
  }
  // A login whose route stops at the press, as before its own repair, has no other state of its
  // own there: it takes the look-alike a repair learned after the press, the latest.
  const before = site();
  const { ended } = await replayOnClock(before, both.library, undefined, Effect.void, true, true, {
    choices: { states: [identifier, pressOnly].map(keyOf) },
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
}, 20_000);

// Two code screens a site serves at random after the same email, in a frame on its sign-in origin,
// alike but for their boxes' role and labels: the states know the first, recorded before code
// boxes had either.
const auth = "https://auth.example.test";
const codeRow = (role: string, first: number, selector: (at: number) => string): Screen => ({
  path: "/verify",
  frame: auth,
  boxes: Array.from({ length: 6 }, (_, at) => ({
    selector: selector(at),
    kind: "code" as const,
    role,
    label: String(first + at),
  })),
});
const textRow = codeRow("textbox", 1, (at) => `role=textbox[name="${at + 1}"]`);
const rowStep = (row: Screen) =>
  stepAt("/verify", row.boxes.map(({ selector }) => ({ selector, slot: "code" as const })), undefined, {
    page: `${auth}/verify`,
  });
const unlabelledRow: Screen = { ...textRow, boxes: textRow.boxes.map(({ selector, kind }) => ({ selector, kind })) };
const rowLibrary = libraryOf([
  { fingerprint: arrival(emailScreen), step: stepAt("/sign-in", [email], "#continue") },
  { fingerprint: arrival(unlabelledRow), step: rowStep(textRow) },
]);
const [rowEmail, textState] = rowLibrary.states as [StateEntry, StateEntry];
/** The site: the email's Continue shows `row`, whose code goes by Enter, as a page sends it. */
const rowSite = (row: Screen) =>
  scriptedSite({ start: emailScreen, code: row }, (at, clicked) =>
    at === "start" && clicked === "#continue" ? "code" : clicked === "Enter" ? "home" : undefined,
  { resubmit: true });
const stateEvents = (events: readonly Readonly<Record<string, unknown>>[]) =>
  events.filter((event) => event.stage === "state");

it("types the code by place into the row of a look-alike code screen whose recorded boxes never show, asking for it once, and logs a stop there", async () => {
  // The other screen's spinbuttons, which only the row's own selectors by place find.
  const numberRow = codeRow("spinbutton", 0, (at) => codeRowFields(6, false)[at]?.selector ?? "");
  const events: Readonly<Record<string, unknown>>[] = [];
  const site = rowSite(numberRow);
  const ended = await replay(site, rowLibrary, { events });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["email", ...Array<string>(6).fill("code")]);
  expect(ended.asked.filter((id) => id === "code")).toHaveLength(1);
  expect(stateEvents(events)).toEqual([
    { stage: "state", state: rowEmail.key },
    { stage: "state", state: textState.key, reason: "code_row" },
  ]);
  // A box past the row that the page's look leaves out, as one drawn transparent, types nothing.
  const past = rowSite({ ...numberRow, buttons: codeRowFields(7, false).slice(6).map(({ selector }) => selector) });
  expect(await replay(past, rowLibrary)).toMatchObject({ outcome: "unclear", reason: "not_found" });
  expect(past.fills).toEqual(["email"]);
  // A row of the look whose boxes are labelled for a PIN, as a PIN screen alike, types nothing.
  const pin = rowSite({ ...numberRow, boxes: numberRow.boxes.map((box, at) => ({ ...box, label: `PIN ${at + 1}` })) });
  expect(await replay(pin, rowLibrary)).toMatchObject({ outcome: "unclear", reason: "not_found" });
  expect(pin.fills).toEqual(["email"]);
  // A caller that goes on from the page itself gets it as it stopped, with its look and the state.
  const logged: Readonly<Record<string, unknown>>[] = [];
  const left = rowSite(numberRow);
  expect(await replay(left, rowLibrary, { events: logged, codeRowByPlace: false })).toMatchObject({
    outcome: "unclear",
    reason: "not_found",
  });
  expect(left.fills).toEqual(["email"]);
  expect(logged).toContainEqual({
    stage: "state_not_found",
    state: textState.key,
    shape: expect.objectContaining({
      boxes: numberRow.boxes.map((box) => ({ ...lookOf(numberRow, box), label: "#" })),
    }),
  });
});

it("learns a look-alike code screen beside the known one, which a new login takes directly, and keeps a login's own route and method", async () => {
  // A repair that met the spinbutton screen went on from the email state and recorded it, and
  // another login's repair recorded a look-alike of the first screen pressing another control.
  const numberRow = codeRow("spinbutton", 0, (at) => `role=spinbutton[name="${at}"]`);
  const learned = [
    { fingerprint: arrival(numberRow), step: rowStep(numberRow) },
    { fingerprint: arrival(textRow), step: { ...rowStep(textRow), submit: "#other" } },
  ].reduce((library, state) => {
    const appended = appendSignInStates(library, { from: rowEmail.key, states: [state], signedIn: { selector: "#account" } });
    if ("refused" in appended) throw new Error(appended.refused);
    return appended.library;
  }, rowLibrary);
  const [, , numberState] = learned.states as [StateEntry, StateEntry, StateEntry, StateEntry];
  expect(learned.states.slice(0, 2)).toEqual([rowEmail, textState]);
  const events: Readonly<Record<string, unknown>>[] = [];
  expect(await replay(rowSite(numberRow), learned, { events })).toMatchObject({
    outcome: "signed_in",
    choices: { states: [rowEmail.key, numberState.key] },
  });
  expect(stateEvents(events)).toEqual([
    { stage: "state", state: rowEmail.key },
    { stage: "state", state: numberState.key },
  ]);
  // A login whose route went through the first screen, recorded before code boxes had a role and
  // label, keeps to it on that screen, which now has them, and keeps its method.
  const own = { states: [rowEmail.key, textState.key], method: "sms" as const };
  const ownEvents: Readonly<Record<string, unknown>>[] = [];
  const site = rowSite({ ...textRow, buttons: ["#other"] });
  expect(await replay(site, learned, { choices: own, events: ownEvents })).toMatchObject({ outcome: "signed_in", choices: own });
  expect(stateEvents(ownEvents)).toEqual([
    { stage: "state", state: rowEmail.key },
    { stage: "state", state: textState.key },
  ]);
  expect(site.clicks).not.toContain("#other");
});

const emailBox: Screen = {
  path: "/sign-in",
  boxes: [{ selector: "#email", kind: "identifier", takes: "email" }],
  buttons: ["#continue"],
};
const phoneBox: Screen = {
  path: "/sign-in",
  boxes: [{ selector: "#phone", kind: "identifier", takes: "phone" }],
  buttons: ["#continue"],
};

it("ends at an unknown state when the email page it typed in turns into a phone page, whatever the old email state accepts", async () => {
  for (const accepts of [["username"], ["email"]] as const) {
    // A library recorded before boxes said what they take: its email state looks like any
    // identifier page.
    const library = libraryOf([
      { fingerprint: unkinded(arrival(emailBox)), step: stepAt("/sign-in", [{ selector: "#email", accepts }], "#continue") },
      { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
    ]);
    const site = scriptedSite({ start: emailBox, phone: phoneBox }, (at, clicked) =>
      at === "start" && clicked === "#continue" ? "phone" : undefined,
    );
    const ended = await replay(site, library);
    expect(ended).toMatchObject({
      outcome: "unclear",
      reason: "unknown_state",
      unknownState: { fingerprint: { boxes: [{ kind: "identifier", takes: "phone" }] }, sent: true },
    });
    expect(site.fills).toEqual([accepts[0]]);
    expect(site.clicks).toEqual(["#continue"]);
  }
});

it("never takes an old state whose step types an email alone on a page whose box takes a phone alone, and keeps every other match", async () => {
  const at = (takes: BoxTakes): Screen => ({
    path: "/sign-in",
    boxes: [{ selector: "#identifier", kind: "identifier", takes }],
    buttons: ["#continue"],
  });
  const recorded = (accepts: readonly ("email" | "phone" | "username")[]) =>
    libraryOf([
      {
        fingerprint: unkinded(arrival(at("other"))),
        step: stepAt("/sign-in", [{ selector: "#identifier", accepts: [...accepts] }], "#continue"),
      },
    ]);
  const signsIn = (screen: Screen) => scriptedSite({ start: screen }, () => "home");
  // The phone page is no page of the email state: nothing is typed there.
  const phone = signsIn(at("phone"));
  expect(await replay(phone, recorded(["email"]))).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(phone.fills).toEqual([]);
  // Its own email page, a box that says nothing, one that takes either, and a box a site marks as
  // a phone's for a member number, where the state types a username, all still match.
  for (const [takes, accepts] of [
    ["email", ["email"]],
    ["other", ["email"]],
    ["email_or_phone", ["email"]],
    ["phone", ["username"]],
    ["phone", ["username", "email"]],
    ["phone", ["email", "phone"]],
  ] as const) {
    const site = signsIn(at(takes));
    expect(await replay(site, recorded(accepts))).toMatchObject({ outcome: "signed_in" });
    expect(site.clicks).toEqual(["#continue"]);
  }
});

it("tells boxes by what they take where both looks say it: a box that takes either is no email state", async () => {
  const either: Screen = { ...emailBox, boxes: [{ selector: "#email", kind: "identifier", takes: "email_or_phone" }] };
  const kinded = (screen: Screen) =>
    libraryOf([{ fingerprint: arrival(screen), step: stepAt("/sign-in", [email], "#continue") }]);
  const site = scriptedSite({ start: either }, () => "home");
  expect(await replay(site, kinded(emailBox))).toMatchObject({ outcome: "unsent", reason: "unknown_state" });
  expect(site.fills).toEqual([]);
  expect(await replay(scriptedSite({ start: either }, () => "home"), kinded(either))).toMatchObject({
    outcome: "signed_in",
  });
  expect(await replay(scriptedSite({ start: emailBox }, () => "home"), kinded(emailBox))).toMatchObject({
    outcome: "signed_in",
  });
});

it("orders look-alike states by the instruction and ways each page shows, and a reworded page keeps its match", async () => {
  const page = (ways: readonly string[], instruction = "~ your password"): Screen => ({
    ...passwordScreen,
    instruction,
    ways,
    buttons: ["#go", "#send"],
  });
  const withCode = page(["~", "~ code instead"]);
  const plain = page(["~"]);
  // Two sign-ins recorded the two pages, the plain one last.
  const library = libraryOf(
    [{ fingerprint: arrival(withCode), step: stepAt("/password", [password], "#go") }],
    [{ fingerprint: arrival(plain), step: stepAt("/password", [password], "#send") }],
  );
  for (const [screen, pressed] of [
    [withCode, "#go"],
    [plain, "#send"],
  ] as const) {
    const site = scriptedSite({ start: screen }, () => "home");
    expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
    expect(site.clicks).toEqual([pressed]);
  }
  // A page whose instruction and ways the site reworded still matches the one state of its look.
  const reworded = scriptedSite({ start: page(["~ in"], "~ the password for this account") }, () => "home");
  const one = libraryOf([{ fingerprint: arrival(withCode), step: stepAt("/password", [password], "#go") }]);
  expect(await replay(reworded, one)).toMatchObject({ outcome: "signed_in" });
  expect(reworded.clicks).toEqual(["#go"]);
});

it("still stops when a fuller state whose password box drew late shows again after its press", async () => {
  const late: Screen = { path: "/", boxes: [{ selector: "#email", kind: "identifier", takes: "email" }], buttons: ["#continue"] };
  const full: Screen = { ...late, boxes: [...late.boxes, { selector: "#password", kind: "password" }] };
  const library = libraryOf(
    [{ fingerprint: arrival(full), step: stepAt("/", [email, password], "#continue") }],
    [{ fingerprint: arrival(late), step: stepAt("/", [email], "#continue") }],
  );
  // The password box draws late, and the site shows the whole form again after the press.
  const site = scriptedSite({ start: (looks) => (looks < 4 ? late : full), again: full }, () => "again");
  expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(site.fills).toEqual(["email", "password"]);
});

it("still takes an old notice state recorded where a box that said nothing turned into an email box", async () => {
  const at = (takes: BoxTakes, texts: readonly string[] = []): Screen => ({
    path: "/sign-in",
    boxes: [{ selector: "#identifier", kind: "identifier", takes }],
    buttons: ["#continue"],
    texts,
  });
  const confirm = at("email", ["confirm the email on your account"]);
  // An older core recorded the second page as the first page's boxes and its new text.
  const library = libraryOf([
    { fingerprint: unkinded(arrival(at("other"))), step: stepAt("/sign-in", [{ selector: "#identifier", accepts: ["username"] }], "#continue") },
    {
      fingerprint: unkinded(arrival(at("other"), "confirm the email on your account")),
      step: stepAt("/sign-in", [{ selector: "#identifier", accepts: ["email"] }], "#continue"),
    },
    { fingerprint: arrival(passwordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const site = scriptedSite({ start: at("other"), confirm, password: passwordScreen }, (screen) =>
    screen === "start" ? "confirm" : screen === "confirm" ? "password" : "home",
  );
  expect(await replay(site, library)).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["username", "email", "password"]);
});

it("still stops as its credential came back where a refused email box's label gained words for a phone", async () => {
  const library = libraryOf([{ fingerprint: arrival(emailBox), step: stepAt("/sign-in", [email], "#continue") }]);
  const refused: Screen = { ...emailBox, boxes: [{ selector: "#email", kind: "identifier", takes: "email_or_phone" }] };
  const site = scriptedSite({ start: emailBox, refused }, () => "refused");
  expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(site.fills).toEqual(["email"]);
});

it("keeps a match where a box's label the site reworded says nothing, and never puts an old state before a newer one for its ways", async () => {
  const unsaid: Screen = { ...emailBox, boxes: [{ selector: "#email", kind: "identifier", takes: "other" }] };
  const kinded = libraryOf([{ fingerprint: arrival(emailBox), step: stepAt("/sign-in", [email], "#continue") }]);
  expect(await replay(scriptedSite({ start: unsaid }, () => "home"), kinded)).toMatchObject({ outcome: "signed_in" });
  // An old state, recorded before pages kept their ways, and a newer one recorded beside a banner's.
  const page: Screen = { ...passwordScreen, instruction: "~ your password", ways: ["~"], buttons: ["#go", "#go-old"] };
  const mixed = libraryOf(
    [{ fingerprint: unkinded(arrival(page)), step: stepAt("/password", [password], "#go-old") }],
    [{ fingerprint: arrival({ ...page, ways: ["~", "~ all cookies"] }), step: stepAt("/password", [password], "#go") }],
  );
  const site = scriptedSite({ start: page }, () => "home");
  expect(await replay(site, mixed)).toMatchObject({ outcome: "signed_in" });
  expect(site.clicks).toEqual(["#go"]);
});

it("still stops as its credential came back where a box's label drew late, for an old email state and a new one", async () => {
  const late: Screen = { ...emailBox, boxes: [{ selector: "#email", kind: "identifier", takes: "other" }] };
  for (const fingerprint of [unkinded(arrival(emailBox)), arrival(emailBox)]) {
    const library = libraryOf([{ fingerprint, step: stepAt("/sign-in", [email], "#continue") }]);
    // The page is read before its label draws, and comes back with it after the press.
    const site = scriptedSite({ start: (looks) => (looks < 2 ? late : emailBox), back: emailBox }, () => "back");
    expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
    expect(site.fills).toEqual(["email"]);
  }
});

it("still stops as its credential came back where the page keeps a filled phone box beside the email box it cleared", async () => {
  const both: Screen = {
    path: "/sign-in",
    boxes: [
      { selector: "#phone", kind: "identifier", takes: "phone" },
      { selector: "#email", kind: "identifier", takes: "email" },
    ],
    buttons: ["#continue"],
  };
  const look = { top: origin, boxes: [{ frame: origin, kind: "identifier" as const, takes: "email" as const }], submit: true };
  for (const fingerprint of [unkinded(look), look]) {
    const library = libraryOf([{ fingerprint, step: stepAt("/sign-in", [email], "#continue") }]);
    const site = scriptedSite({ start: both, back: both }, () => "back");
    // The phone box holds the site's own value throughout; only the email box is typed.
    const observe = Effect.map(site.observe, (observed) => {
      const boxes = observed.boxes.map((box, at) => (at === 0 ? { ...box, empty: false } : box));
      const empty = boxes.filter((box) => box.empty).map(({ empty: _empty, submit: _submit, ...box }) => box);
      return { ...observed, boxes, fingerprint: { ...observed.fingerprint, boxes: empty, submit: empty.length > 0 } };
    });
    expect(await replay({ ...site, observe }, library)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
    expect(site.fills).toEqual(["email"]);
  }
});

// A sign-in in place (`inPlace`): a later stage of the site, or a pop-up a page of the session
// opened, asks a session already signed in for the login again (a step-up). The replay goes on from
// the page as it is, and the site's own marker, which shows there all along, never ends it.

/** `site`, whose markers show by screen (`shows`), keeping each page it opened and each marker it confirmed. */
const withMarkers = (
  site: ReturnType<typeof scriptedSite>,
  screens: Readonly<Record<string, Screen>>,
  shows: Readonly<Record<string, readonly string[]>>,
  /** Whether a marker that shows beside a password box fails the check, as the host's does. */
  passwordFails = false,
) => {
  const opened: string[] = [];
  const confirmed: AutofillSignedIn[] = [];
  const cantTell: number[] = [];
  const here = (indicator: AutofillSignedIn): AutofillSignedInCheck => {
    const screen = screens[site.site.screen];
    const url = `${origin}${screen?.path ?? "/home"}`;
    if (!(shows[site.site.screen] ?? []).includes(indicator.selector ?? ""))
      return { signedIn: false, failed: "indicator_not_visible", url };
    return passwordFails && screen?.boxes.some((box) => box.kind === "password") === true
      ? { signedIn: false, failed: "password_field_visible", url }
      : { signedIn: true, url };
  };
  const hooks: AutofillHooks<TestFailure> = {
    ...site.hooks,
    open: (url) => Effect.zipRight(Effect.sync(() => opened.push(url)), site.hooks.open(url)),
    check: (indicator) => Effect.sync(() => here(indicator)),
    confirm: (indicator) =>
      Effect.sync(() => {
        confirmed.push(indicator);
        return here(indicator);
      }),
    confirmCantTell: () => Effect.sync(() => void cantTell.push(1)),
  };
  return { ...site, hooks, opened, confirmed, cantTell };
};

/** A library that knows a sign-in's states and, beside them, a step-up's with its own marker. */
const withStepUp = (
  library: SignInStates,
  states: readonly { readonly fingerprint: StateFingerprint; readonly step: AutofillRecipeStep }[],
  signedIn: AutofillSignedIn,
) => {
  const appended = appendSignInStates(library, { states, signedIn });
  if ("refused" in appended) throw new Error(appended.refused);
  return appended.library;
};

const stepUpScreen: Screen = { path: "/records", boxes: [{ selector: "#step-password", kind: "password" }], buttons: ["#confirm"] };
const recordsScreen: Screen = { path: "/records", boxes: [], texts: ["your records"], labels: ["download"] };
const stepUpLibrary = withStepUp(
  twoStates,
  [{ fingerprint: arrival(stepUpScreen), step: stepAt("/records", [{ selector: "#step-password", slot: "password" }], "#confirm") }],
  { selector: "#records", openPath: "/records" },
);
const stepUpKey = stepUpLibrary.states.at(-1)?.key;
const stepUpMarker = stepUpLibrary.signedIn.at(-1)?.key;

it("signs in again in place at the step-up the page shows, opening nothing and checking its own marker there", async () => {
  const screens = { start: stepUpScreen, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account", "#records"] },
  );
  const ended = await replay(site, stepUpLibrary, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, visited: [stepUpKey] });
  expect(site.fills).toEqual(["password"]);
  expect(site.clicks).toEqual(["#confirm"]);
  expect(site.opened).toEqual([]);
  expect(site.confirmed).toEqual([{ selector: "#records" }]);
  expect(ended.asked).toEqual([]);
});

it("keeps the login's own picks in place, as a step-up's route is never the login's", async () => {
  const screens = { start: stepUpScreen, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account", "#records"] },
  );
  const own = { states: stepUpLibrary.states.slice(0, 2).map((state) => state.key), signedIn: stepUpLibrary.signedIn[0]?.key };
  const ended = await replay(site, stepUpLibrary, { inPlace: true, choices: own });
  expect(ended).toMatchObject({ outcome: "signed_in", choices: own });
  const none = await replay(
    withMarkers(scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)), screens, {
      start: ["#account"],
      records: ["#records"],
    }),
    stepUpLibrary,
    { inPlace: true },
  );
  expect(none).toMatchObject({ outcome: "signed_in" });
  expect(none).not.toHaveProperty("choices");
  expect(stepUpMarker).toBeDefined();
});

it("ends in place at once where the page shows no known state, opening, typing and asking nothing", async () => {
  const screens = { start: recordsScreen };
  const site = withMarkers(scriptedSite(screens, () => undefined), screens, { start: ["#account"] });
  const began = Date.now();
  const ended = await replay(site, stepUpLibrary, { inPlace: true, stepWaitMs: 5_000 });
  expect(ended).toMatchObject({ outcome: "unsent", reason: "state_not_shown", visited: [] });
  expect(Date.now() - began).toBeLessThan(2_000);
  expect(site.fills).toEqual([]);
  expect(site.clicks).toEqual([]);
  expect(site.opened).toEqual([]);
  expect(site.confirmed).toEqual([]);
  expect(ended.asked).toEqual([]);
});

it("never ends a step-up in place by the site's own marker, nor on a page that can't tell", async () => {
  const checking: Screen = { path: "/checking", boxes: [], texts: ["one moment"] };
  const screens = { start: stepUpScreen, checking };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "checking" : undefined)),
    screens,
    { start: ["#account"], checking: ["#account"] },
  );
  const ended = await replay(site, stepUpLibrary, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "unknown_state" });
  expect(site.fills).toEqual(["password"]);
  expect(site.confirmed.every((marker) => marker.selector === "#records")).toBe(true);
  expect(site.cantTell).toEqual([]);
});

it("acts in place in no state of a step-up recorded with only a marker the page shows all along", async () => {
  // A step-up recorded with the site's own header as its marker, which shows all along.
  const stepCode: Screen = { path: "/records/verify", boxes: [{ selector: "#step-code", kind: "code" }], buttons: ["#verify"] };
  const library = withStepUp(
    twoStates,
    [
      { fingerprint: arrival(stepUpScreen), step: stepAt("/records", [{ selector: "#step-password", slot: "password" }], "#confirm") },
      { fingerprint: arrival(stepCode), step: stepAt("/records/verify", [{ selector: "#step-code", slot: "code" }], "#verify") },
    ],
    { selector: "#account" },
  );
  const screens = { start: stepUpScreen, code: stepCode, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "code" : clicked === "#verify" ? "records" : undefined)),
    screens,
    { start: ["#account"], code: ["#account"], records: ["#account"] },
    true,
  );
  const ended = await replay(site, library, { inPlace: true });
  // Its every state leads only to that marker, so it acts in none of them.
  expect(ended).toMatchObject({ outcome: "unsent", reason: "state_not_shown", visited: [] });
  expect(site.fills).toEqual([]);
  expect(site.clicks).toEqual([]);
  expect(ended.asked).toEqual([]);
});

it("never ends a step-up in place by a marker the page showed before it acted, though the step-up also led to it", async () => {
  // Two recordings share the step-up's first state: one through a code to its own marker, one
  // straight to the site's header, which shows all along.
  const stepCode: Screen = { path: "/records/verify", boxes: [{ selector: "#step-code", kind: "code" }], buttons: ["#verify"] };
  const stepUp = { fingerprint: arrival(stepUpScreen), step: stepAt("/records", [{ selector: "#step-password", slot: "password" }], "#confirm") };
  const library = withStepUp(
    withStepUp(
      twoStates,
      [stepUp, { fingerprint: arrival(stepCode), step: stepAt("/records/verify", [{ selector: "#step-code", slot: "code" }], "#verify") }],
      { selector: "#records" },
    ),
    [stepUp],
    { selector: "#account" },
  );
  const screens = { start: stepUpScreen, code: stepCode, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "code" : clicked === "#verify" ? "records" : undefined)),
    screens,
    { start: ["#account"], code: ["#account"], records: ["#account", "#records"] },
    true,
  );
  const ended = await replay(site, library, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(site.fills).toEqual(["password", "code"]);
  expect(ended.asked).toEqual(["code"]);
  expect(site.confirmed).toEqual([{ selector: "#records" }]);
});

it("acts in place in no state that leads only to a marker the page already shows, as the login's own password state", async () => {
  // A library of the site's own sign-in alone, whose marker, the site's header, shows on a step-up
  // page that looks like its password state.
  const portal: Screen = { path: "/records", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#go"] };
  const screens = { start: portal, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#go" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account"] },
    true,
  );
  const ended = await replay(site, twoStates, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "unsent", reason: "state_not_shown", visited: [] });
  expect(site.fills).toEqual([]);
  expect(site.clicks).toEqual([]);
  // Nor from a value-free check's stop there that the page still shows.
  const passwordKey = twoStates.states.at(-1)?.key ?? "";
  const stop = { visited: [twoStates.states[0]?.key ?? "", passwordKey], state: passwordKey };
  const fromStop = await replay(site, twoStates, { inPlace: true, from: stop });
  expect(fromStop).toMatchObject({ outcome: "unsent", fromStop: { continued: false, reason: "marker_shown_before" } });
  expect(site.fills).toEqual([]);
  // Where the site signed out and shows its own sign-in, the same library signs in again in place.
  const screensOut = { start: emailScreen, password: passwordScreen, records: recordsScreen };
  const signedOut = withMarkers(
    scriptedSite(screensOut, toPassword),
    screensOut,
    { records: ["#account"], home: ["#account"] },
    true,
  );
  expect(await replay(signedOut, twoStates, { inPlace: true })).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(signedOut.fills).toEqual(["email", "password"]);
});

it("still opens the entry URL and signs in by any marker when not in place", async () => {
  const screens = { start: stepUpScreen, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account", "#records"] },
  );
  const ended = await replay(site, stepUpLibrary);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: true, visited: [] });
  expect(site.opened).toEqual([`${origin}/sign-in`]);
  expect(site.fills).toEqual([]);
});

it("goes on in place from a value-free check's stop where it still shows, opening nothing", async () => {
  const screens = { start: stepUpScreen, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account", "#records"] },
  );
  const stop = { visited: [stepUpKey ?? ""], state: stepUpKey ?? "" };
  const ended = await replay(site, stepUpLibrary, { inPlace: true, from: stop });
  expect(ended).toMatchObject({ outcome: "signed_in", visited: [stepUpKey], fromStop: { continued: true } });
  expect(site.fills).toEqual(["password"]);
  expect(site.opened).toEqual([]);
});

it("goes on in place from the state the page shows where a value-free check's stop no longer shows, opening nothing", async () => {
  const screens = { start: stepUpScreen, records: recordsScreen };
  const site = withMarkers(
    scriptedSite(screens, (_at, clicked) => (clicked === "#confirm" ? "records" : undefined)),
    screens,
    { start: ["#account"], records: ["#account", "#records"] },
  );
  const gone = { visited: [stepUpLibrary.states[0]?.key ?? ""], state: stepUpLibrary.states[0]?.key ?? "" };
  const ended = await replay(site, stepUpLibrary, { inPlace: true, from: gone });
  expect(ended).toMatchObject({ outcome: "signed_in", visited: [stepUpKey], fromStop: { continued: false, reason: "page_changed" } });
  expect(site.opened).toEqual([]);
});

// The login's own sign-in in a pop-up a page of the session opened: the scan reads the page that
// opened it, which tells nothing of the pop-up.
const accounts = "https://accounts.example.test";
const popup = { opener: "primary", origin: accounts } as const;
const popupEmail: Screen = { path: "/sign-in", boxes: [{ selector: "#email", kind: "identifier" }], buttons: ["#next"] };
const popupPassword: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#sign-in"] };

/**
 * A task page whose pop-up shows `popupScreens` in turn by `next`, from `first`, until a click
 * closes it ("closed"), which signs the page in.
 */
const popupSite = (
  popupScreens: Readonly<Record<string, Screen>>,
  next: (at: string, clicked: string) => string | undefined,
) => {
  const task: Screen = { path: "/records", boxes: [], texts: ["your records"], labels: ["download"] };
  const site = scriptedSite({ start: task, home: { ...recordsScreen, texts: ["welcome back"] } }, () => undefined);
  const pop = { screen: "first" };
  const shown = () => popupScreens[pop.screen];
  const controls = () => [...(shown()?.boxes ?? []).map((box) => box.selector), ...(shown()?.buttons ?? [])];
  const page = () => `${accounts}${shown()?.path ?? "/"}`;
  const hooks: AutofillHooks<TestFailure> = {
    ...site.hooks,
    inspect: (step) =>
      step.popup === undefined
        ? site.hooks.inspect(step)
        : Effect.sync((): AutofillInspection | AutofillRefusal => {
            const missing = step.fields.findIndex((field) => !controls().includes(field.selector));
            if (missing >= 0) return { outcome: "refused", reason: "not_found", target: missing };
            if (step.submit !== undefined && !controls().includes(step.submit))
              return { outcome: "refused", reason: "not_found", target: "submit" };
            const target = { ownerUrl: page(), documentOrigin: accounts, actions: [`${accounts}/session`], methods: ["post"], editable: true, control: "text" as const };
            return {
              url: page(),
              page: page(),
              targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
              siteOrigin: origin,
              authenticationOrigins: [accounts],
              screen: { origin: accounts, fields: [], submit: null, buttons: [] },
            };
          }),
    fill: (request) =>
      request.step.popup === undefined
        ? site.hooks.fill(request)
        : Effect.sync((): AutofillStepReport => {
            for (const field of request.step.fields) site.fills.push(field.slot);
            if (request.step.submit !== undefined) {
              site.clicks.push(request.step.submit);
              const to = next(pop.screen, request.step.submit);
              if (to === "closed") site.site.screen = "home";
              if (to !== undefined) pop.screen = to;
            }
            return {
              outcome: "filled",
              fields: request.step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
              submit: request.step.submit === undefined ? "none" : "clicked",
              url: page(),
            };
          }),
  };
  return { ...site, hooks, pop };
};

/** A pop-up sign-in recorded as two states while another page of the site had opened it. */
const popupLibrary = withStepUp(
  signInStatesOf({}, []),
  [
    {
      fingerprint: arrival({ path: "/orders", boxes: [], texts: ["your orders"], labels: ["track"] }),
      step: { page: `${accounts}/sign-in`, fields: [email], submit: "#next", popup } as AutofillRecipeStep,
    },
    {
      fingerprint: arrival({ path: "/orders", boxes: [], texts: ["your orders"], labels: ["track"] }),
      step: { page: `${accounts}/password`, fields: [password], submit: "#sign-in", popup } as AutofillRecipeStep,
    },
  ],
  { selector: "#account" },
);

it("signs in again in place through a pop-up's screens, told by their controls there whatever page opened it", async () => {
  const site = popupSite({ first: popupEmail, password: popupPassword }, (_at, clicked) =>
    clicked === "#next" ? "password" : clicked === "#sign-in" ? "closed" : undefined,
  );
  const ended = await replay(site, popupLibrary, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, visited: popupLibrary.states.map((state) => state.key) });
  expect(site.fills).toEqual(["email", "password"]);
  expect(site.clicks).toEqual(["#next", "#sign-in"]);
});

it("takes no next pop-up screen in place while the one acted in still shows there, typing nothing more", async () => {
  const site = popupSite({ first: { ...popupEmail, boxes: [...popupEmail.boxes, { selector: "#password", kind: "password" }], buttons: ["#next", "#sign-in"] } }, () => undefined);
  const ended = await replay(site, popupLibrary, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(site.fills).toEqual(["email"]);
  expect(site.clicks).toEqual(["#next"]);
});

// A page whose boxes the look never counts, as boxes drawn transparent under digits or dots the
// page draws itself, is a state told by its text alone, though its step types into those boxes.
const unseenCode = [1, 2, 3, 4, 5, 6].map((box) => `#code-${box}`);
const drawnCodeScreen: Screen = {
  path: "/verify",
  boxes: [],
  unseen: unseenCode,
  buttons: ["#verify"],
  texts: ["enter the code we sent you"],
  labels: ["verify"],
};
const drawnPasswordScreen: Screen = {
  path: "/password",
  boxes: [],
  unseen: ["#password"],
  buttons: ["#go"],
  texts: ["enter your password"],
  labels: ["go"],
};

it("presses a state told by its text alone once its unseen code boxes are typed, asking for the code once", async () => {
  const library = libraryOf([
    { fingerprint: arrival(drawnCodeScreen), step: stepAt("/verify", unseenCode.map((selector) => ({ selector, slot: "code" as const })), "#verify") },
  ]);
  const site = scriptedSite({ start: drawnCodeScreen }, (_at, clicked) => (clicked === "#verify" ? "home" : undefined));
  const ended = await replay(site, library, { stepWaitMs: 2_000 });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(ended.asked).toEqual(["code"]);
  expect(site.fills).toEqual(unseenCode.map(() => "code"));
  expect(site.clicks).toEqual(["#verify"]);
});

it("presses a password state told by its text alone once its unseen box is typed", async () => {
  const library = libraryOf([
    { fingerprint: arrival(drawnPasswordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  const site = scriptedSite({ start: drawnPasswordScreen }, (_at, clicked) => (clicked === "#go" ? "home" : undefined));
  const ended = await replay(site, library, { stepWaitMs: 2_000 });
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(site.fills).toEqual(["password"]);
  expect(site.clicks).toEqual(["#go"]);
});

it("still takes a state told by its text alone as gone once the page's look changed after typing", async () => {
  const library = libraryOf([
    { fingerprint: arrival(drawnPasswordScreen), step: stepAt("/password", [password], "#go") },
  ]);
  // The page sends what was typed itself, and its look changes before any press.
  const site = scriptedSite({ start: drawnPasswordScreen, home: { path: "/home", boxes: [] } }, () => undefined);
  const fill = site.hooks.fill;
  const sending = {
    ...site,
    hooks: {
      ...site.hooks,
      fill: (request: Parameters<typeof fill>[0]) =>
        Effect.map(fill(request), (report) => {
          site.site.screen = "home";
          return report;
        }),
    },
  };
  const ended = await replay(sending, library, { stepWaitMs: 2_000 });
  expect(ended).toMatchObject({ outcome: "signed_in" });
  expect(site.fills).toEqual(["password"]);
  expect(site.clicks).toEqual([]);
});

it("presses in place a pop-up screen that only presses, once the typed one before it went from the pop-up", async () => {
  const keepSignedIn: Screen = { path: "/keep", boxes: [], buttons: ["#keep"] };
  const library = withStepUp(
    signInStatesOf({}, []),
    [
      { fingerprint: popupLibrary.states[0]?.fingerprint as StateFingerprint, step: popupLibrary.states[0]?.step as AutofillRecipeStep },
      {
        fingerprint: popupLibrary.states[0]?.fingerprint as StateFingerprint,
        step: { page: `${accounts}/keep`, fields: [], submit: "#keep", popup } as AutofillRecipeStep,
      },
    ],
    { selector: "#account" },
  );
  const site = popupSite({ first: popupEmail, keep: keepSignedIn }, (_at, clicked) =>
    clicked === "#next" ? "keep" : clicked === "#keep" ? "closed" : undefined,
  );
  const ended = await replay(site, library, { inPlace: true });
  expect(ended).toMatchObject({ outcome: "signed_in", visited: library.states.map((state) => state.key) });
  expect(site.fills).toEqual(["email"]);
  expect(site.clicks).toEqual(["#next", "#keep"]);
});
