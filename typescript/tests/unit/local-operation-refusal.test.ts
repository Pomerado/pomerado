import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { boundedRefusalDetail, operationErrors } from "../../src/runtime/operation-failure.js";
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
/** A synthetic cart line sold by the item, so a part of one is refused with the nearest whole ones. */
const wholeQuantity = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ quantity: Schema.Number }), output: Schema.Struct({ quantity: Schema.Number }) },
  async ({ input, errors }) => {
    if (!Number.isInteger(input.quantity)) throw new errors.InvalidInput("Quantity " + input.quantity + " is not offered", { field: "quantity", available: [Math.floor(input.quantity), Math.ceil(input.quantity)] });
    return { quantity: input.quantity };
  });`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: null }),
};
const run = (source: string, input: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      return yield* runLocalOperation({
        workspace,
        entrypoint,
        sources: [[entrypoint, source]],
        input,
        browser,
      });
    }),
  );
const refusalOf = (source: string, input: unknown) =>
  Effect.runPromise(
    run(source, input).pipe(Effect.flip, Effect.map(runOutcomeFailure("read", "operation"))),
  );
const outcomeOf = (detail: string) => refusalOf(refusing(detail), { size: "M" });

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

// A refusal that names its input with an explicitly empty list says the page offers nothing for
// that input, which a host that repairs can tell from a refusal that lists no choices at all. Only
// a list with no entries counts: one of blank labels, as a list that has not drawn its options
// shows, and a list beside no field stay a refusal without choices.
it.each([
  { name: "an empty list beside its field", detail: { field: "color", available: [] }, kept: [] },
  { name: "no list", detail: { field: "color" }, kept: undefined },
  { name: "an empty list beside no field", detail: { available: [] }, kept: undefined },
  { name: "only blank labels", detail: { field: "color", available: ["", " "] }, kept: undefined },
])("keeps an explicitly empty list only beside its field: $name", ({ detail, kept }) => {
  const refusal = new operationErrors.InvalidInput("Color is not offered", detail);
  expect(refusal.available).toEqual(kept);
});

// A script may list a true/false or number choice as the value itself, so the refusal keeps that
// value, which a caller sends back into the input as it is.
it("keeps a true/false or number choice as its value", () => {
  const refusal = new operationErrors.InvalidInput("Out of stock items are not offered", {
    field: "include_out_of_stock",
    available: [false, 2, null] as never,
  });
  expect(refusal.available).toEqual([false, 2]);
});

it("tells the caller a number choice as the number, which the input takes back as it is", async () => {
  const failure = await refusalOf(wholeQuantity, { quantity: 1.5 });
  expect(failure.outcome.details).toMatchObject({ field: "quantity", available: [1, 2] });
  expect(failure.message).toContain("Available for quantity: 1, 2.");
  const [choice] = failure.outcome.details["available"] as readonly unknown[];
  await expect(Effect.runPromise(run(wholeQuantity, { quantity: choice }))).resolves.toMatchObject({
    output: { quantity: 1 },
  });
});

// A choice taken from the caller's own account, such as a saved address, is marked as a question's
// option is. The refusal keeps it, bounded, for a host to mask; the local host shows its full
// label, as it shows a question's.
it("keeps a choice from the caller's own account marked", () => {
  const refusal = new operationErrors.InvalidInput("No saved address matches", {
    field: "address",
    available: [
      "Pick up in store",
      { label: "12 Example Rd, Springfield 99999", accountSpecific: true, maskedLabel: "Home" },
      { label: "14 Example Rd", accountSpecific: true, maskedLabel: "a".repeat(65) },
    ],
  });
  expect(refusal.available).toEqual([
    "Pick up in store",
    { label: "12 Example Rd, Springfield 99999", accountSpecific: true, maskedLabel: "Home" },
    { label: "14 Example Rd", accountSpecific: true },
  ]);
  // A host that calls it without `fullLabels` still reads each by its mask.
  expect(boundedRefusalDetail(refusal).available).toEqual([
    "Pick up in store",
    "Home",
    "Saved option 3",
  ]);
});

it("tells a local caller a choice from the caller's own account by its full label", async () => {
  const failure = await outcomeOf(
    `, { field: "size", available: ["One Size", { label: "Size 12 Example Rd", accountSpecific: true, maskedLabel: "Saved size" }, { label: "Size 14 Example Rd", accountSpecific: true }] }`,
  );
  expect(failure.outcome.details).toMatchObject({
    available: ["One Size", "Size 12 Example Rd", "Size 14 Example Rd"],
  });
});

// The local host repairs nothing, so its outcome for such a refusal is unchanged: the reason and
// the field, with no list of choices.
it("tells a local caller the reason and field, with no choices, when a script refuses with an empty list", async () => {
  const failure = await outcomeOf(`, { field: "size", available: [] }`);
  expect(failure.outcome.code).toBe("input_rejected");
  expect(failure.outcome.details).toEqual({
    possible_commit: false,
    reason: "Size M is not offered",
    field: "size",
  });
  expect(failure.message).not.toContain("Available");
});
