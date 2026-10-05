import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { browserPromise } from "../../src/browser/promise.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { defineOperation, executeOperation } from "../../src/runtime/operation.js";

const fixtureContext = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* makeEffectJournal;
      return {
        deadline: Deadline.after(),
        journal,
        events: { emit: () => Effect.void },
        capture: { start: Effect.void, finish: Effect.void },
      };
    }),
  );

test("pw identifies its configured timeout when a native locator waits longer than the action budget", async ({
  page,
}) => {
  await page.setContent(
    "<div id='ready'></div><script>setTimeout(() => { document.querySelector('#ready').textContent = 'Ready'; }, 5_500)</script>",
  );
  const execution = await fixtureContext();
  const started = performance.now();
  const first = await Effect.runPromise(
    browserPromise(execution, "wait for ready control", () =>
      page.getByText("Ready").waitFor({ timeout: 15_000 }),
    ).pipe(Effect.either),
  );
  expect(first).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "DeadlineExceeded",
      phase: "wait for ready control",
      dispatch: "unknown",
      pwTimeoutSource: "action_default",
    },
  });
  expect(performance.now() - started).toBeLessThan(7_000);
  const second = await Effect.runPromise(
    browserPromise(
      execution,
      "wait for ready control",
      () => page.getByText("Ready").waitFor({ timeout: 15_000 }),
      {
        timeoutMs: 7_000,
      },
    ).pipe(Effect.either),
  );
  expect(second).toMatchObject({ _tag: "Right" });
  await expect(page.getByText("Ready")).toBeVisible();
  expect(await Effect.runPromise(execution.journal.state)).toBe("not_started");
});

test("an Effect write declared unverifiable cannot record a confirmation or mark itself verified", async () => {
  const outcome = async (record: "confirmed" | "verified") => {
    const execution = await fixtureContext();
    const write = defineOperation({
      name: "unverifiable_write",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "unverifiable" },
      run: () =>
        Effect.gen(function* () {
          const context = yield* ExecutionContext;
          yield* record === "confirmed"
            ? context.journal.confirmed("message")
            : context.journal.verified;
          return {};
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(write, {})).pipe(
        Effect.provideService(ExecutionContext, execution),
        Effect.either,
      ),
    );
    return { result, effect: await Effect.runPromise(execution.journal.state) };
  };
  for (const record of ["confirmed", "verified"] as const)
    expect(await outcome(record)).toMatchObject({
      result: {
        _tag: "Left",
        left: { _tag: "WriteConfirmationRefused", declared: "unverifiable" },
      },
      effect: "not_started",
    });
});
