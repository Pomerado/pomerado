import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, it } from "vitest";
import { canonicalSchema } from "../../src/registry/schema-references.js";
import type { CanonicalSchema } from "../../src/registry/schema-references.js";

// Every surface reads a tool's schema in one canonical form; a run checks the published one. Each
// case's values must validate the same against both.
const valid = (schema: Record<string, unknown>, value: unknown) =>
  new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const standalone = (canonical: CanonicalSchema) =>
  Object.keys(canonical.definitions).length === 0
    ? canonical.schema
    : { ...canonical.schema, $defs: canonical.definitions };
const agrees = (published: Record<string, unknown>, values: readonly unknown[]) => {
  const canonical = canonicalSchema(published);
  if (canonical === undefined) throw new Error("expected a canonical schema");
  for (const value of values)
    expect(valid(standalone(canonical), value), JSON.stringify(value)).toBe(valid(published, value));
  return canonical;
};

it("inlines references that expand, and drops the dialect and definition containers", () => {
  const canonical = agrees(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      $defs: { Code: { type: "string", minLength: 3 } },
      definitions: { Count: { type: "integer" } },
      properties: {
        code: { $ref: "#/$defs/Code" },
        count: { $ref: "#/definitions/Count" },
        copy: { $ref: "#/properties/code" },
      },
    },
    [
      { code: "abc", count: 2, copy: "xyz" },
      { code: "a", count: "2", copy: 1 },
    ],
  );
  expect(canonical).toEqual({
    schema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 3 },
        count: { type: "integer" },
        copy: { type: "string", minLength: 3 },
      },
    },
    definitions: {},
  });
});

it("keeps a recursive schema's references, each pointing at a root definition", () => {
  const tree = {
    type: "object",
    required: ["label"],
    properties: {
      label: { type: "string" },
      children: { type: "array", items: { $ref: "#" } },
    },
  };
  const values = [
    { label: "a", children: [{ label: "b", children: [] }] },
    { label: "a", children: [{ label: 2 }] },
  ];
  const root = agrees(tree, values);
  expect(root.schema).toMatchObject({
    properties: { children: { items: { $ref: "#/$defs/Root" } } },
  });
  expect(root.definitions["Root"]).toEqual(root.schema);

  const draft7 = agrees(
    {
      type: "object",
      definitions: {
        Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } },
      },
      properties: { head: { $ref: "#/definitions/Node" } },
    },
    [{ head: { next: { next: {} } } }, { head: { next: 3 } }],
  );
  expect(draft7).toEqual({
    schema: { type: "object", properties: { head: { $ref: "#/$defs/Node" } } },
    definitions: {
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    },
  });
});

it("names definitions apart when two containers share a name, and reads escaped pointers", () => {
  const canonical = agrees(
    {
      type: "object",
      $defs: { Item: { type: "object", properties: { more: { $ref: "#/$defs/Item" } } } },
      definitions: { Item: { type: "string" } },
      properties: {
        recursive: { $ref: "#/$defs/Item" },
        named: { $ref: "#/definitions/Item" },
        escaped: { $ref: "#/properties/a~1b%20c" },
        "a/b c": { type: "boolean" },
      },
    },
    [
      { recursive: { more: {} }, named: "x", escaped: true },
      { named: 1, escaped: "no" },
    ],
  );
  // A schema that recurses anywhere keeps all its references.
  expect(canonical.schema).toMatchObject({
    properties: {
      recursive: { $ref: "#/$defs/Item" },
      named: { $ref: "#/$defs/Item_2" },
      escaped: { $ref: "#/$defs/a_b_c" },
    },
  });
  expect(canonical.definitions).toMatchObject({
    Item_2: { type: "string" },
    a_b_c: { type: "boolean" },
  });
});

it("leaves data and property names alone", () => {
  const canonical = canonicalSchema({
    type: "object",
    properties: {
      definitions: { type: "string", examples: [{ $ref: "#/nowhere" }] },
      $ref: { const: { $ref: "#/nowhere" } },
    },
  });
  expect(canonical).toEqual({
    schema: {
      type: "object",
      properties: {
        definitions: { type: "string", examples: [{ $ref: "#/nowhere" }] },
        $ref: { const: { $ref: "#/nowhere" } },
      },
    },
    definitions: {},
  });
});

it("has no canonical form for a reference that names nothing in the schema", () => {
  for (const reference of [
    "#/$defs/Missing",
    "#/properties/missing",
    "https://schemas.example.invalid/item.json",
    "#anchor",
    "#/$defs/Item%zz",
    "#/$defs/%FF",
  ])
    expect(
      canonicalSchema({ type: "object", properties: { item: { $ref: reference } } }),
      reference,
    ).toBeUndefined();
  // A definition nested below the root is not where a root reference resolves.
  expect(
    canonicalSchema({
      type: "object",
      properties: {
        nested: {
          $defs: { Choice: { type: "string" } },
          properties: { choice: { $ref: "#/$defs/Choice" } },
        },
      },
    }),
  ).toBeUndefined();
});
