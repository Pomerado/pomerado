import { Clock, Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeReplayScreenWait } from "../../src/runtime/autofill-replay-screens.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A recorded screen that has not shown may sit behind a challenge or the site's own checkpoint
// page. Once the page settled without the screen, the host's challenge look runs then, not only at
// the screen's 30 s deadline; a slow page still gets the whole wait.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const page = "https://example.test/login";
const form = {
  fields: [{ slot: "password", selector: "#password" }],
  submit: "#next",
} satisfies AutofillStep;
const shown = {
  page,
  siteOrigin: "https://example.test",
  authenticationOrigins: [],
  targets: { fields: [], submit: null },
  screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
};
const stepWaitMs = 30_000;

/**
 * What the page shows over time: a checkpoint page the host's look clears, a page that holds still
 * without the screen, one that keeps changing, or the screen itself.
 */
type Showing = "checkpoint" | "still" | "changing" | "form";

/**
 * One screen wait on a scripted page, on the test clock from 0: `showing` says what the page shows
 * at a time, and the host's look clears a checkpoint page into the form. `challenge: false` is a
 * host with no challenge look, `pageState: false` one that reads no page state.
 */
const waitOn = async (
  showing: (now: number) => Showing,
  host: { readonly challenge?: boolean; readonly pageState?: boolean; readonly popup?: boolean } = {},
) => {
  const step: AutofillStep = host.popup
    ? { ...form, popup: { opener: "primary", origin: "https://accounts.example.test" } }
    : form;
  let cleared = false;
  const looks: number[] = [];
  const events: Readonly<Record<string, unknown>>[] = [];
  const at = (now: number) => {
    const shows = showing(now);
    return cleared && shows === "checkpoint" ? "form" : shows;
  };
  const hooks: AutofillHooks<TestFailure, "first_party"> = {
    inspect: () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          at(now) === "form" ? shown : { outcome: "refused" as const, reason: "not_found" as const },
        ),
      ),
    check: () => Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page }),
    ...(host.pageState === false
      ? {}
      : {
          pageState: () =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                const shows = at(now);
                return { parsed: true, shape: `${page}|${shows === "changing" ? now : shows}` };
              }),
            ),
        }),
    ...(host.challenge === false
      ? {}
      : {
          challenge: Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            looks.push(now);
            if (at(now) !== "checkpoint") return undefined;
            cleared = true;
            return { outcome: "cleared" as const, vendor: "first_party" as const };
          }),
        }),
    fill: () => Effect.dieMessage("Unexpected fill"),
    confirm: () => Effect.dieMessage("Unexpected confirm"),
    open: () => Effect.dieMessage("Unexpected open"),
  };
  const wait = makeReplayScreenWait(
    {
      hooks,
      entryUrl: page,
      recipe: { version: 1, steps: [{ ...step, page }], signedIn: { selector: "#identity" } },
      emit: (details) => Effect.sync(() => void events.push(details)),
      correlation: { jobId: "job", attemptId: "attempt" },
      credentials: { username: "user", password: "secret" },
    },
    { anythingSent: false, ran: [] },
    { stepWaitMs, pollMs: 250 },
    () => step,
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const waiting = yield* Effect.fork(wait(step, stepWaitMs, page));
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(waiting))) break;
        yield* TestClock.adjust(Duration.millis(250));
      }
      const result = yield* Fiber.join(waiting);
      const endedAt = yield* Clock.currentTimeMillis;
      return { result, endedAt, looks, events };
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
};

const lookEvents = (events: readonly Readonly<Record<string, unknown>>[]) =>
  events.filter((event) => event.stage === "challenge_look");

it("looks at a checkpoint page once it settled, long before the deadline, and goes on to the screen", async () => {
  const { result, endedAt, looks, events } = await waitOn(() => "checkpoint");

  expect(result).toEqual({ found: shown });
  expect(looks).toHaveLength(1);
  // The page held still 1.5 s (`landingSettleMs`), then the next poll looked.
  expect(looks[0]).toBeGreaterThanOrEqual(1_500);
  expect(looks[0]).toBeLessThan(3_000);
  expect(endedAt).toBeLessThan(5_000);
  expect(lookEvents(events)).toEqual([
    { stage: "challenge_look", look: "early", outcome: "cleared" },
  ]);
});

it("keeps waiting for a slow page whose screen shows at 20 s after a look found nothing", async () => {
  const { result, endedAt, looks, events } = await waitOn((now) =>
    now >= 20_000 ? "form" : "still",
  );

  expect(result).toEqual({ found: shown });
  expect(endedAt).toBeGreaterThanOrEqual(20_000);
  expect(endedAt).toBeLessThan(stepWaitMs);
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeLessThan(3_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "none" }]);
});

it("ends at the deadline on a page with no challenge, with no second look at a page unchanged", async () => {
  const { result, endedAt, looks, events } = await waitOn(() => "still");

  expect(result).toEqual({ found: { outcome: "refused", reason: "not_found" } });
  expect(endedAt).toBeGreaterThanOrEqual(stepWaitMs);
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeLessThan(3_000);
  expect(lookEvents(events)).toEqual([{ stage: "challenge_look", look: "early", outcome: "none" }]);
});

it("looks at the deadline at a page that changed since its early look", async () => {
  const { result, looks, events } = await waitOn((now) => (now >= 29_000 ? "changing" : "still"));

  expect(result).toEqual({ found: { outcome: "refused", reason: "not_found" } });
  expect(looks).toHaveLength(2);
  expect(looks[1]).toBeGreaterThanOrEqual(stepWaitMs);
  expect(lookEvents(events).map((event) => event.look)).toEqual(["early", "deadline"]);
});

it("looks only at the deadline at a page that never holds still, as before", async () => {
  const { result, looks, events } = await waitOn(() => "changing");

  expect(result).toEqual({ found: { outcome: "refused", reason: "not_found" } });
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeGreaterThanOrEqual(stepWaitMs);
  expect(lookEvents(events)).toEqual([
    { stage: "challenge_look", look: "deadline", outcome: "none" },
  ]);
});

it("waits for the deadline as before on a host that reads no page state", async () => {
  const { result, looks } = await waitOn(() => "checkpoint", { pageState: false });

  expect(result).toEqual({ found: shown });
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeGreaterThanOrEqual(stepWaitMs);
});

it("ends at the deadline as before on a host with no challenge look", async () => {
  const { result, endedAt, events } = await waitOn(() => "checkpoint", { challenge: false });

  expect(result).toEqual({ found: { outcome: "refused", reason: "not_found" } });
  expect(endedAt).toBeGreaterThanOrEqual(stepWaitMs);
  expect(lookEvents(events)).toEqual([]);
});

it("looks only at the deadline for a screen in a pop-up, whose page the host's state does not read", async () => {
  const { result, looks } = await waitOn(() => "checkpoint", { popup: true });

  expect(result).toEqual({ found: shown });
  expect(looks).toHaveLength(1);
  expect(looks[0]).toBeGreaterThanOrEqual(stepWaitMs);
});
