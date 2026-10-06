import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";
import {
  ExecutionContext,
  makeEffectJournal,
  makeEffectJournalWith,
} from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import {
  executeKernelOperation,
  isKernelOperation,
  kernelTimeoutSec,
  offlineKernel,
} from "../../src/runtime/kernel-operation.js";
import { CaptureUnavailable } from "../../src/runtime/errors.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { ScriptInput, makeScriptInput } from "../../src/runtime/script-input.js";
import type { ScriptQuestionHandler } from "../../src/runtime/script-input.js";

import type { BrowserExecuteResponse } from "../../src/runtime/browser-execution.js";
import type { DialogDecider, KernelExecuteClient } from "../../src/runtime/kernel-operation.js";

/** Scripted answers through the portable execution port, without provider HTTP. */
const fakeKernel = (answer: (code: string) => BrowserExecuteResponse) => {
  const requests: { readonly body: { readonly code: string; readonly timeout_sec?: number } }[] =
    [];
  const client: KernelExecuteClient = {
    browsers: {
      playwright: {
        execute: async (_sessionId, body) => {
          requests.push({ body });
          return answer(body.code);
        },
      },
    },
  };
  return { client, requests };
};

const run = async <A, E>(
  program: Effect.Effect<A, E, ExecutionContext | Scope.Scope>,
  deadline = Deadline.after(60_000),
  journalOf = makeEffectJournal,
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

describe("Kernel script capture", () => {
  it("returns the script's result and records a gap when capture cannot finish", async () => {
    const events: { readonly name: string; readonly details: unknown }[] = [];
    const journal = await Effect.runPromise(makeEffectJournal);
    const operation = defineOperation(
      { input: Schema.Struct({}), output: Schema.Struct({ title: Schema.String }) },
      async () => ({ title: "Example Domain" }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        executeKernelOperation(
          operation,
          {},
          { kernel: offlineKernel, sessionId: "session-1" },
        ).pipe(
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
});

describe("Kernel script", () => {
  const script = defineOperation(
    {
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.Struct({ title: Schema.String }),
    },
    async ({ kernel, sessionId, input, errors }) => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 60,
        code: `await page.goto("https://example.com/?q=" + ${JSON.stringify(encodeURIComponent(input.query))});
return { title: await page.title() };`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return Schema.decodeUnknownSync(Schema.Struct({ title: Schema.String }))(answer.result);
    },
  );

  // Maintenance settles the steps the original run sent or confirmed: entering one fails before
  // its execute call, and the steps still unsent enter as usual.
  it("refuses a commit step the original already sent, before its execute call", async () => {
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
      const kernel = fakeKernel(() => ({ success: true, result: 1 }));
      const journal = await Effect.runPromise(
        makeEffectJournalWith({ settledCommits: ["save-address", "confirm-terms"] }),
      );
      const outcome = await run(
        executeKernelOperation(write(step), {}, { kernel: kernel.client, sessionId: "s" }),
        Deadline.after(60_000),
        Effect.succeed(journal),
      );
      return {
        ...outcome,
        calls: kernel.requests.length,
        commits: await Effect.runPromise(journal.commits),
      };
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

  it("reports a write verified only when the script marks its read-back last", async () => {
    const write = (calls: "mark" | "mark_then_call" | "none") =>
      defineOperation(
        { input: Schema.Struct({}), output: Schema.String },
        async ({ kernel, sessionId, verified }) => {
          await kernel.browsers.playwright.execute(sessionId, {
            code: "return 1;",
            timeout_sec: 10,
          });
          if (calls !== "none") verified();
          if (calls === "mark_then_call")
            await kernel.browsers.playwright.execute(sessionId, {
              code: "return 2;",
              timeout_sec: 10,
            });
          return "saved";
        },
      );
    const effect = async (calls: "mark" | "mark_then_call" | "none", offline = false) => {
      const kernel = fakeKernel(() => ({ success: true, result: null }));
      const { exit, websiteEffect } = await run(
        executeKernelOperation(
          write(calls),
          {},
          {
            kernel: kernel.client,
            sessionId: "session-1",
            ...(offline ? { offline: true } : {}),
          },
        ),
      );
      expect(exit).toEqual(Exit.succeed("saved"));
      return websiteEffect;
    };
    expect(await effect("mark")).toBe("verified");
    expect(await effect("none")).toBe("may_have_dispatched");
    // A call after the mark may have written again.
    expect(await effect("mark_then_call")).toBe("may_have_dispatched");
    // An offline run cannot reach a site, so its mark changes nothing.
    expect(await effect("mark", true)).toBe("not_started");
  });

  it("reports a failed call as the script's typed failure", async () => {
    const stderr = "Error: locator not found\n    at call (kernel-call.js:2:7)";
    const kernel = fakeKernel(() => ({ success: false, error: "locator not found", stderr }));
    const { exit } = await run(
      executeKernelOperation(
        script,
        { query: "x" },
        {
          kernel: kernel.client,
          sessionId: "session-1",
        },
      ),
    );
    expect(failureOf(exit)).toMatchObject(
      Option.some({
        _tag: "OperationFailure",
        message: "locator not found",
        dispatch: "unknown",
        // Kernel's stack for the call reaches the failure detail as its cause.
        cause: { name: "KernelCallStack", stack: stderr },
      }),
    );
  });

  it("waits past a challenge in one runtime call and fails with the time it waited", async () => {
    const waiting = defineOperation(
      { input: Schema.Struct({}), output: Schema.Null },
      async ({ waitPastChallenge }) => {
        await waitPastChallenge({ ready: "return await page.getByRole('button').isVisible();" });
        return null;
      },
    );
    const kernel = fakeKernel(() => ({
      success: true,
      result: { cleared: false, waitedMs: 30_004 },
    }));
    const { exit } = await run(
      executeKernelOperation(
        waiting,
        {},
        {
          kernel: kernel.client,
          sessionId: "session-1",
        },
      ),
    );
    expect(failureOf(exit)).toMatchObject(
      Option.some({ _tag: "ChallengeFailure", code: "Unavailable", solverWaitMs: 30_004 }),
    );
    expect(kernel.requests).toHaveLength(1);
    expect(kernel.requests[0]?.body.code).toContain("getByRole('button')");
    expect(kernel.requests[0]?.body.timeout_sec).toBe(40);
  });

  it("is how the runner tells a Kernel script from an Effect operation", () => {
    expect(isKernelOperation(script)).toBe(true);
    expect(
      isKernelOperation(
        defineOperation({
          name: "effect",
          input: Schema.Struct({}),
          output: Schema.Null,
          run: () => Effect.succeed(null),
        }),
      ),
    ).toBe(false);
  });

  it("gives each call whole seconds, at most 300 and at most the time left", () => {
    expect([1, 999, 4_500, 299_999, 300_000, 1_200_000].map(kernelTimeoutSec)).toEqual([
      1, 1, 4, 299, 300, 300,
    ]);
  });

  // A tool published while identity checks existed still ships login hooks. It loads, and the
  // host never calls them: Kernel managed login signs in before the script runs.
  it("runs an old tool's script without calling the login hooks it ships", async () => {
    const seen: string[] = [];
    const kernel = fakeKernel((code) => {
      seen.push(code);
      return { success: true, result: "ada" };
    });
    let hookCalls = 0;
    const published = {
      input: Schema.Struct({}),
      output: Schema.String,
      websiteAuth: {
        identity: async () => {
          hookCalls++;
          return "mismatch" as const;
        },
        login: async () => {
          hookCalls++;
        },
      },
    };
    const { exit } = await run(
      executeKernelOperation(
        defineOperation(published, async () => "account page"),
        {},
        {
          kernel: kernel.client,
          sessionId: "session-1",
          siteOrigin: "https://shop.example.test",
        },
      ),
    );
    expect(exit).toEqual(Exit.succeed("account page"));
    expect(hookCalls).toBe(0);
    expect(seen).toEqual([]);
  });

  it("runs an offline script without a browser, and a call it makes fails unsent", async () => {
    const parser = defineOperation(
      { input: Schema.Struct({ text: Schema.String }), output: Schema.Number },
      async ({ input }) => input.text.length,
    );
    const parsed = await run(
      executeKernelOperation(
        parser,
        { text: "abc" },
        {
          kernel: offlineKernel,
          sessionId: "offline",
          offline: true,
        },
      ),
    );
    expect(parsed).toEqual({ exit: Exit.succeed(3), websiteEffect: "not_started" });
    const calling = await run(
      executeKernelOperation(
        script,
        { query: "x" },
        {
          kernel: offlineKernel,
          sessionId: "offline",
          offline: true,
        },
      ),
    );
    expect(failureOf(calling.exit)).toMatchObject(
      Option.some({ _tag: "OperationFailure", dispatch: "not_sent" }),
    );
  });

  it("sends the SDK a whole-millisecond request timeout when little time is left", async () => {
    const waiting = defineOperation(
      { input: Schema.Struct({}), output: Schema.Null },
      async ({ waitPastChallenge }) => {
        await waitPastChallenge({ ready: "return true;" });
        return null;
      },
    );
    const kernel = fakeKernel(() => ({ success: true, result: { cleared: true, waitedMs: 5 } }));
    const { exit } = await run(
      executeKernelOperation(
        waiting,
        {},
        {
          kernel: kernel.client,
          sessionId: "session-1",
        },
      ),
      Deadline.after(12_345.5, () => 0),
    );
    expect(exit).toEqual(Exit.succeed(null));
    expect(kernel.requests[0]?.body.code).toContain(">= 12345)");
  });
});

it.each([
  [false, "TimeoutError: locator.waitFor: Timeout 5000ms exceeded", "BrowserActionTimeout"],
  [false, "unrelated script timeout", "OperationFailure"],
  [true, "TimeoutError: locator.waitFor: Timeout 5000ms exceeded", "OperationFailure"],
] as const)(
  "attributes native action timeout only to failed Kernel responses (%s, %s)",
  async (success, error, tag) => {
    const kernel = fakeKernel(() => ({ success, error, result: null, stderr: error }));
    const operation = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      async ({ kernel, sessionId, errors }) => {
        const answer = await kernel.browsers.playwright.execute(sessionId, {
          code: "await page.locator('#absent').waitFor();",
          timeout_sec: 10,
        });
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      },
    );
    const { exit } = await run(
      executeKernelOperation(operation, {}, { kernel: kernel.client, sessionId: "session-1" }),
    );
    expect(failureOf(exit)).toMatchObject({ _tag: "Some", value: { _tag: tag } });
  },
);

it("does not retain a handled Kernel timeout after a later successful call", async () => {
  const timeout = "TimeoutError: locator.waitFor: Timeout 5000ms exceeded";
  const kernel = fakeKernel((code) =>
    code === "first" ? { success: false, error: timeout } : { success: true, result: null },
  );
  const operation = defineOperation(
    { input: Schema.Struct({}), output: Schema.String },
    async ({ kernel, sessionId, errors }) => {
      await kernel.browsers.playwright.execute(sessionId, { code: "first", timeout_sec: 10 });
      await kernel.browsers.playwright.execute(sessionId, { code: "second", timeout_sec: 10 });
      throw new errors.OperationFailure(timeout);
    },
  );
  const { exit } = await run(
    executeKernelOperation(operation, {}, { kernel: kernel.client, sessionId: "session-1" }),
  );
  expect(failureOf(exit)).toMatchObject({ _tag: "Some", value: { _tag: "OperationFailure" } });
});

it.each([
  {
    name: "an empty selector",
    selector: "",
    answer: { success: true, result: true },
  },
  {
    name: "a nonboolean observation",
    selector: "#rejected",
    answer: { success: true, result: "yes" },
  },
  {
    name: "a failed page inspection",
    selector: "#rejected",
    answer: {
      success: false,
      error: "page unavailable",
      stderr: "Error: inspection unavailable\n    at locator",
    },
  },
])(
  "keeps $name as an operation failure rather than credential rejection",
  async ({ selector, answer }) => {
    const kernel = fakeKernel(() => answer);
    const operation = defineOperation(
      { input: Schema.Struct({}), output: Schema.Struct({}) },
      async ({ rejectedSignIn }) => {
        await rejectedSignIn({ field: "password", selector });
        return {};
      },
    );
    const { exit } = await run(
      executeKernelOperation(
        operation,
        {},
        {
          kernel: kernel.client,
          sessionId: "session-1",
        },
      ),
    );
    expect(failureOf(exit)).toMatchObject({
      _tag: "Some",
      value: { _tag: "OperationFailure" },
    });
  },
);

it("retains a provider exception as the marker inspection failure's cause", async () => {
  const operation = defineOperation(
    { input: Schema.Struct({}), output: Schema.Struct({}) },
    async ({ rejectedSignIn }) => {
      await rejectedSignIn({ field: "password", selector: "#rejected" });
      return {};
    },
  );
  const cause = new Error("synthetic provider disconnected");
  const { exit } = await run(
    executeKernelOperation(
      operation,
      {},
      {
        kernel: {
          browsers: {
            playwright: {
              execute: () => {
                throw cause;
              },
            },
          },
        },
        sessionId: "session-1",
      },
    ),
  );
  expect(failureOf(exit)).toMatchObject({
    _tag: "Some",
    value: {
      _tag: "OperationFailure",
      cause,
    },
  });
});

describe("host pauses across calls", () => {
  /**
   * A fake site behind the execute port: a sign-in form that asks for a one-time code, and a
   * delete button that raises a confirm. `steps` records each call and each host pause in order.
   */
  const fakeSite = () => {
    const steps: string[] = [];
    const site = { signIns: 0, code: "", deletes: 0, dialog: "none" };
    const act = (code: string): unknown => {
      if (code.includes('page.click("#sign-in")')) {
        site.signIns += 1;
        return { needsCode: true };
      }
      if (code.includes('page.fill("#otp"')) {
        site.code = /page\.fill\("#otp", "(\w+)"\)/u.exec(code)?.[1] ?? "";
        return { signedIn: true };
      }
      if (code.includes('page.click("#delete")')) {
        site.deletes += 1;
        site.dialog = "open";
        return {
          type: "confirm",
          message: "Delete invoice 42?",
          url: "https://billing.example.com/invoices/42",
        };
      }
      if (code.includes("globalThis.dialog.accept()") && site.dialog === "open") {
        site.dialog = "accepted";
        return { deleted: true };
      }
      return undefined;
    };
    const { client } = fakeKernel((code) => {
      steps.push("execute");
      const result = act(code);
      return { success: result !== undefined, result };
    });
    return { client, steps, site };
  };

  const codeQuestion = {
    code: { type: "secret", secretKind: "one_time_code", prompt: "The code the site sent?" },
  } as const;

  /** Signs in with a code the caller supplies, then deletes an invoice behind a confirm dialog. */
  const script = defineOperation(
    {
      input: Schema.Struct({}),
      output: Schema.Struct({ deleted: Schema.Boolean, remainingMs: Schema.Number }),
      questions: codeQuestion,
    },
    async ({ kernel, sessionId, ask, decideDialog, remainingMs }) => {
      const call = async (code: string) => {
        const answer = await kernel.browsers.playwright.execute(sessionId, {
          timeout_sec: 60,
          code,
        });
        if (!answer.success) throw new Error(`Call failed: ${String(answer.error)}`);
        return answer.result;
      };
      await call('await page.fill("#user", "synthetic-user"); await page.click("#sign-in");');
      const code = await ask("code");
      await call(`await page.fill("#otp", ${JSON.stringify(code)}); await page.click("#go");`);
      const shown = Schema.decodeUnknownSync(
        Schema.Struct({
          type: Schema.Literal("confirm"),
          message: Schema.String,
          url: Schema.String,
        }),
      )(
        await call(`const shown = new Promise((resolve) => page.once("dialog", (dialog) => {
  globalThis.dialog = dialog;
  resolve({ type: dialog.type(), message: dialog.message(), url: page.url() });
}));
void page.click("#delete").catch(() => {});
return await shown;`),
      );
      const decision = await decideDialog({ step: "delete-invoice", ...shown });
      if (decision.choice !== "accept") return { deleted: false, remainingMs: remainingMs() };
      const done = Schema.decodeUnknownSync(Schema.Struct({ deleted: Schema.Boolean }))(
        await call("await globalThis.dialog.accept(); return { deleted: true };"),
      );
      return { ...done, remainingMs: remainingMs() };
    },
  );

  const runAsking = async <A, E>(
    program: Effect.Effect<A, E, ExecutionContext | Scope.Scope>,
    deadline: Deadline,
    ask: ScriptQuestionHandler,
  ) => {
    const journal = await Effect.runPromise(makeEffectJournal);
    return Effect.runPromiseExit(
      Effect.scoped(
        program.pipe(
          Effect.provideService(ScriptInput, makeScriptInput(codeQuestion, ask, deadline)),
          Effect.provideService(ExecutionContext, {
            deadline,
            journal,
            events: { emit: () => Effect.void },
            capture: { start: Effect.void, finish: Effect.void },
          }),
        ),
      ),
    );
  };

  it("finishes a code login and a host-decided confirm across calls, repeating none", async () => {
    const kernel = fakeSite();
    const decided: unknown[] = [];
    const dialogs: DialogDecider = ({ step, type, message, url }) =>
      Effect.sync(() => {
        kernel.steps.push("dialog");
        decided.push({ step, type, message, url });
        return { choice: "accept" as const };
      });
    const exit = await runAsking(
      executeKernelOperation(script, {}, { kernel: kernel.client, sessionId: "session-1", dialogs }),
      Deadline.after(60_000),
      () =>
        Effect.sync(() => {
          kernel.steps.push("code");
          return { code: "693104" };
        }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(kernel.steps).toEqual(["execute", "code", "execute", "execute", "dialog", "execute"]);
    expect(kernel.site).toEqual({ signIns: 1, code: "693104", deletes: 1, dialog: "accepted" });
    // The host decides on the script's own report: the raising step, the dialog and its page.
    expect(decided).toEqual([
      {
        step: "delete-invoice",
        type: "confirm",
        message: "Delete invoice 42?",
        url: "https://billing.example.com/invoices/42",
      },
    ]);
  });

  it("never counts a host wait against the operation's deadline", async () => {
    let now = 0;
    const deadline = Deadline.after(60_000, () => now);
    const kernel = fakeSite();
    // Each person takes longer than the whole budget to answer.
    const slow = <A>(answer: A) =>
      Effect.sync(() => {
        now += 170_000;
        return answer;
      });
    const exit = await runAsking(
      executeKernelOperation(
        script,
        {},
        {
          kernel: kernel.client,
          sessionId: "session-1",
          dialogs: () => slow({ choice: "accept" as const }),
        },
      ),
      deadline,
      () => slow({ code: "693104" }),
    );
    expect(exit).toEqual(Exit.succeed({ deleted: true, remainingMs: 60_000 }));
  });
});
