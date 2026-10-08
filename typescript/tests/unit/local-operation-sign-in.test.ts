import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

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
