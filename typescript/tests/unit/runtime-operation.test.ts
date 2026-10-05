import { Effect, Exit, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { CaptureUnavailable } from "../../src/runtime/errors.js";
import { defineOperation, executeOperation } from "../../src/runtime/operation.js";
import { browserPromise } from "../../src/browser/promise.js";
import { leftOf } from "../support/expect-failure.js";

const makeContext = (lifecycle: string[] = []) =>
  Effect.gen(function* () {
    const journal = yield* makeEffectJournal;
    return {
      deadline: Deadline.after(),
      journal,
      events: { emit: () => Effect.void },
      capture: {
        start: Effect.sync(() => {
          lifecycle.push("start");
        }),
        finish: Effect.sync(() => {
          lifecycle.push("finish");
        }),
      },
    };
  });

describe("operation host", () => {
  it("rejects invalid input before capture allocation or operation effects", async () => {
    const lifecycle: string[] = [];
    let effects = 0;
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Struct({ resourceId: Schema.String }),
      output: Schema.Number,
      run: () =>
        Effect.sync(() => {
          effects += 1;
          return 42;
        }),
    });
    const context = await Effect.runPromise(makeContext(lifecycle));
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, { resourceId: 23 })).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    expect(leftOf(result)._tag).toBe("InvalidInput");
    expect(effects).toBe(0);
    expect(lifecycle).toEqual([]);
  });

  it("keeps verified website outcome when output validation fails and closes capture", async () => {
    const lifecycle: string[] = [];
    const context = await Effect.runPromise(makeContext(lifecycle));
    const operation = defineOperation({
      name: "reserve",
      input: Schema.Void,
      output: Schema.Number.pipe(Schema.positive()),
      run: () =>
        Effect.gen(function* () {
          const execution = yield* ExecutionContext;
          yield* execution.journal.enteringDispatch;
          yield* execution.journal.verified;
          return -1;
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    const failure = leftOf(result);
    expect(failure._tag).toBe("InvalidOutput");
    // The schema error that rejected the output stays as its cause.
    expect(failure.cause).toMatchObject({ _tag: "ParseError" });
    expect(await Effect.runPromise(context.journal.state)).toBe("verified");
    expect(lifecycle).toEqual(["start", "finish"]);
  });

  it("returns the operation's result and records a gap when capture cannot finish", async () => {
    const events: { readonly name: string; readonly details: unknown }[] = [];
    const journal = await Effect.runPromise(makeEffectJournal);
    const context = {
      deadline: Deadline.after(),
      journal,
      events: {
        emit: (name: string, details: unknown) =>
          Effect.sync(() => {
            events.push({ name, details });
          }),
      },
      capture: {
        start: Effect.void,
        finish: Effect.fail(
          new CaptureUnavailable({ phase: "finish", captureReason: "storage_failed" }),
        ),
      },
    };
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Void,
      output: Schema.Number,
      run: () => Effect.succeed(42),
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
      ),
    );
    expect(exit).toEqual(Exit.succeed(42));
    expect(events).toContainEqual({
      name: "capture.finish_gap",
      details: { phase: "finish", reason: "storage_failed" },
    });
  });

  it("hands the host what an operation returned past its output schema", async () => {
    const context = await Effect.runPromise(makeContext());
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Void,
      output: Schema.Struct({ amount: Schema.Number }),
      // A script that returns what its schema does not allow, as a drifted site makes it do.
      run: () => Effect.succeed(Schema.decodeUnknownSync(Schema.Any)({ amount: "forty-two" })),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    expect(leftOf(result)).toMatchObject({
      _tag: "InvalidOutput",
      output: { amount: "forty-two" },
    });
  });

  it("constructs Promise adapters lazily and supplies the shared remaining budget", async () => {
    const context = await Effect.runPromise(makeContext());
    let calls = 0;
    const operation = browserPromise(
      context,
      "read",
      ({ remainingMs }) => {
        calls += 1;
        return Promise.resolve(remainingMs());
      },
      { timeoutMs: 200 },
    );
    expect(calls).toBe(0);
    const remaining = await Effect.runPromise(operation);
    expect(calls).toBe(1);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(200);
  });

  // The frozen deadline clock leaves the test clock to end the window. A slow observation keeps
  // the number of polls the test clock must step through small.

  it("nested budgets cannot outlive their parent", () => {
    let now = 0;
    const outer = Deadline.after(100, () => now);
    now = 90;
    expect(outer.child(5_000).remainingMs()).toBe(10);
    now = 101;
    expect(outer.remainingMs()).toBe(0);
  });

  it("does not start a Promise after logging consumed the remaining budget", async () => {
    let now = 0;
    const context = await Effect.runPromise(makeContext());
    let dispatched = false;
    const result = await Effect.runPromise(
      browserPromise(
        {
          ...context,
          deadline: Deadline.after(100, () => now),
          events: {
            emit: () =>
              Effect.sync(() => {
                now = 101;
              }),
          },
        },
        "click",
        () => {
          dispatched = true;
          return Promise.resolve();
        },
        {
          deadline: Deadline.after(5_000, () => now),
        },
      ).pipe(Effect.either),
    );
    expect(leftOf(result)).toMatchObject({
      _tag: "DeadlineExceeded",
      dispatch: "not_sent",
      pwTimeoutSource: "action_default",
    });
    expect(dispatched).toBe(false);
  });

  it.each([
    { timeoutMs: undefined, expected: "action_default" },
    { timeoutMs: 5_000, expected: "explicit_option" },
  ])(
    "reports $expected for an exhausted parent with option $timeoutMs without claiming its cause",
    async ({ timeoutMs, expected }) => {
      let now = 0;
      const context = await Effect.runPromise(makeContext());
      const parent = Deadline.after(10, () => now);
      now = 11;
      let called = false;
      const result = await Effect.runPromise(
        browserPromise(
          { ...context, deadline: parent },
          "read",
          () => {
            called = true;
            return Promise.resolve("ready");
          },
          timeoutMs === undefined ? {} : { timeoutMs },
        ).pipe(Effect.either),
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: { _tag: "DeadlineExceeded", dispatch: "not_sent", pwTimeoutSource: expected },
      });
      expect(called).toBe(false);
    },
  );

  it("keeps native Promise rejection separate from deadline configuration", async () => {
    const context = await Effect.runPromise(makeContext());
    const result = await Effect.runPromise(
      browserPromise(context, "read", () => Promise.reject(new Error("native locator failed")), {
        timeoutMs: 5_000,
      }).pipe(Effect.either),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "BrowserFailure" } });
    expect(leftOf(result)).not.toHaveProperty("pwTimeoutSource");
  });

  it("leaves an outer operation deadline untagged", async () => {
    const context = await Effect.runPromise(makeContext());
    const operation = defineOperation({
      name: "slow_read",
      input: Schema.Void,
      output: Schema.Void,
      run: () => Effect.never,
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(
          Layer.succeed(ExecutionContext, { ...context, deadline: Deadline.after(10) }),
        ),
        Effect.either,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "DeadlineExceeded", phase: "execution" },
    });
    expect(leftOf(result)).not.toHaveProperty("pwTimeoutSource");
  });

  it("finalizes capture on an interrupted operation without changing its effect journal", async () => {
    const lifecycle: string[] = [];
    const context = await Effect.runPromise(makeContext(lifecycle));
    const operation = defineOperation({
      name: "interrupted_write",
      input: Schema.Void,
      output: Schema.Void,
      run: () =>
        Effect.gen(function* () {
          yield* context.journal.enteringDispatch;
          return yield* Effect.interrupt;
        }),
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(lifecycle).toEqual(["start", "finish"]);
    expect(await Effect.runPromise(context.journal.state)).toBe("may_have_dispatched");
  });
});
