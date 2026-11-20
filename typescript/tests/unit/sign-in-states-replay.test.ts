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
  options: {
    readonly password?: string;
    readonly valueFree?: boolean;
    readonly siteAnswer?: "link" | "refused";
    readonly stepWaitMs?: number;
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
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        ...(options.siteAnswer === undefined
          ? {}
          : { hosted: { siteAnswer: () => Effect.succeed(options.siteAnswer) } }),
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
          ask: makeInputAsker(() => Effect.dieMessage("Unexpected question")),
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
  const ended = await replay(learned, libraryOf([emailState, askText, textCode]));
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
});

it("never takes a learned look-alike that would send the password again", async () => {
  const pw: Screen = { path: "/password", boxes: [{ selector: "#password", kind: "password" }], buttons: ["#go", "#go2"] };
  const library = libraryOf([
    { fingerprint: arrival(pw), step: stepAt("/password", [password], "#go") },
    { fingerprint: arrival(pw), step: stepAt("/password", [password], "#go2") },
  ]);
  const site = scriptedSite({ start: pw }, () => "start");
  expect(await replay(site, library)).toMatchObject({ outcome: "unclear", reason: "credential_screen_returned" });
  expect(site.fills).toEqual(["password"]);
  expect(site.clicks).toEqual(["#go"]);
});
