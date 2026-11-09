import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A write whose commit went out and the site's own answer said no, in the local operation child:
// the script puts its step back with `{ siteRefused: true }` and ends with the site's words, so its
// caller reads the write not applied with that reason, never a possible change.

const entrypoint = "operation/src/tool.mjs";
const header = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
const write = { confirmation: "readback", commits: ["add-to-cart"] };
const io = { input: Schema.Struct({ item: Schema.String }), output: Schema.Struct({ quantity: Schema.Number }), write };`;
/** A synthetic cart add whose commit response names the site's refusal and returns no line. */
const refusedResponse = `${header}
export default defineOperation(io, async ({ kernel, sessionId, enteringCommit, notCommitted, verified, errors }) => {
  enteringCommit("add-to-cart");
  const answer = (await kernel.browsers.playwright.execute(sessionId, { code: "return add();" })).result;
  if (typeof answer.refused === "string") {
    notCommitted("add-to-cart", { siteRefused: true });
    throw new errors.InvalidInput(answer.refused);
  }
  verified();
  return { quantity: answer.quantity };
});`;
/**
 * A synthetic cart add that reads its line before the mark, sends a quantity that differs from it,
 * gets an error answer that is not a server error, reads the same view again, finds the line as it
 * was, and puts the step back when `putBack` says so.
 */
const unchangedReadBack = (putBack: boolean) => `${header}
export default defineOperation(io, async ({ kernel, sessionId, enteringCommit, notCommitted, verified, errors }) => {
  const read = async () => (await kernel.browsers.playwright.execute(sessionId, { code: "return readLine();" })).result;
  const before = await read();
  enteringCommit("add-to-cart");
  const answer = (await kernel.browsers.playwright.execute(sessionId, { code: "return add(" + (before.quantity + 1) + ");" })).result;
  const after = await read();
  if (answer.status >= 400 && answer.status < 500 && after.quantity === before.quantity) {
    ${putBack ? 'notCommitted("add-to-cart", { siteRefused: true });' : ""}
    throw new errors.InvalidInput(after.notice);
  }
  verified();
  return { quantity: after.quantity };
});`;
/** A site whose add answers `added` and whose cart line reads quantity 1 with its own notice. */
const site = (added: unknown) => ({
  sessionId: "local",
  executeResponse: (code: string) =>
    Effect.succeed({
      success: true,
      result: code.includes("readLine")
        ? { quantity: 1, notice: "Only 1 left in stock" }
        : added,
    }),
});
const outcomeOf = (source: string, browser: ReturnType<typeof site>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: { item: "example-item" },
          browser,
        }).pipe(Effect.flip, Effect.map(runOutcomeFailure("write", "operation")));
      }),
    ),
  );

it("reports a write not applied when its commit response refused it and the script put the step back", async () => {
  const failure = await outcomeOf(refusedResponse, site({ refused: "Limit 1 per customer" }));
  expect(failure.outcome).toMatchObject({
    code: "input_rejected",
    writeStatus: "not_applied",
    possibleCommit: false,
    details: { possible_commit: false, reason: "Limit 1 per customer" },
  });
});

it("reports a write not applied when its record read back unchanged after an error answer and the script put the step back", async () => {
  const failure = await outcomeOf(unchangedReadBack(true), site({ status: 422 }));
  expect(failure.outcome).toMatchObject({
    code: "input_rejected",
    writeStatus: "not_applied",
    possibleCommit: false,
    details: { possible_commit: false, reason: "Only 1 left in stock" },
  });
});

// The put-back decides: the same refusal thrown with the step still sent may have changed the site.
it("keeps the same refusal a possible change when the script left the step sent", async () => {
  const failure = await outcomeOf(unchangedReadBack(false), site({ status: 422 }));
  expect(failure.outcome).toMatchObject({
    code: "input_rejected",
    writeStatus: "may_have_applied",
    possibleCommit: true,
  });
});
