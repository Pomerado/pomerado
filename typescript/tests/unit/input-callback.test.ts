import { Clock, Effect, Either, Fiber, TestClock, TestContext } from "effect";
import { expect, it, vi } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";

const request: InputRequest = {
  id: "2c7e9a14-5b3d-4f6e-8a1c-9d0b2e4f6a8c",
  source: "agent",
  questions: [{ id: "note", type: "text", prompt: "A note", maxLength: 10 }],
};

it.each([-1, 0])("does not ask after the source deadline %s", async (sourceEndsAt) => {
  const answer = vi.fn(() => Effect.succeed({ note: "ready" }));
  const result = await Effect.runPromise(
    Effect.either(makeInputAsker(answer)(request, { sourceEndsAt })).pipe(
      Effect.provide(TestContext.TestContext),
    ),
  );

  expect(result).toEqual(Either.left(expect.objectContaining({ code: "NoResponse" })));
  expect(answer).not.toHaveBeenCalled();
});

it("accepts an immediate answer while the source is still live", async () => {
  const answer = vi.fn(() => Effect.succeed({ note: "ready" }));
  const result = await Effect.runPromise(
    makeInputAsker(answer)(request, { sourceEndsAt: 60_000 }).pipe(
      Effect.provide(TestContext.TestContext),
    ),
  );

  expect(result).toEqual({ note: { type: "text", value: "ready" } });
  expect(answer).toHaveBeenCalledOnce();
});

it.each([
  { preparationMs: 200, waitMs: 100, timesOut: true },
  { preparationMs: 300, waitMs: 100, timesOut: true },
  { preparationMs: 100, waitMs: 100, timesOut: false },
])(
  "includes $preparationMs ms of eager preparation in the source deadline",
  async ({ preparationMs, waitMs, timesOut }) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* Effect.clock;
        let preparedMs = 0;
        // Advance the callback's clock during eager preparation without real waiting.
        // Its returned Effect still sleeps on the shared test clock.
        const callbackClock = Object.assign(Object.create(clock) as Clock.Clock, {
          currentTimeMillis: Effect.sync(() => clock.unsafeCurrentTimeMillis() + preparedMs),
        });
        const answer = () => {
          preparedMs += preparationMs;
          return Effect.succeed({ note: "ready" }).pipe(Effect.delay(waitMs));
        };
        const fiber = yield* Effect.fork(
          Effect.either(makeInputAsker(answer)(request, { sourceEndsAt: 250 })).pipe(
            Effect.withClock(callbackClock),
          ),
        );
        yield* TestClock.adjust(500);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(result).toEqual(
      timesOut
        ? Either.left(expect.objectContaining({ code: "NoResponse" }))
        : Either.right({ note: { type: "text", value: "ready" } }),
    );
  },
);
