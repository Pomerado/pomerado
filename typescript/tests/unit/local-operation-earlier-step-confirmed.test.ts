import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { returnedRun } from "../../src/standalone/run-report.js";

// A synthetic order write in two commit steps, a saved preview and the placed order, run in the
// local operation child. Its confirmation counts only for the step that ran last: a run that
// confirmed the preview and never placed the order did not finish its write.

const entrypoint = "operation/src/tool.mjs";
const ordering = (places: boolean) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ order: Schema.String }),
    write: { confirmation: "message", commits: ["save-preview", "place-order"] },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    enteringCommit("save-preview");
    await kernel.browsers.playwright.execute(sessionId, { code: "return preview();" });
    ${places ? 'enteringCommit("place-order"); await kernel.browsers.playwright.execute(sessionId, { code: "return place();" });' : ""}
    verified({ confirmation: "message" });
    return { order: "1001" };
  },
);`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: {} }),
};
const run = (places: boolean) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, ordering(places)]],
          input: {},
          browser,
        });
      }),
    ),
  );

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("a write's confirmation", { timeout: 30_000 }, () => {
  it("never counts a confirmed preview as the placed order", async () => {
    const result = await run(false);
    expect(result.commits).toEqual([
      { name: "save-preview", state: "confirmed" },
      { name: "place-order", state: "not_sent" },
    ]);
    const settled = Effect.runSync(Effect.either(returnedRun("write", result)));
    expect(Either.isLeft(settled) && settled.left.outcome).toMatchObject({
      writeStatus: "may_have_applied",
    });
  });

  it("counts the placed order done by its own step's confirmation", async () => {
    const result = await run(true);
    expect(Effect.runSync(Effect.either(returnedRun("write", result)))).toEqual(
      Either.right({ order: "1001" }),
    );
  });
});
