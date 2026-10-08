import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
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
