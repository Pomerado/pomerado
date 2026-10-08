import { Effect } from "effect";
import { expect, it } from "vitest";
import { answerSessionSignIn, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import {
  sessionSignInFillMs,
  type SessionSignInAnswer,
  type SessionSignInHook,
} from "../../src/runtime/session-sign-in.js";

// A script's `ensureSignedIn` in the local operation child, against a browser that answers every
// call with nothing.

const entrypoint = "operation/src/tool.mjs";
/** A script that asks the host to keep its page signed in once, and returns each answer. */
const ensuring = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({ signedInAgain: Schema.Boolean }) },
  async ({ ensureSignedIn }) => ({ signedInAgain: (await ensureSignedIn()).signedInAgain }));`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: null }),
};
const runEnsuring = (options: object = {}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, ensuring]],
          input: {},
          browser,
          ...options,
        }).pipe(Effect.either);
      }),
    ),
  );

it("answers a script's ensureSignedIn that it is still signed in when the host gives no sign-in", async () => {
  const result = await runEnsuring();
  expect(result).toMatchObject({ _tag: "Right", right: { output: { signedInAgain: false } } });
});

/** A host sign-in that records each bound it gets and answers with `answers` in turn. */
const recordingSignIn = (
  answers: readonly SessionSignInAnswer[],
  delaysMs: readonly number[] = [],
) => {
  const bounds: { readonly untilMs: number; readonly stopped: boolean; readonly at: number }[] = [];
  const signIn: SessionSignInHook = (bound) =>
    Effect.gen(function* () {
      bounds.push({ untilMs: bound.untilMs, stopped: bound.stop.aborted, at: Date.now() });
      const delayMs = delaysMs[bounds.length - 1] ?? 0;
      if (delayMs > 0) yield* Effect.sleep(delayMs);
      return answers[bounds.length - 1] ?? { outcome: "signed_in", signedInAgain: false };
    });
  return { signIn, bounds };
};

it("asks the host's sign-in at the runtime's first call and at the script's, within the filling bound", async () => {
  const host = recordingSignIn([
    { outcome: "signed_in", signedInAgain: false },
    { outcome: "signed_in", signedInAgain: true },
  ]);
  const result = await runEnsuring({ signIn: host.signIn });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { signedInAgain: true } } });
  expect(host.bounds).toHaveLength(2);
  for (const bound of host.bounds) {
    expect(bound.stopped).toBe(false);
    expect(bound.untilMs - bound.at).toBeGreaterThan(sessionSignInFillMs - 5_000);
    expect(bound.untilMs - bound.at).toBeLessThanOrEqual(sessionSignInFillMs);
  }
});

it("fails the script as a session the site did not keep when the host refuses, before anything was sent", async () => {
  const host = recordingSignIn([
    { outcome: "signed_in", signedInAgain: false },
    { outcome: "refused", cause: "session_not_kept" },
  ]);
  const result = await runEnsuring({ signIn: host.signIn });
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      name: "LocalOperationFailure",
      tag: "OperationFailure",
      sessionLoss: "session_not_kept",
      journal: { effect: "not_sent", commits: [] },
    },
  });
});

it("pauses the operation's deadline while the host signs in", { timeout: 60_000 }, async () => {
  // The script's sign-in takes longer than the whole operation may.
  const host = recordingSignIn([], [0, 9_000]);
  const result = await runEnsuring({ signIn: host.signIn, timeoutMs: 8_000 });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { signedInAgain: false } } });
  expect(host.bounds).toHaveLength(2);
});

it("binds no sign-in for an operation that cannot reach the browser", async () => {
  const host = recordingSignIn([{ outcome: "signed_in", signedInAgain: true }]);
  const result = await runEnsuring({ signIn: host.signIn, target: "pureFiles" });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { signedInAgain: false } } });
  expect(host.bounds).toEqual([]);
});

/** A host sign-in that notes its bound and its stop, and ends as `ends` says. */
const watchedSignIn = (ends: "never" | "on_stop") => {
  const seen: { untilMs: number; stoppedAt?: number; endedAt?: number } = { untilMs: 0 };
  const signIn: SessionSignInHook = (bound) =>
    Effect.async<SessionSignInAnswer>((resume) => {
      seen.untilMs = bound.untilMs;
      bound.stop.addEventListener("abort", () => {
        seen.stoppedAt = Date.now();
        if (ends === "on_stop") {
          seen.endedAt = Date.now();
          resume(Effect.succeed({ outcome: "signed_in", signedInAgain: true }));
        }
      });
      return Effect.sync(() => {
        seen.endedAt = Date.now();
      });
    });
  return { signIn, seen };
};
/** Short bounds in the shared order: filling, then the answer, then the settle. */
const bounds = { fillMs: 100, answerMs: 300, settleMs: 400 };

it("refuses a sign-in still running at the answer bound, once it stopped it and waited out the settle", async () => {
  const host = watchedSignIn("never");
  const startedAt = Date.now();
  const answer = await Effect.runPromise(answerSessionSignIn(host.signIn, bounds));
  const answeredAt = Date.now();
  expect(answer).toEqual({ outcome: "refused", cause: "session_sign_in_failed" });
  // No step starts after the filling bound.
  expect(host.seen.untilMs - startedAt).toBeLessThanOrEqual(bounds.fillMs + 50);
  // Stopped at the answer bound, it got the settle to end its last step, then was ended.
  expect((host.seen.stoppedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(bounds.answerMs - 5);
  expect((host.seen.endedAt ?? 0) - (host.seen.stoppedAt ?? 0)).toBeGreaterThanOrEqual(
    bounds.settleMs - 5,
  );
  expect(answeredAt).toBeGreaterThanOrEqual(host.seen.endedAt ?? Infinity);
});

it("refuses at the answer bound even when the stopped sign-in then ends signed in, without waiting out the settle", async () => {
  const host = watchedSignIn("on_stop");
  const startedAt = Date.now();
  const answer = await Effect.runPromise(answerSessionSignIn(host.signIn, bounds));
  expect(answer).toEqual({ outcome: "refused", cause: "session_sign_in_failed" });
  expect((host.seen.stoppedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(bounds.answerMs - 5);
  expect(Date.now() - startedAt).toBeLessThan(bounds.answerMs + bounds.settleMs);
});

it("answers a sign-in that ends before the answer bound with its own answer, stopping nothing", async () => {
  const signIn: SessionSignInHook = () =>
    Effect.sleep(50).pipe(Effect.as({ outcome: "signed_in", signedInAgain: true } as const));
  expect(await Effect.runPromise(answerSessionSignIn(signIn, bounds))).toEqual({
    outcome: "signed_in",
    signedInAgain: true,
  });
});
