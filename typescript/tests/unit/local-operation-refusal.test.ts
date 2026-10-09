import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A script that refuses its caller's value in the local operation child, against a browser that
// answers every call with nothing: what its run outcome tells the caller.

const entrypoint = "operation/src/tool.mjs";
/** A synthetic product read whose page offers one size, so any other size is refused. */
const refusing = (detail: string) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ size: Schema.String }), output: Schema.Struct({ size: Schema.String }) },
  async ({ input, errors }) => {
    if (input.size !== "One Size") throw new errors.InvalidInput("Size " + input.size + " is not offered"${detail});
    return { size: input.size };
  });`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: null }),
};
const outcomeOf = (detail: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, refusing(detail)]],
          input: { size: "M" },
          browser,
        }).pipe(Effect.flip, Effect.map(runOutcomeFailure("read", "operation")));
      }),
    ),
  );

it("tells the caller the choices the page offers when a script refuses a value with them", async () => {
  const failure = await outcomeOf(`, { field: "size", available: ["One Size"] }`);
  expect(failure.outcome).toMatchObject({
    code: "input_rejected",
    retry: "fix_input",
    details: { reason: "Size M is not offered", field: "size", available: ["One Size"] },
  });
  expect(failure.message).toContain("One Size");
});

it("keeps a refusal without choices to its reason", async () => {
  const failure = await outcomeOf("");
  expect(failure.outcome.code).toBe("input_rejected");
  expect(failure.outcome.details).toEqual({ possible_commit: false, reason: "Size M is not offered" });
});
