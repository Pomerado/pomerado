import { Effect, Either, TestContext } from "effect";
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
