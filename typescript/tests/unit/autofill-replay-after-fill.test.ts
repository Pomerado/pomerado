import { Clock, Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import { locatedRefusal } from "../../src/destinations/autofill-refusal.js";
import { refusalEvidence } from "../../src/destinations/autofill-refusal-evidence.js";
import type { AutofillSignedInCheck, AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// What a screen's wait does after the host filled a screen: a fill whose screen went with nothing
// sent waits again once, as a single-page app's login route removes its form while it sends a
// signed-in browser on; and once the login went out, a page off the sign-in screens that can't
// tell, such as an account picker, signs in, though a code screen's wait runs to its deadline first.
// A submitted screen still showing is the site's answer only at the wait's deadline.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const pollMs = 50;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const passwordScreen = {
  page: login,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#go",
};
const isPassword = (step: AutofillStep) =>
  step.fields.some((field) => field.selector === "#password");
const shownAt = (page: string, step: AutofillStep) => ({
  page,
  siteOrigin: origin,
  authenticationOrigins: [],
  targets: {
    fields: step.fields.map(() => target),
    submit: { ...target, editable: false, control: "other" as const },
  },
  screen: { origin, fields: [], submit: null, buttons: ["Sign in"] },
});

/** Replays `recipe` with the login on `hooks`, the test clock moving one poll at a time. */
const replay = async (
  recipe: AutofillRecipe,
  hooks: AutofillHooks<TestFailure>,
  hostCode?: string,
) => {
  const events: unknown[] = [];
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: login,
          credentials: { username: "synthetic-user", password: "synthetic-password" },
          ask: () => Effect.dieMessage("Unexpected question"),
          broker: {
            register: () => Effect.void,
            registeredSecretMatches: () => Effect.succeed([]),
          },
          site: "example.test",
          correlation: undefined,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          failures: {
            unanswered: () => new TestFailure({ code: "Unanswered" }),
            unavailable: () => new TestFailure({ code: "Unavailable" }),
          },
          timing: { stepWaitMs: 5_000, pollMs },
          sent: { current: false },
          ...(hostCode === undefined
            ? {}
            : { hosted: { code: () => Effect.succeed({ slot: "code" as const, value: hostCode }) } }),
        }).pipe(Effect.scoped),
      );
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(running))) break;
        yield* TestClock.adjust(Duration.millis(pollMs));
      }
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  return { outcome, events };
};

/**
 * A saved profile's login form that the page removes as the host fills it, sending nothing, then
 * the page moves on to the signed-in home page; with `stays`, the form stays and the fill failed.
 */
const goneUnderFill = (stays: boolean) => {
  let page: "login" | "home" = "login";
  const here = (): AutofillSignedInCheck =>
    page === "home"
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        if (!stays) page = "home";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "failed" as const })),
          submit: "not_attempted" as const,
          url: login,
        };
      }),
  };
  return hooks;
};

const recipe: AutofillRecipe = {
  version: 2,
  steps: [passwordScreen],
  signedIn: { selector: "#identity" },
};

it("waits again once when a fill's screen went with nothing sent, and finds the session signed in", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(false));
  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
  expect(events).toContainEqual({ stage: "retried", reason: "screen_gone" });
});

it("ends a failed fill whose screen still shows as before", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(true));
  expect(outcome).toMatchObject({ outcome: "unsent", reason: "fill_failed" });
  expect(events).not.toContainEqual({ stage: "retried", reason: "screen_gone" });
});

/**
 * A login form whose submit the page takes away once a field was typed, sending nothing, as a site
 * that turns its Continue into its single sign-on control once it knows the login does. Enter in
 * the last field sends the form and signs the session in; `pressed` holds each step that took it.
 */
const submitGoneOnTyping = () => {
  let typed = false;
  let signedIn = false;
  const pressed: AutofillStep[] = [];
  const here = (): AutofillSignedInCheck =>
    signedIn
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        signedIn || (typed && step.submit !== undefined)
          ? ({ outcome: "refused", reason: "not_found", target: "submit" } as const)
          : shownAt(login, step),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        typed = true;
        if (step.submitKey !== undefined) {
          pressed.push(step);
          signedIn = true;
        }
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: step.submitKey === undefined ? ("refused" as const) : ("clicked" as const),
          url: login,
        };
      }),
  };
  return { hooks, pressed };
};

it("presses Enter once in an identifier field whose submit went once it was typed, with nothing sent", async () => {
  const { hooks, pressed } = submitGoneOnTyping();
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        { page: login, fields: [{ selector: "#email", accepts: ["username"] }], submit: "#continue" },
      ],
      signedIn: { selector: "#identity" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(pressed).toHaveLength(1);
  expect(pressed[0]).toMatchObject({ fields: [{ selector: "#email" }], submitKey: "Enter" });
  expect(pressed[0]).not.toHaveProperty("submit");
  expect(events).toContainEqual({ stage: "retried", reason: "submit_gone_after_typing" });
});

it("never presses Enter in a password field whose submit went once it was typed", async () => {
  const { hooks, pressed } = submitGoneOnTyping();
  const { outcome } = await replay(recipe, hooks);
  expect(outcome).toMatchObject({ outcome: "unsent", reason: "not_found" });
  expect(pressed).toEqual([]);
});

it("signs in on an account picker that can't tell in place of a code screen, once the code screen's wait ran out", async () => {
  let page: "login" | "picker" = "login";
  const confirmed: unknown[] = [];
  const here = (): AutofillSignedInCheck =>
    page === "picker"
      ? { signedIn: false, failed: "path_mismatch", url: `${origin}/choose` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        page = "picker";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: login,
        };
      }),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        passwordScreen,
        { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
      ],
      signedIn: { selector: "#identity", urlPath: "/account" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, cantTell: true });
  expect(events).not.toContainEqual({ stage: "skipped", reason: "cant_tell_landing" });
  expect(confirmed).toHaveLength(1);
});

it("waits for a password screen the site shows 1.5 s after the identifier went out", async () => {
  let continuedAt: number | undefined;
  let signedIn = false;
  const here = (): AutofillSignedInCheck =>
    signedIn
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    // The site looks the account up for 1.5 s, showing the identifier screen meanwhile.
    inspect: (step) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          isPassword(step) === (continuedAt !== undefined && now - continuedAt >= 1_500)
            ? shownAt(login, step)
            : ({ outcome: "refused", reason: "not_found" } as const),
        ),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (isPassword(step)) signedIn = true;
          else continuedAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
  };
  const { outcome } = await replay(
    {
      version: 2,
      steps: [
        { page: login, fields: [{ selector: "#email", accepts: ["username"] }], submit: "#continue" },
        passwordScreen,
      ],
      signedIn: { selector: "#identity" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
});

// A site may show a page the recipe never recorded, such as a security check, between the login
// and its recorded code screen. The code screen's wait doesn't read that page as a landing that
// can't tell, so the code screen that shows 4 s after the login, within the 5 s wait, gets its code.
it("waits for a recorded code screen through an unrecorded page that can't tell, then fills it", async () => {
  let sentAt: number | undefined;
  let codeSent = false;
  const confirmed: unknown[] = [];
  const pageNow = Clock.currentTimeMillis.pipe(
    Effect.map((now) =>
      codeSent
        ? "account"
        : sentAt === undefined
          ? "login"
          : now - sentAt < 4_000
            ? "security"
            : "verify",
    ),
  );
  const here = Effect.map(
    pageNow,
    (page): AutofillSignedInCheck =>
      page === "account"
        ? { signedIn: true, url: `${origin}/account` }
        : page === "security"
          ? { signedIn: false, failed: "path_mismatch", url: `${origin}/checkpoint` }
          : {
              signedIn: false,
              failed: "indicator_not_visible",
              url: page === "login" ? login : `${origin}/verify`,
            },
  );
  const isCode = (step: AutofillStep) => step.fields.some((field) => field.slot === "code");
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => here,
    confirm: () => here,
    inspect: (step) =>
      Effect.map(pageNow, (page) =>
        isCode(step) && page === "verify"
          ? shownAt(`${origin}/verify`, step)
          : isPassword(step) && page === "login"
            ? shownAt(login, step)
            : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (isCode(step)) codeSent = true;
          else sentAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        passwordScreen,
        { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
      ],
      signedIn: { selector: "#identity", urlPath: "/account" },
    },
    hooks,
    "246810",
  );
  expect(codeSent).toBe(true);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(outcome).not.toHaveProperty("cantTell");
  expect(events).not.toContainEqual({ stage: "skipped", reason: "cant_tell_landing" });
  expect(confirmed).toHaveLength(0);
});

// A page that redraws after a submit may show the old screen's button beside the new screen's for
// a moment, so the next step's submit matches both. Once a screen ran, the step waits as a screen
// not yet shown does, and refuses as it always did only if it still matches both at its deadline.
// Before any screen ran, it refuses at once. Nothing is typed or clicked while it matches two.
const ambiguous = locatedRefusal({
  error: "ambiguous_match",
  target: "submit",
  searched: { frames: 1, matches: [{ frameUrl: origin, count: 2, visible: 2 }] },
});
const codeRecipe: AutofillRecipe = {
  version: 2,
  steps: [
    passwordScreen,
    { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
  ],
  signedIn: { selector: "#identity" },
};

/**
 * The password screen, then a code screen whose step matches two buttons from the password's
 * submit until `twoForMs` later (always, when undefined; from the start, when `fromStart`), with
 * when each screen was filled and when each code-screen look ran, in the test clock's time.
 */
const redrawn = (twoForMs: number | undefined, fromStart = false) => {
  const filled: { step: string; at: number }[] = [];
  const looks: number[] = [];
  let sentAt: number | undefined;
  let signedIn = false;
  const here = (): AutofillSignedInCheck =>
    signedIn
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const isCode = (step: AutofillStep) => step.fields.some((field) => field.slot === "code");
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (fromStart) return ambiguous;
          if (isPassword(step)) return sentAt === undefined ? shownAt(login, step) : ambiguous;
          if (sentAt === undefined) return { outcome: "refused", reason: "not_found" } as const;
          looks.push(now - sentAt);
          return twoForMs === undefined || now - sentAt < twoForMs
            ? ambiguous
            : shownAt(`${origin}/verify`, step);
        }),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          filled.push({ step: isCode(step) ? "code" : "password", at: now });
          if (isCode(step)) signedIn = true;
          else sentAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
  };
  return { hooks, filled, looks };
};

const refusedAmbiguous = {
  stage: "step",
  outcome: "refused",
  reason: "ambiguous_match",
  ...refusalEvidence(ambiguous),
};

it("waits after a submit through a step that matches two buttons while the page redraws, then fills it once it matches one", async () => {
  const { hooks, filled, looks } = redrawn(400);
  const { outcome, events } = await replay(codeRecipe, hooks, "246810");
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(filled.map(({ step }) => step)).toEqual(["password", "code"]);
  expect(looks.filter((at) => at < 400).length).toBeGreaterThan(0);
  expect(filled[1]!.at - filled[0]!.at).toBe(400);
  expect(events).not.toContainEqual(refusedAmbiguous);
});

it("fills a step found with one match right after a submit with no added wait", async () => {
  const { hooks, filled, looks } = redrawn(0);
  const { outcome } = await replay(codeRecipe, hooks, "246810");
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(looks).toEqual([0]);
  expect(filled.map(({ step, at }) => [step, at])).toEqual([
    ["password", 0],
    ["code", 0],
  ]);
});

it("refuses a step that still matches two buttons at its deadline after a submit, as it did at once before", async () => {
  const { hooks, filled, looks } = redrawn(undefined);
  const { outcome, events } = await replay(codeRecipe, hooks, "246810");
  expect(outcome).toEqual({ outcome: "unclear", reason: "ambiguous_match" });
  expect(filled.map(({ step }) => step)).toEqual(["password"]);
  // The screen's wait is 5 s from the submit here; its last look runs at the first poll past it.
  expect(looks.at(-1)).toBe(5_000);
  expect(events).toContainEqual(refusedAmbiguous);
});

it("refuses a step that matches two buttons before any screen ran at once, as before", async () => {
  const { hooks, filled } = redrawn(undefined, true);
  const started: number[] = [];
  const { outcome, events } = await replay(
    codeRecipe,
    {
      ...hooks,
      inspect: (step) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) => started.push(now)),
          Effect.zipRight(hooks.inspect(step)),
        ),
    },
    "246810",
  );
  expect(outcome).toEqual({ outcome: "unsent", reason: "ambiguous_match" });
  expect(filled).toEqual([]);
  expect(started).toEqual([0]);
  expect(events).toContainEqual(refusedAmbiguous);
});
