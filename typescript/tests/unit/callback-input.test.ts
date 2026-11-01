import { Effect, Either, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  InputRequestFailure,
  type InputRequest,
} from "../../src/runtime/input-request.js";

const request: InputRequest = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "agent",
  questions: [
    {
      id: "note",
      type: "text",
      prompt: "Which note should I keep?",
    },
  ],
};

const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    TestClock.setTime(0).pipe(
      Effect.zipRight(effect),
      Effect.provide(TestContext.TestContext),
    ),
  );

describe("makeInputAsker deadlines", () => {
  it.each([0, -1])(
    "does not invoke the callback when the deadline is already expired (%i)",
    async (sourceEndsAt) => {
      let calls = 0;

      const ask = makeInputAsker(() => {
        calls += 1;
        return Effect.succeed({ note: "ready" });
      });

      const result = await onTestClock(
        Effect.either(ask(request, { sourceEndsAt })),
      );

      expect(Either.isLeft(result)).toBe(true);

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(InputRequestFailure);
        expect(result.left).toMatchObject({ code: "NoResponse" });
      }

      expect(calls).toBe(0);
    },
  );

  it("accepts an immediate answer before a future deadline", async () => {
    let calls = 0;

    const ask = makeInputAsker(() => {
      calls += 1;
      return Effect.succeed({ note: "ready" });
    });

    const result = await onTestClock(
      Effect.either(ask(request, { sourceEndsAt: 1 })),
    );

    expect(result).toEqual(
      Either.right({
        note: { type: "text", value: "ready" },
      }),
    );

    expect(calls).toBe(1);
  });
});
