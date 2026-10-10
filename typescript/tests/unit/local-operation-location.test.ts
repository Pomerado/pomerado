import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A script that could not apply its caller's location in the local operation child, against a
// browser that answers every call with nothing: what its run outcome tells the caller.

const entrypoint = "operation/src/tool.mjs";
/** A synthetic store-scoped read whose page kept another store after the caller's ZIP. */
const unapplied = (detail: string) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ zip: Schema.String }), output: Schema.Struct({ store: Schema.String }) },
  async ({ input, errors }) => {
    throw new errors.LocationNotApplied("The page kept its own store after ZIP " + input.zip, ${detail});
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
          sources: [[entrypoint, unapplied(detail)]],
          input: { zip: "00001" },
          browser,
        }).pipe(Effect.flip, Effect.map(runOutcomeFailure("read", "operation")));
      }),
    ),
  );

it("fails loudly with the requested and applied location when a script could not apply it", async () => {
  const failure = await outcomeOf(
    `{ field: "zip", requested: input.zip, applied: "Example Store, 00002", step: "store_save", siteMessage: "Something went wrong. Try again." }`,
  );
  expect(failure.outcome).toMatchObject({
    code: "location_not_applied",
    retry: "same_key",
    possibleCommit: false,
    details: {
      field: "zip",
      requested: "00001",
      applied: "Example Store, 00002",
      step: "store_save",
      site_message: "Something went wrong. Try again.",
    },
  });
  expect(failure.message).toContain("00001");
  expect(failure.message).toContain("Example Store, 00002");
});

it("reports a location the page showed none for without an applied value", async () => {
  const failure = await outcomeOf(`{ field: "zip", requested: input.zip, step: "zip_entry" }`);
  expect(failure.outcome.code).toBe("location_not_applied");
  expect(failure.outcome.details).toEqual({
    possible_commit: false,
    reason: "The page kept its own store after ZIP 00001",
    field: "zip",
    requested: "00001",
    step: "zip_entry",
  });
});
