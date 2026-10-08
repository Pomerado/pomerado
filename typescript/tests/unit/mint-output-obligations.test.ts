import { Effect, JSONSchema, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type PublicationDecision } from "../../src/mint/contracts.js";
import { weakenedOutputs } from "../../src/mint/output-obligations.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

const json = <A, I>(schema: Schema.Schema<A, I>) => JSONSchema.make(schema);

const Price = Schema.Struct({ amount: Schema.Int, currency: Schema.NonEmptyString });
const registered = json(
  Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literal("open", "closed"),
    price: Price,
    items: Schema.Array(Schema.Struct({ sku: Schema.String, price: Price })),
    note: Schema.optional(Schema.String),
  }),
);

it.each([
  {
    case: "the same schema",
    repaired: registered,
    exempt: [],
    expected: [],
  },
  {
    case: "a nested field made nullable",
    repaired: json(
      Schema.Struct({
        id: Schema.NonEmptyString,
        status: Schema.Literal("open", "closed"),
        price: Schema.Struct({ amount: Schema.NullOr(Schema.Int), currency: Schema.NonEmptyString }),
        items: Schema.Array(Schema.Struct({ sku: Schema.String, price: Price })),
        note: Schema.optional(Schema.String),
      }),
    ),
    exempt: [],
    expected: [{ field: "price.amount", change: "nullable" }],
  },
  {
    case: "a field removed, another made optional, inside array items",
    repaired: json(
      Schema.Struct({
        id: Schema.NonEmptyString,
        status: Schema.Literal("open", "closed"),
        price: Price,
        items: Schema.Array(
          Schema.Struct({
            sku: Schema.optional(Schema.String),
            price: Schema.Struct({ amount: Schema.Int }),
          }),
        ),
        note: Schema.optional(Schema.String),
      }),
    ),
    exempt: [],
    expected: [
      { field: "items[].sku", change: "optional" },
      { field: "items[].price.currency", change: "removed" },
    ],
  },
  {
    case: "a type, an enum value and a length bound widened",
    repaired: json(
      Schema.Struct({
        id: Schema.String,
        status: Schema.Literal("open", "closed", "unknown"),
        price: Schema.Struct({ amount: Schema.Number, currency: Schema.NonEmptyString }),
        items: Schema.Array(Schema.Struct({ sku: Schema.String, price: Price })),
        note: Schema.optional(Schema.String),
      }),
    ),
    exempt: [],
    expected: [
      { field: "id", change: "widened" },
      { field: "status", change: "widened" },
      { field: "price.amount", change: "widened" },
    ],
  },
  {
    case: "tightening and a new optional field",
    repaired: json(
      Schema.Struct({
        id: Schema.NonEmptyString.pipe(Schema.maxLength(40)),
        status: Schema.Literal("open"),
        price: Price,
        items: Schema.NonEmptyArray(Schema.Struct({ sku: Schema.NonEmptyString, price: Price })),
        note: Schema.String,
        url: Schema.optional(Schema.String),
      }),
    ),
    exempt: [],
    expected: [],
  },
  {
    case: "loosenings an applied output change names, with what is under it",
    repaired: json(
      Schema.Struct({
        id: Schema.NonEmptyString,
        status: Schema.Literal("open", "closed"),
        price: Schema.optional(Schema.Struct({ amount: Schema.NullOr(Schema.Int) })),
        items: Schema.Array(Schema.Struct({ sku: Schema.String })),
        note: Schema.optional(Schema.String),
      }),
    ),
    exempt: ["price"],
    expected: [{ field: "items[].price", change: "removed" }],
  },
  {
    case: "an unconstrained replacement",
    repaired: json(Schema.Struct({ id: Schema.Unknown })),
    exempt: [],
    expected: [
      { field: "id", change: "widened" },
      { field: "status", change: "removed" },
      { field: "price", change: "removed" },
      { field: "items", change: "removed" },
      { field: "note", change: "removed" },
    ],
  },
])("finds $case", ({ repaired, exempt, expected }) => {
  expect(weakenedOutputs(registered, repaired, exempt)).toEqual(expected);
});

it.each([
  {
    case: "a type array that admits null",
    registered: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    repaired: { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"] },
    expected: [{ field: "a", change: "nullable" }],
  },
  {
    case: "a reference into $defs, resolved on each side",
    registered: {
      $defs: { Price: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] } },
      type: "object",
      properties: { price: { $ref: "#/$defs/Price" } },
      required: ["price"],
    },
    repaired: {
      definitions: { P: { type: "object", properties: { amount: { type: "integer" } } } },
      type: "object",
      properties: { price: { $ref: "#/definitions/P" } },
      required: ["price"],
    },
    expected: [{ field: "price.amount", change: "optional" }],
  },
  {
    case: "an integer narrowed from a number, a pattern kept",
    registered: { type: "object", properties: { n: { type: "number" }, code: { type: "string", pattern: "^[A-Z]{3}$" } } },
    repaired: { type: "object", properties: { n: { type: "integer" }, code: { type: "string", pattern: "^[A-Z]{3}$" } } },
    expected: [],
  },
  {
    case: "a dropped pattern and a lowered minItems",
    registered: {
      type: "object",
      properties: { code: { type: "string", pattern: "^[A-Z]{3}$" }, tags: { type: "array", items: { type: "string" }, minItems: 2 } },
    },
    repaired: {
      type: "object",
      properties: { code: { type: "string" }, tags: { type: "array", items: { type: "string" }, minItems: 1 } },
    },
    expected: [
      { field: "code", change: "widened" },
      { field: "tags", change: "widened" },
    ],
  },
  {
    case: "a nullable root, and an unconstrained registered field",
    registered: { type: "object", properties: { extra: {} } },
    repaired: { anyOf: [{ type: "object", properties: { extra: { type: "string" } } }, { type: "null" }] },
    expected: [{ field: "output", change: "nullable" }],
  },
  {
    case: "a const replaced by an open string",
    registered: { type: "object", properties: { kind: { const: "invoice" } }, required: ["kind"] },
    repaired: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
    expected: [{ field: "kind", change: "widened" }],
  },
  {
    case: "a root array's items",
    registered: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    repaired: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
    expected: [{ field: "[].id", change: "optional" }],
  },
])("handles $case", ({ registered: before, repaired, expected }) => {
  expect(weakenedOutputs(before, repaired)).toEqual(expected);
});

// The host's publication refuses a loosening repair before any review. The minter reads each
// field and its change as data, the build goes on, and publishing the fixed repair succeeds.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const repair = {
  mode: "maintenance",
  intent: "Read an order with its price",
  businessInput: { order: "A-1" },
  observations: [],
};
const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "order", description: "Read an order with its price" },
  coverage: "One example ran.",
};

it("hands a repair that loosens its output contract each field and change, and publishes once it is fixed", async () => {
  const weakened = [
    { field: "price.amount", change: "nullable" as const },
    { field: "currency", change: "removed" as const },
  ];
  const recorded: PublicationDecision[] = [];
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        yield* turn.actions.finish(publication);
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: () =>
        publishes++ === 0
          ? Effect.fail(
              new MintFailure({
                code: "PublicationUnavailable",
                reason: "output_obligation_weakened",
                weakenedOutputs: weakened,
              }),
            )
          : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
    },
  );
  const outcome = await f.run();
  expect(answers[0]).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "output_obligation_weakened",
    weakenedOutputs: weakened,
    userInputRequired: false,
  });
  expect(answers[0]).not.toHaveProperty("retryable");
  expect(recorded[0]).toMatchObject({
    reason: "output_obligation_weakened",
    recovery: "correct_source",
  });
  // Not a review and not an outage: the same receipt publishes on the next call.
  expect(publishes).toBe(2);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});
