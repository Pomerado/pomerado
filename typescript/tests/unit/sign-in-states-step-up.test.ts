import { createHash } from "node:crypto";
import { Data, Effect, Either, Schema, Struct } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type { AutofillInspection, AutofillSignedInCheck } from "../../src/destinations/autofill-step.js";
import * as States from "../../src/destinations/sign-in-states.js";
import {
  appendSignInStates,
  decodeSignInStateEntry,
  type ObservedSignIn,
  type ObservedState,
  SignInStateEntry,
  signInStateEntryText,
  type SignInStates,
  signInStatesOf,
  signInStatesRecipe,
  type StateFingerprint,
} from "../../src/destinations/sign-in-states.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { InputAnswers } from "../../src/runtime/input-request.js";
import { replaySignInStates } from "../../src/runtime/sign-in-states-replay.js";

// A library holding a site's own sign-in and, recorded after it, a step-up (`stepUp`): a later
// page of a signed-in session that asks for the password again, here with the same look as the
// sign-in's own password page but its own controls and marker. Every host is synthetic.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const site = "https://app.example.com";
const password = "synthetic-password";

interface Page {
  readonly box?: "identifier" | "password";
  readonly controls: readonly string[];
  readonly markers: readonly string[];
}
const pages: Readonly<Record<string, Page>> = {
  "/sign-in": { box: "identifier", controls: ["#email", "#continue"], markers: [] },
  "/password": { box: "password", controls: ["#password", "#go"], markers: [] },
  "/home": { controls: [], markers: ["#account"] },
  "/records/confirm": { box: "password", controls: ["#step-password", "#confirm"], markers: ["#account"] },
  "/records": { controls: [], markers: ["#account", "#records"] },
};
const next: Readonly<Record<string, string>> = { "#continue": "/password", "#go": "/home", "#confirm": "/records" };

const look = (box: "identifier" | "password"): StateFingerprint => ({ top: site, boxes: [{ frame: site, kind: box }], submit: true });
const step = (path: string, field: AutofillRecipeStep["fields"][number], submit: string): AutofillRecipeStep => ({
  page: `${site}${path}`,
  fields: [field],
  submit,
});

const own: ObservedSignIn = {
  states: [
    { fingerprint: look("identifier"), step: step("/sign-in", { selector: "#email", accepts: ["email"] }, "#continue") },
    { fingerprint: look("password"), step: step("/password", { selector: "#password", slot: "password" }, "#go") },
  ],
  signedIn: { selector: "#account" },
};
const stepUp: ObservedSignIn = {
  stepUp: true,
  states: [{ fingerprint: look("password"), step: step("/records/confirm", { selector: "#step-password", slot: "password" }, "#confirm") }],
  signedIn: { selector: "#records" },
};

const append = (library: SignInStates, observed: ObservedSignIn) => {
  const appended = appendSignInStates(library, observed);
  if ("refused" in appended) throw new Error(appended.refused);
  return appended;
};
const library = append(append(signInStatesOf({}, []), own).library, stepUp).library;

/** The site, opening on `opensOn` when given (as a site that remembers the login), else the URL. */
const fakeSite = (start: string, opensOn?: string) => {
  const state = { at: start, typed: undefined as string | undefined };
  const fills: string[] = [];
  const inspected: string[] = [];
  const shows = (selector: string) => pages[state.at]?.controls.includes(selector) === true;
  const here = (selector: string | undefined): AutofillSignedInCheck =>
    selector !== undefined && pages[state.at]?.markers.includes(selector) === true
      ? pages[state.at]?.box === "password"
        ? { signedIn: false, failed: "password_field_visible", url: `${site}${state.at}` }
        : { signedIn: true, url: `${site}${state.at}` }
      : { signedIn: false, failed: "indicator_not_visible", url: `${site}${state.at}` };
  const hooks: AutofillHooks<TestFailure> = {
    inspect: (asked) =>
      Effect.sync(() => {
        inspected.push(asked.submit ?? "");
        const selectors = [...asked.fields.map((field) => field.selector), ...(asked.submit === undefined ? [] : [asked.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused" as const, reason: "not_found" as const };
        const page = `${site}${state.at}`;
        const target = { ownerUrl: page, documentOrigin: site, actions: [page], methods: ["post"], editable: true, control: "text" as const };
        const inspection: AutofillInspection = {
          url: page,
          page,
          targets: { fields: asked.fields.map(() => target), submit: asked.submit === undefined ? null : target },
          siteOrigin: site,
          authenticationOrigins: [],
          screen: { origin: site, fields: [], submit: null, buttons: [] },
        };
        return inspection;
      }),
    fill: ({ step: asked, values }) =>
      Effect.sync(() => {
        // Each box is typed alone, then its submit pressed with nothing typed.
        fills.push(...asked.fields.map((field) => field.selector));
        if (asked.fields.length > 0) state.typed = values[0];
        const to = asked.submit === undefined ? undefined : next[asked.submit];
        if (to !== undefined && (asked.submit === "#continue" || state.typed === password)) state.at = to;
        if (asked.submit !== undefined) state.typed = undefined;
        return {
          outcome: "filled" as const,
          fields: asked.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: asked.submit === undefined ? ("none" as const) : ("clicked" as const),
          url: `${site}${state.at}`,
        };
      }),
    check: (indicator) => Effect.sync(() => here(indicator.selector)),
    confirm: (indicator) =>
      Effect.sync(() => {
        if (indicator.openPath !== undefined) state.at = indicator.openPath;
        return here(indicator.selector);
      }),
    open: () =>
      Effect.sync(() => {
        state.at = opensOn ?? "/sign-in";
      }),
    markerVisible: () => Effect.succeed(false),
  };
  const observe = Effect.sync((): ObservedState => {
    const box = pages[state.at]?.box;
    const boxes = box === undefined ? [] : [{ frame: site, kind: box }];
    return {
      fingerprint: box === undefined ? { top: site, boxes, submit: false, message: state.at, buttons: [] } : { top: site, boxes, submit: true },
      boxes: boxes.map((shown) => ({ ...shown, empty: true, submit: true })),
      texts: [],
    };
  });
  return { hooks, observe, state, fills, inspected };
};

const signIn = (fake: ReturnType<typeof fakeSite>, inPlace?: true) =>
  Effect.runPromise(
    Effect.either(
      replaySignInStates({
        library,
        observe: fake.observe,
        hooks: fake.hooks,
        entryUrl: `${site}/sign-in`,
        credentials: { username: "ada@example.com", password },
        ask: makeInputAsker(() => Effect.succeed({} as InputAnswers)),
        broker: { register: () => Effect.void, registeredSecretMatches: () => Effect.succeed([]) },
        site: "app.example.com",
        correlation: undefined,
        emit: () => Effect.void,
        failures: {
          unanswered: (cause) => new TestFailure({ code: `unanswered:${String(cause)}` }),
          unavailable: () => new TestFailure({ code: "unavailable" }),
        },
        timing: { stepWaitMs: 200, pollMs: 2 },
        quiet: { quietMs: 20, capMs: 120, enterMs: 40 },
        sent: { current: false },
        ...(inPlace === undefined ? {} : { inPlace }),
      }),
    ),
  ).then((outcome) => {
    if (Either.isLeft(outcome)) throw outcome.left;
    return outcome.right;
  });

it("views a library as the login's recipe without a step-up recorded after its sign-in, and as the step-up's with every step", () => {
  expect(signInStatesRecipe(library)).toMatchObject({
    steps: [{ submit: "#continue" }, { submit: "#go" }],
    signedIn: { selector: "#account" },
  });
  expect(signInStatesRecipe(library, { signedIn: library.signedIn.at(-1)?.key })?.signedIn).toEqual({ selector: "#account" });
  expect(States.signInStatesStepUpRecipe(library)).toMatchObject({
    steps: [{ submit: "#continue" }, { submit: "#go" }, { submit: "#confirm" }],
    signedIn: { selector: "#records" },
  });
  expect(States.signInStatesStepUpRecipe(append(signInStatesOf({}, []), own).library)).toBeUndefined();
});

it("never takes a step-up's state as a sign-in's first screen from the entry URL", async () => {
  // The site remembers the login and opens on its own password page, which looks as the step-up does.
  const fake = fakeSite("/sign-in", "/password");
  const ended = await signIn(fake);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(fake.fills).toEqual(["#password"]);
  // The step-up's state is never one it looks for.
  expect(fake.inspected).not.toContain("#confirm");
});

it("signs in again in place at the step-up the page shows, by the step-up's own marker", async () => {
  const fake = fakeSite("/records/confirm");
  const ended = await signIn(fake, true);
  expect(ended).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, visited: [library.states.at(-1)?.key] });
  expect(fake.fills).toEqual(["#step-password"]);
});

it("keys a step-up's entries apart from the same sign-in's, and stores every other entry as before", () => {
  const tagged = append(signInStatesOf({}, []), { ...own, stepUp: true }).added;
  const untagged = append(signInStatesOf({}, []), own).added;
  expect(tagged.filter((entry) => entry.kind !== "transition").every((entry) => "stepUp" in entry && entry.stepUp === true)).toBe(true);
  expect(tagged.map((entry) => entry.key).filter((key) => untagged.some((entry) => entry.key === key))).toEqual([]);
  expect(untagged.map(signInStateEntryText).some((text) => text.includes("stepUp"))).toBe(false);
  // An entry recorded before the tag keeps its bytes and its key, the hash of its content alone.
  const content = '{"selector":"#account"}';
  const key = createHash("sha256").update(content).digest("hex").slice(0, 32);
  expect(signInStateEntryText(untagged.find((entry) => entry.kind === "signed_in") as SignInStateEntry)).toBe(
    `{"format":1,"key":"${key}","kind":"signed_in","selector":"#account"}`,
  );
  expect(tagged.map(signInStateEntryText).map(decodeSignInStateEntry)).toEqual(tagged);
});

it("leaves a step-up's entries out for a core that reads entries without the tag", () => {
  // A core before the tag decodes format 1 strictly, without `stepUp`, so it drops each tagged
  // entry as it drops any field it does not know, and keeps every other entry.
  const strict = { parseOptions: { onExcessProperty: "error" as const } };
  const [state, transition, signedIn] = SignInStateEntry.members;
  const older = Schema.Union(
    Schema.Struct(Struct.omit(state.fields, "stepUp")).annotations(strict),
    transition,
    Schema.Struct(Struct.omit(signedIn.fields, "stepUp")).annotations(strict),
  );
  const read = (entry: SignInStateEntry) => Schema.decodeUnknownOption(older)(JSON.parse(signInStateEntryText(entry)));
  const added = append(append(signInStatesOf({}, []), own).library, stepUp).added;
  expect(added.filter((entry) => entry.kind !== "transition").map((entry) => read(entry)._tag)).toEqual(["None", "None"]);
  expect(append(signInStatesOf({}, []), own).added.every((entry) => read(entry)._tag === "Some")).toBe(true);
});

it("gives each step-up's own recipe, from the step-up's first state to its marker", () => {
  const billing: ObservedSignIn = {
    stepUp: true,
    states: [
      { fingerprint: look("identifier"), step: step("/billing/who", { selector: "#who", accepts: ["email"] }, "#next") },
      { fingerprint: look("password"), step: step("/billing/confirm", { selector: "#bill-password", slot: "password" }, "#pay") },
    ],
    signedIn: { selector: "#billing" },
  };
  const both = append(library, billing).library;
  expect(States.signInStatesStepUps(both)).toMatchObject([
    { steps: [{ submit: "#confirm" }], signedIn: { selector: "#records" } },
    { steps: [{ submit: "#next" }, { submit: "#pay" }], signedIn: { selector: "#billing" } },
  ]);
  expect(States.signInStatesStepUps(append(signInStatesOf({}, []), own).library)).toEqual([]);
  expect(both.states.filter(States.isStepUpEntry).length).toBe(3);
});
