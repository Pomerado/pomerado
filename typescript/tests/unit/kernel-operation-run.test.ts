import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";
import {
  ExecutionContext,
  makeEffectJournal,
  makeEffectJournalWith,
} from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { CaptureUnavailable } from "../../src/runtime/errors.js";
import type { KernelExecuteClient } from "../../src/runtime/kernel-operation.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { commitReportOf } from "../../src/runtime/run-outcome.js";
import { defineOperation } from "../../src/runtime/operation.js";
import {
  makeScriptInput,
  ScriptInput,
  ScriptInputFailure,
} from "../../src/runtime/script-input.js";
import { offlineKernel } from "../support/offline-kernel.js";

/** A browser that answers every call with success, without provider HTTP. */
const answeringKernel: KernelExecuteClient = {
  browsers: { playwright: { execute: async () => ({ success: true, result: null }) } },
};

const run = async <A, E>(
  program: Effect.Effect<A, E, ExecutionContext | Scope.Scope>,
  journalOf = makeEffectJournal,
  deadline = Deadline.after(60_000),
) => {
  const journal = await Effect.runPromise(journalOf);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      program.pipe(
        Effect.provideService(ExecutionContext, {
          deadline,
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        }),
      ),
    ),
  );
  return { exit, websiteEffect: await Effect.runPromise(journal.state) };
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected the script to fail");
  return Cause.failureOption(exit.cause);
};

describe("executeKernelOperation", () => {
  it("returns the script's result and records a gap when capture cannot finish", async () => {
    const events: { readonly name: string; readonly details: unknown }[] = [];
    const journal = await Effect.runPromise(makeEffectJournal);
    const operation = defineOperation(
      { input: Schema.Struct({}), output: Schema.Struct({ title: Schema.String }) },
      async () => ({ title: "Example Domain" }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        executeKernelOperation(operation, {}, { kernel: offlineKernel, sessionId: "session-1" }).pipe(
          Effect.provideService(ExecutionContext, {
            deadline: Deadline.after(60_000),
            journal,
            events: {
              emit: (name, details) =>
                Effect.sync(() => {
                  events.push({ name, details });
                }),
            },
            capture: {
              start: Effect.void,
              finish: Effect.fail(new CaptureUnavailable({ phase: "finish" })),
            },
          }),
        ),
      ),
    );
    expect(exit).toEqual(Exit.succeed({ title: "Example Domain" }));
    expect(events).toContainEqual({ name: "capture.finish_gap", details: { phase: "finish" } });
  });

  it("marks a live run possibly dispatched before its first call, and an offline one never", async () => {
    const write = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      async ({ verified }) => {
        verified();
        return "saved";
      },
    );
    const silent = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      async () => "read",
    );
    expect(
      await run(executeKernelOperation(silent, {}, { kernel: answeringKernel, sessionId: "s" })),
    ).toEqual({ exit: Exit.succeed("read"), websiteEffect: "may_have_dispatched" });
    // An offline run cannot reach a site, so its mark changes nothing.
    expect(
      await run(
        executeKernelOperation(write, {}, { kernel: offlineKernel, sessionId: "s", offline: true }),
      ),
    ).toEqual({ exit: Exit.succeed("saved"), websiteEffect: "not_started" });
  });

  it("runs an offline script without a browser, and a call it makes fails unsent", async () => {
    const parser = defineOperation(
      { input: Schema.Struct({ text: Schema.String }), output: Schema.Number },
      async ({ input }) => input.text.length,
    );
    expect(
      await run(
        executeKernelOperation(
          parser,
          { text: "abc" },
          { kernel: offlineKernel, sessionId: "offline", offline: true },
        ),
      ),
    ).toEqual({ exit: Exit.succeed(3), websiteEffect: "not_started" });
    const calling = defineOperation(
      { input: Schema.Struct({}), output: Schema.Null },
      async ({ kernel, sessionId }) => {
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
        return null;
      },
    );
    const called = await run(
      executeKernelOperation(calling, {}, { kernel: offlineKernel, sessionId: "offline", offline: true }),
    );
    expect(failureOf(called.exit)).toMatchObject(
      Option.some({ _tag: "OperationFailure", dispatch: "not_sent" }),
    );
  });

  // A confirmed write that then fails keeps its confirmed commit step in the runner's report, so a
  // host reading it sees the write confirmed live; a browser call after verified() reopens it.
  it.each([
    { after: "throws", effect: "verified", confirmation: "readback", state: "confirmed" },
    { after: "returns invalid output", effect: "verified", confirmation: "readback", state: "confirmed" },
    { after: "calls the browser, then throws", effect: "may_have_dispatched", confirmation: undefined, state: "sent" },
  ])("reports the commit step $state when a confirmed write $after", async (expected) => {
    const write = defineOperation(
      {
        input: Schema.Struct({}),
        output: Schema.Struct({ saved: Schema.Boolean }),
        write: { confirmation: "readback", commits: ["save"] },
      },
      async ({ kernel, sessionId, enteringCommit, verified }) => {
        enteringCommit("save");
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
        verified();
        if (expected.after === "returns invalid output")
          return { saved: "yes" } as unknown as { saved: boolean };
        if (expected.after === "calls the browser, then throws")
          await kernel.browsers.playwright.execute(sessionId, { code: "return 2;", timeout_sec: 5 });
        throw new Error("Another field differs after the save");
      },
    );
    const journal = await Effect.runPromise(makeEffectJournal);
    const { exit, websiteEffect } = await run(
      executeKernelOperation(write, {}, { kernel: answeringKernel, sessionId: "s" }),
      Effect.succeed(journal),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(websiteEffect).toBe(expected.effect);
    expect(await Effect.runPromise(journal.confirmation)).toBe(expected.confirmation);
    const commits = await Effect.runPromise(journal.commits);
    expect(commitReportOf({ commits })).toEqual({
      evidence: "entered",
      marks: [{ name: "save", state: expected.state }],
    });
  });

  // A host may settle commit steps an earlier run sent or confirmed: entering one fails before its
  // execute call, and the steps still unsent enter as usual.
  it("refuses a commit step already settled, before its execute call", async () => {
    const write = (step: string) =>
      defineOperation(
        {
          input: Schema.Struct({}),
          output: Schema.String,
          write: { confirmation: "readback", commits: ["save-address", "place-order"] },
        },
        async ({ kernel, sessionId, enteringCommit }) => {
          enteringCommit(step);
          await kernel.browsers.playwright.execute(sessionId, {
            code: "return 1;",
            timeout_sec: 10,
          });
          return step;
        },
      );
    const attempt = async (step: string) => {
      let calls = 0;
      const kernel: KernelExecuteClient = {
        browsers: {
          playwright: {
            execute: async () => {
              calls += 1;
              return { success: true, result: 1 };
            },
          },
        },
      };
      const journal = await Effect.runPromise(
        makeEffectJournalWith({ settledCommits: ["save-address", "confirm-terms"] }),
      );
      const outcome = await run(
        executeKernelOperation(write(step), {}, { kernel, sessionId: "s" }),
        Effect.succeed(journal),
      );
      return { ...outcome, calls, commits: await Effect.runPromise(journal.commits) };
    };
    const refused = await attempt("save-address");
    expect(failureOf(refused.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "CommitAlreadySent", name: "save-address" })),
    );
    expect(refused.calls).toBe(0);
    expect(refused.commits).toEqual([
      { name: "save-address", state: "not_sent" },
      { name: "place-order", state: "not_sent" },
    ]);
    const confirmed = await attempt("confirm-terms");
    expect(failureOf(confirmed.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "CommitAlreadySent", name: "confirm-terms" })),
    );
    expect(confirmed.calls).toBe(0);
    const finished = await attempt("place-order");
    expect(finished.exit).toEqual(Exit.succeed("place-order"));
    expect(finished.calls).toBe(1);
    expect(finished.commits).toEqual([
      { name: "save-address", state: "not_sent" },
      { name: "place-order", state: "sent" },
    ]);
  });

  it("fails before dispatch when the deadline is already spent, and as unknown when it passes mid-run", async () => {
    const spent = Deadline.after(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const quick = defineOperation({ input: Schema.Struct({}), output: Schema.String }, async () => "done");
    const late = await run(
      executeKernelOperation(quick, {}, { kernel: answeringKernel, sessionId: "s" }),
      makeEffectJournal,
      spent,
    );
    expect(failureOf(late.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "DeadlineExceeded", dispatch: "not_sent" })),
    );
    expect(late.websiteEffect).toBe("not_started");
    const hanging = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      () => new Promise<string>(() => {}),
    );
    const expired = await run(
      executeKernelOperation(hanging, {}, { kernel: answeringKernel, sessionId: "s" }),
      makeEffectJournal,
      Deadline.after(50),
    );
    expect(failureOf(expired.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "DeadlineExceeded", dispatch: "unknown" })),
    );
    expect(expired.websiteEffect).toBe("may_have_dispatched");
  });

  it("refuses output its schema rejects", async () => {
    const wrong = defineOperation(
      { input: Schema.Struct({}), output: Schema.Number },
      async () => "not a number" as unknown as number,
    );
    const exit = (await run(executeKernelOperation(wrong, {}, { kernel: answeringKernel, sessionId: "s" })))
      .exit;
    expect(failureOf(exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "InvalidOutput" })),
    );
  });

  it("runs a host's `first` in place of the script, with the script's run as its fallback", async () => {
    const script = defineOperation(
      { input: Schema.Struct({ query: Schema.String }), output: Schema.String },
      async ({ input }) => `script:${input.query}`,
    );
    const firstSaw: string[] = [];
    const fallback = await run(
      executeKernelOperation(script, { query: "a" }, { kernel: answeringKernel, sessionId: "s" }, (run, input) => {
        firstSaw.push(input.query);
        return run;
      }),
    );
    expect(fallback.exit).toEqual(Exit.succeed("script:a"));
    expect(firstSaw).toEqual(["a"]);
    const replaced = await run(
      executeKernelOperation(script, { query: "b" }, { kernel: answeringKernel, sessionId: "s" }, () =>
        Effect.succeed("first:b"),
      ),
    );
    expect(replaced.exit).toEqual(Exit.succeed("first:b"));
  });
});

describe("a script's browser hand-off", () => {
  const review = {
    review: { type: "browser_handoff", prompt: "Check the saved address, then mark it done." },
    note: { type: "text", prompt: "Anything to add?" },
  } as const;
  /** A write over two steps that saves the address, hands off, then reports its marks. */
  const write = (handed: "review" | "note") =>
    defineOperation(
      {
        input: Schema.Struct({}),
        output: Schema.String,
        questions: review,
        write: { confirmation: "readback", commits: ["save-address", "place-order"] },
      },
      async ({ handOff, enteringCommit, verified }) => {
        enteringCommit("save-address");
        verified();
        // A text question is not a hand-off; the runtime refuses it before anyone is asked.
        await (handed === "review" ? handOff("review") : handOff(handed as "review"));
        return "done";
      },
    );
  const attempt = async (handed: "review" | "note", journalOf = makeEffectJournal) => {
    const asked: string[] = [];
    const journal = await Effect.runPromise(journalOf);
    const scriptInput = makeScriptInput(review, (request) =>
      Effect.sync(() => {
        asked.push(...request.questions.map((question) => question.type));
        return { review: { done: true } };
      }),
    );
    const outcome = await run(
      executeKernelOperation(write(handed), {}, { kernel: answeringKernel, sessionId: "s" }).pipe(
        Effect.provideService(ScriptInput, scriptInput),
      ),
      Effect.succeed(journal),
    );
    return { ...outcome, asked, commits: await Effect.runPromise(journal.commits) };
  };

  it("keeps a confirmed step confirmed and marks every unsent one sent before it asks", async () => {
    const handed = await attempt("review");
    expect(handed.exit).toEqual(Exit.succeed("done"));
    expect(handed.asked).toEqual(["browser_handoff"]);
    expect(handed.commits).toEqual([
      { name: "save-address", state: "confirmed" },
      { name: "place-order", state: "sent" },
    ]);
  });

  it("marks the steps once the host opens the hand-off, before the person answers", async () => {
    const journal = await Effect.runPromise(makeEffectJournal);
    const atOpen: unknown[] = [];
    const scriptInput = makeScriptInput(review, (_request, opened) =>
      Effect.gen(function* () {
        atOpen.push(yield* journal.commits);
        opened();
        atOpen.push(yield* journal.commits);
        return { review: { done: true } };
      }),
    );
    await run(
      executeKernelOperation(write("review"), {}, { kernel: answeringKernel, sessionId: "s" }).pipe(
        Effect.provideService(ScriptInput, scriptInput),
      ),
      Effect.succeed(journal),
    );
    expect(atOpen).toEqual([
      [
        { name: "save-address", state: "confirmed" },
        { name: "place-order", state: "not_sent" },
      ],
      [
        { name: "save-address", state: "confirmed" },
        { name: "place-order", state: "sent" },
      ],
    ]);
  });

  it("marks nothing when the host refuses the hand-off before it opens", async () => {
    const journal = await Effect.runPromise(makeEffectJournal);
    const scriptInput = makeScriptInput(review, () =>
      Effect.fail(new ScriptInputFailure({ code: "Unavailable" })),
    );
    const refused = await run(
      executeKernelOperation(write("review"), {}, { kernel: answeringKernel, sessionId: "s" }).pipe(
        Effect.provideService(ScriptInput, scriptInput),
      ),
      Effect.succeed(journal),
    );
    expect(failureOf(refused.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "ScriptInputFailure", code: "Unavailable" })),
    );
    expect(await Effect.runPromise(journal.commits)).toContainEqual({
      name: "place-order",
      state: "not_sent",
    });
  });

  it("keeps a write with no declared steps confirmed when it hands off after confirming", async () => {
    const journal = await Effect.runPromise(makeEffectJournal);
    const operation = defineOperation(
      {
        input: Schema.Struct({}),
        output: Schema.String,
        questions: review,
        write: { confirmation: "readback" },
      },
      async ({ handOff, verified }) => {
        verified();
        await handOff("review");
        return "done";
      },
    );
    const handed = await run(
      executeKernelOperation(operation, {}, { kernel: answeringKernel, sessionId: "s" }).pipe(
        Effect.provideService(
          ScriptInput,
          makeScriptInput(review, () => Effect.succeed({ review: { done: true } })),
        ),
      ),
      Effect.succeed(journal),
    );
    expect(handed.websiteEffect).toBe("verified");
    expect(await Effect.runPromise(journal.confirmation)).toBe("readback");
  });

  it("leaves a step maintenance settled as it is", async () => {
    const handed = await attempt(
      "review",
      makeEffectJournalWith({ settledCommits: ["place-order"] }),
    );
    expect(handed.commits).toContainEqual({ name: "place-order", state: "not_sent" });
  });

  it("refuses an id that is not a declared hand-off as Undeclared, asking nobody", async () => {
    const refused = await attempt("note");
    expect(failureOf(refused.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "ScriptInputFailure", code: "Undeclared" })),
    );
    expect(refused.asked).toEqual([]);
    expect(refused.commits).toContainEqual({ name: "place-order", state: "not_sent" });
  });
});
