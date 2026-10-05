import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { failureCause, InvalidOutput } from "../../src/runtime/errors.js";
import { OperationFailure } from "../../src/runtime/operation-failure.js";

describe("a failed execution's cause", () => {
  it("reports an interrupted execution as cancelled", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.never);
        return yield* Fiber.interrupt(fiber);
      }),
    );
    if (!Exit.isFailure(exit)) throw new Error("The interrupted fiber did not fail");
    expect(failureCause(exit.cause)).toEqual({ class: "cancelled" });
  });

  it("names an output that missed its schema, and claims nothing for other failures", () => {
    expect(failureCause(Cause.fail(new InvalidOutput({ operation: "list_products" })))).toEqual({
      class: "output_contract",
    });
    expect(failureCause(Cause.fail(new OperationFailure("No results table")))).toBeUndefined();
    expect(failureCause(Cause.die(new Error("bug")))).toBeUndefined();
  });
});
