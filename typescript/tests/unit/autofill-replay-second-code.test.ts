import { Data, Effect, Either } from "effect";
import { expect, it } from "vitest";
import { decodeSignInRecipe, type SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";

// A sign-in that asks for two different one-time codes in a row: a phone, a code sent by text in
// a box that sends itself, then a second code sent another way in another box that sends itself.
// The recipe marks the second code screen as a planned code refill, which the replay makes once.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const phone = "+14155550123";
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/** What a fill of a screen did: where the page went, and the markers it shows then. */
interface FillReply {
  readonly next?: string;
  readonly signIn?: boolean;
  readonly markers?: readonly string[];
  /** The page's own instruction for the code box afterwards. */
  readonly instruction?: string;
}
interface SiteScript {
  /** Each screen's visible controls, by screen name. */
  readonly screens: Readonly<Record<string, readonly string[]>>;
  /** What a fill of `screen` with `values` does, `count` the fills of that screen before. */
  readonly fill: (screen: string, values: readonly string[], count: number) => FillReply;
  /** How a fill of a screen with no submit reports its send: the page moved on, or none seen. */
  readonly sent?: "page" | "none";
  /** The `id` and `name` of the element each selector finds; none by default. */
  readonly named?: Readonly<Record<string, { readonly id: string; readonly name: string }>>;
  /** The code box's instruction before any fill. */
  readonly instruction?: string;
}

/** A scripted site on fixture hooks, with the fills it took. */
const scriptedSite = (script: SiteScript) => {
  const state = {
    screen: "sign-in",
    signedIn: false,
    markers: new Set<string>(),
    instruction: script.instruction ?? "Enter the code we texted you",
  };
  const fills: { readonly screen: string; readonly values: readonly string[] }[] = [];
  // Both code screens sit on one path, as a single-page sign-in shows them.
  const at = (screen: string) =>
    `${origin}/${screen === "home" ? "home" : screen === "sign-in" ? "sign-in" : "sign-in/verify"}`;
  const shows = (selector: string) => script.screens[state.screen]?.includes(selector) === true;
  const here = (): AutofillSignedInCheck =>
    state.signedIn && state.screen === "home"
      ? { signedIn: true, url: at("home") }
      : { signedIn: false, failed: "indicator_not_visible", url: at(state.screen) };
  const hooks: AutofillHooks<TestFailure> = {
    open: () =>
      Effect.sync(() => {
        state.screen = "sign-in";
      }),
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    markerVisible: (selector) => Effect.sync(() => state.markers.has(selector)),
    inspect: (step) =>
      Effect.sync((): AutofillInspection | { readonly outcome: "refused"; readonly reason: "not_found" } => {
        const selectors = [
          ...step.fields.map((field) => field.selector),
          ...(step.submit === undefined ? [] : [step.submit]),
        ];
        if (!selectors.every(shows)) return { outcome: "refused", reason: "not_found" };
        return {
          url: at(state.screen),
          page: at(state.screen),
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
              name: script.named?.[field.selector]?.name ?? null,
              id: script.named?.[field.selector]?.id ?? null,
              autocomplete: null,
              inputmode: null,
              label: field.slot === "code" ? state.instruction : "Phone",
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
        const screen = state.screen;
        const count = fills.filter((fill) => fill.screen === screen).length;
        fills.push({ screen, values: [...values] });
        const reply = script.fill(screen, values, count);
        if (reply.signIn === true) state.signedIn = true;
        if (reply.next !== undefined) state.screen = reply.next;
        if (reply.instruction !== undefined) state.instruction = reply.instruction;
        state.markers = new Set(reply.markers ?? []);
        return {
          outcome: "filled",
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submit === undefined ? (script.sent ?? "page") : "clicked",
          url: at(state.screen),
        };
      }),
  };
  /** The codes typed, in order. */
  const codes = () =>
    fills.filter(({ screen }) => screen !== "sign-in").flatMap(({ values }) => values);
  return { hooks, fills, codes, state };
};

/** Replays `recipe` with a phone login, the owner answering each code question in turn. */
const replay = (recipe: SignInRecipe, hooks: AutofillHooks<TestFailure>, answers: string[]) => {
  const codes = [...answers];
  const asked: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(
      () =>
        Object.fromEntries(
          request.questions.map((question) => {
            asked.push(question.id);
            return [question.id, question.id === "code" ? (codes.shift() ?? "999999") : ""];
          }),
        ) as InputAnswers,
    ),
  );
  return Effect.runPromise(
    Effect.either(
      replayAutofillRecipe({
        recipe,
        hooks,
        entryUrl: `${origin}/sign-in`,
        credentials: { username: phone, primaryIdentifierKind: "phone", phone },
        ask,
        // The login's phone is the one registered value a control's naming can hold.
        broker: {
          register: () => Effect.void,
          registeredSecretMatches: (text) => Effect.succeed(text.includes(phone) ? [phone] : []),
        },
        site: "example.test",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 60, pollMs: 2 },
        sent: { current: false },
      }).pipe(Effect.scoped),
    ),
  ).then((outcome) => ({ outcome, asked: asked.filter((id) => id === "code").length }));
};

const phoneStep = {
  page: `${origin}/sign-in`,
  fields: [{ selector: "#phone", accepts: ["phone" as const] }],
  submit: "#next",
};
const textCodeStep = {
  page: `${origin}/sign-in/verify`,
  fields: [{ selector: "#text-code", slot: "code" as const }],
};
const emailCodeStep = {
  page: `${origin}/sign-in/verify`,
  fields: [{ selector: "#email-code", slot: "code" as const }],
  refills: ["code" as const],
};
const twoCodes = (...steps: SignInRecipe["steps"][number][]): SignInRecipe => ({
  version: 5,
  steps: steps as SignInRecipe["steps"],
  signedIn: { selector: "#account" },
});
const screens = {
  "sign-in": ["#phone", "#next"],
  text: ["#text-code"],
  email: ["#email-code"],
  home: [],
};
/** The text code, then the other code, sign in; a code screen shown again stays put. */
const twoCodeSite = (sent: "page" | "none" = "page") =>
  scriptedSite({
    screens,
    sent,
    fill: (screen, values) =>
      screen === "sign-in"
        ? { next: "text" }
        : screen === "text"
          ? values[0] === "111111"
            ? { next: "email" }
            : {}
          : values[0] === "222222"
            ? { next: "home", signIn: true }
            : {},
  });

it.each(["page", "none"] as const)(
  "signs in through two different self-sending code screens when the second is recorded as a code refill (send seen: %s)",
  async (sent) => {
    const site = twoCodeSite(sent);
    const { outcome, asked } = await replay(
      twoCodes(phoneStep, textCodeStep, emailCodeStep),
      site.hooks,
      ["111111", "222222"],
    );
    expect(outcome).toEqual(
      Either.right(expect.objectContaining({ outcome: "signed_in", alreadySignedIn: false })),
    );
    expect(site.fills.map(({ screen }) => screen)).toEqual(["sign-in", "text", "email"]);
    expect(site.codes()).toEqual(["111111", "222222"]);
    expect(asked).toBe(2);
  },
);

it("reads a recipe whose second code screen refills the code", () => {
  const recipe = twoCodes(phoneStep, textCodeStep, emailCodeStep);
  expect(decodeSignInRecipe(JSON.stringify(recipe))).toEqual(recipe);
});

it("still refuses the second code screen of a recipe that records no refill there", async () => {
  const { refills: _refills, ...unmarked } = emailCodeStep;
  const site = twoCodeSite();
  const { outcome } = await replay(twoCodes(phoneStep, textCodeStep, unmarked), site.hooks, [
    "111111",
    "222222",
  ]);
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
  expect(site.codes()).toEqual(["111111"]);
});

it("sends no third code when the refilled code screen comes back with no refusal shown", async () => {
  const site = scriptedSite({
    screens,
    fill: (screen) =>
      screen === "sign-in" ? { next: "text" } : screen === "text" ? { next: "email" } : {},
  });
  const { outcome, asked } = await replay(
    twoCodes(phoneStep, textCodeStep, emailCodeStep),
    site.hooks,
    ["111111", "222222", "333333"],
  );
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
  expect(site.codes()).toEqual(["111111", "222222"]);
  expect(asked).toBe(2);
});

it("asks for a fresh code, as before, when the site shows it refused the refilled code", async () => {
  const site = scriptedSite({
    screens: { ...screens, email: ["#email-code", "#email-code-error"] },
    fill: (screen, values) =>
      screen === "sign-in"
        ? { next: "text" }
        : screen === "text"
          ? { next: "email" }
          : values[0] === "333333"
            ? { next: "home", signIn: true }
            : { markers: ["#email-code-error"] },
  });
  const marked = {
    ...emailCodeStep,
    rejectedMarkers: [{ slot: "code" as const, selector: "#email-code-error" }],
  };
  const { outcome } = await replay(twoCodes(phoneStep, textCodeStep, marked), site.hooks, [
    "111111",
    "222222",
    "333333",
  ]);
  expect(outcome).toEqual(Either.right(expect.objectContaining({ outcome: "signed_in" })));
  expect(site.codes()).toEqual(["111111", "222222", "333333"]);
});

it("refuses a third code screen after the planned code refill went out", async () => {
  const appCodeStep = {
    page: `${origin}/sign-in/verify`,
    fields: [{ selector: "#app-code", slot: "code" as const }],
    refills: ["code" as const],
  };
  const site = scriptedSite({
    screens: { ...screens, app: ["#app-code"] },
    // The second code box sends itself with no send the host sees.
    sent: "none",
    fill: (screen) =>
      screen === "sign-in"
        ? { next: "text" }
        : screen === "text"
          ? { next: "email" }
          : screen === "email"
            ? { next: "app" }
            : { next: "home", signIn: true },
  });
  const { outcome, asked } = await replay(
    twoCodes(phoneStep, textCodeStep, emailCodeStep, appCodeStep),
    site.hooks,
    ["111111", "222222", "333333"],
  );
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
  expect(site.codes()).toEqual(["111111", "222222"]);
  expect(asked).toBe(2);
});

// Both codes typed into the same box, told apart only by the box's instruction: the replay can't
// tell the second code screen from the first shown again, so a refill there is refused.
it.each([
  ["different", ["111111", "222222"]],
  ["equal", ["111111", "111111"]],
])(
  "refuses a code refill into the same box the first code went into (%s values)",
  async (_name, answers) => {
    const site = scriptedSite({
      screens: { ...screens, text: ["#code"], email: ["#code"] },
      fill: (screen) =>
        screen === "sign-in"
          ? { next: "text" }
          : screen === "text"
            ? { next: "email", instruction: "Enter the code we emailed you" }
            : { next: "home", signIn: true },
    });
    const box = {
      page: `${origin}/sign-in/verify`,
      fields: [{ selector: "#code", slot: "code" as const }],
    };
    const { outcome } = await replay(
      twoCodes(phoneStep, box, { ...box, refills: ["code"] }),
      site.hooks,
      answers,
    );
    expect(outcome).toEqual(
      Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
    );
    expect(site.codes()).toEqual([answers[0]]);
  },
);

// A replay never types a code it already sent this sign-in, so a second code equal to the first
// is held back, and the sign-in ends unanswered rather than typing it again.
it("never types a second code equal to the first", async () => {
  const site = twoCodeSite();
  const { outcome } = await replay(
    twoCodes(phoneStep, textCodeStep, emailCodeStep),
    site.hooks,
    ["111111", "111111"],
  );
  expect(outcome).toEqual(
    Either.left(new TestFailure({ code: "unanswered:code_already_rejected" })),
  );
  expect(site.codes()).toEqual(["111111"]);
});

// One box the page finds under two selectors, whose first code it refuses with no error shown:
// the second recorded code screen is that same box, by its id and name, so no refill goes into it.
it("sends no code refill into the box the first code went into, found under another selector", async () => {
  const box = { id: "otp", name: "otp" };
  const site = scriptedSite({
    screens: { ...screens, text: ["#otp", "input[name=otp]", "#otp-error"] },
    named: { "#otp": box, "input[name=otp]": box },
    fill: (screen, _values, count) =>
      screen === "sign-in"
        ? { next: "text" }
        : count === 0
          ? {}
          : { markers: ["#otp-error"] },
  });
  const first = {
    page: `${origin}/sign-in/verify`,
    fields: [{ selector: "#otp", slot: "code" as const }],
  };
  const alias = {
    page: `${origin}/sign-in/verify`,
    fields: [{ selector: "input[name=otp]", slot: "code" as const }],
    refills: ["code" as const],
    rejectedMarkers: [{ slot: "code" as const, selector: "#otp-error" }],
  };
  const { outcome } = await replay(twoCodes(phoneStep, first, alias), site.hooks, [
    "111111",
    "222222",
    "333333",
    "444444",
  ]);
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
  expect(site.codes()).toEqual(["111111"]);
});

// A second code screen of one-character boxes that takes some of the first screen's boxes again,
// under other selectors, is not another code screen: every box has to be another.
it("sends no code refill into a row of boxes that takes some of the first row's boxes again", async () => {
  const firstRow = [0, 1, 2, 3, 4, 5].map((index) => `#t${String(index)}`);
  const reused = [0, 1, 2].map((index) => `input[name=t${String(index)}]`);
  const secondRow = [...reused, ...[3, 4, 5].map((index) => `#e${String(index)}`)];
  const boxName = (selector: string) => selector.replace(/^#|^input\[name=|\]$/gu, "");
  const named = Object.fromEntries(
    [...firstRow, ...secondRow].map((selector) => [
      selector,
      { id: boxName(selector), name: boxName(selector) },
    ]),
  );
  const site = scriptedSite({
    screens: { ...screens, text: firstRow, email: secondRow },
    named,
    fill: (screen) =>
      screen === "sign-in"
        ? { next: "text" }
        : screen === "text"
          ? { next: "email" }
          : { next: "home", signIn: true },
  });
  const boxes = (selectors: readonly string[]) =>
    selectors.map((selector) => ({ selector, slot: "code" as const }));
  const { outcome } = await replay(
    twoCodes(
      phoneStep,
      { page: `${origin}/sign-in/verify`, fields: boxes(firstRow) },
      { page: `${origin}/sign-in/verify`, fields: boxes(secondRow), refills: ["code"] },
    ),
    site.hooks,
    ["111111", "222222"],
  );
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
  expect(site.fills.map(({ screen }) => screen)).toEqual(["sign-in", "text"]);
});

// The first code box's instruction names the login's phone, so the sign-in keeps no id or name
// for it; the same box under the same selector is still the same box, so no refill goes into it.
it("sends no code refill into the same box when the first box's naming held the login's phone", async () => {
  const site = scriptedSite({
    screens: { ...screens, text: ["#code", "#code-error"] },
    named: { "#code": { id: "code", name: "code" } },
    instruction: `Enter the code we texted to ${phone}`,
    fill: (screen, _values, count) =>
      screen === "sign-in" ? { next: "text" } : count === 0 ? {} : { markers: ["#code-error"] },
  });
  const box = {
    page: `${origin}/sign-in/verify`,
    fields: [{ selector: "#code", slot: "code" as const }],
  };
  const { outcome } = await replay(
    twoCodes(phoneStep, box, {
      ...box,
      refills: ["code"],
      rejectedMarkers: [{ slot: "code", selector: "#code-error" }],
    }),
    site.hooks,
    ["111111", "222222", "333333", "444444"],
  );
  expect(site.codes()).toEqual(["111111"]);
  expect(outcome).toEqual(
    Either.right(expect.objectContaining({ reason: "credential_already_filled" })),
  );
});
