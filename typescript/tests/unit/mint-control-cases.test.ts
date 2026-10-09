import { describe, expect, it } from "vitest";
import { controlCasePlan, type ControlCase } from "../../src/mint/control-cases.js";

/** A search's input schema, as a tool's contract declares it in JSON Schema. */
const searchInput = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $defs: { Int: { type: "integer", description: "an integer", title: "int" } },
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", examples: ["tent"] },
    sort: {
      type: "string",
      enum: ["relevance", "price_asc", "price_desc"],
      examples: ["relevance"],
    },
    in_stock: { type: "boolean" },
    seats: {
      anyOf: [
        { type: "string", enum: ["any"] },
        { $ref: "#/$defs/Int", minimum: 1 },
      ],
      examples: ["any", 2],
    },
    limit: { $ref: "#/$defs/Int", minimum: 1, maximum: 48, examples: [24] },
    min_price: { type: "number", examples: [20] },
    max_price: { type: "number", examples: [100] },
    color: { type: "string", description: "A colour as the page lists it", examples: ["blue"] },
    cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    check_in: { type: "string", format: "date", examples: ["2026-11-01"] },
    check_out: { type: "string", format: "date", examples: ["2026-11-03"] },
  },
  additionalProperties: false,
};
const searchOutput = {
  type: "object",
  required: ["items", "next_cursor"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "price"],
        properties: { name: { type: "string" }, price: { type: "number" } },
      },
    },
    next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
const now = new Date("2026-10-09T12:00:00Z");
/** The all-together case's key: every optional field but the cursor, dates from the clock. */
const allTogether =
  '{"check_in":"$today+21d","check_out":"$today+23d","color":"blue","in_stock":true,"limit":24,"max_price":100,"min_price":20,"seats":"any","sort":"relevance"}';
const token = "zq-abcdefgh-xv";

const planned = (result: ReturnType<typeof controlCasePlan>) => {
  if (result.status !== "planned") throw new Error(`Not planned: ${JSON.stringify(result)}`);
  return result;
};
const summary = (cases: readonly ControlCase[]) =>
  cases.map(({ key, kind, input, expect: expected }) => ({ key, kind, input, expect: expected }));

describe("controlCasePlan", () => {
  it("covers each control of a search one field at a time, then its bounds, dates, paging and probes", () => {
    const plan = planned(
      controlCasePlan({
        inputSchema: searchInput,
        outputSchema: searchOutput,
        now,
        emptyProbeToken: token,
      }),
    );
    const base = { query: "tent" };
    // Dates start 21 days after the injected clock and keep the examples' two-night gap.
    const dates = { check_in: "2026-10-30", check_out: "2026-11-01" };
    expect(summary(plan.cases)).toEqual([
      { key: "{}", kind: "base", input: base, expect: "result" },
      // A 3-member enum runs every member; the base case leaves the optional field unset.
      { key: '{"sort":"relevance"}', kind: "field", input: { ...base, sort: "relevance" }, expect: "result" },
      { key: '{"sort":"price_asc"}', kind: "field", input: { ...base, sort: "price_asc" }, expect: "result" },
      { key: '{"sort":"price_desc"}', kind: "field", input: { ...base, sort: "price_desc" }, expect: "result" },
      // A boolean runs the value that differs from its default.
      { key: '{"in_stock":true}', kind: "field", input: { ...base, in_stock: true }, expect: "result" },
      // A union runs one case per branch, each from the example that fits it.
      { key: '{"seats":"any"}', kind: "field", input: { ...base, seats: "any" }, expect: "result" },
      { key: '{"seats":2}', kind: "field", input: { ...base, seats: 2 }, expect: "result" },
      // An integer runs its example and its minimum.
      { key: '{"limit":24}', kind: "field", input: { ...base, limit: 24 }, expect: "result" },
      { key: '{"limit":1}', kind: "field", input: { ...base, limit: 1 }, expect: "result" },
      { key: '{"min_price":20}', kind: "field", input: { ...base, min_price: 20 }, expect: "result" },
      { key: '{"max_price":100}', kind: "field", input: { ...base, max_price: 100 }, expect: "result" },
      { key: '{"color":"blue"}', kind: "field", input: { ...base, color: "blue" }, expect: "result" },
      // The limit's maximum, which is at most 50; its minimum already ran.
      { key: '{"limit":48}', kind: "boundary", input: { ...base, limit: 48 }, expect: "result" },
      {
        key: '{"max_price":20,"min_price":100}',
        kind: "inverted_range",
        input: { ...base, min_price: 100, max_price: 20 },
        expect: "refusal_or_empty",
      },
      {
        key: '{"check_in":"$today+21d","check_out":"$today+23d"}',
        kind: "dates",
        input: { ...base, ...dates },
        expect: "result",
      },
      { key: '{"cursor":"$next_page"}', kind: "paging", input: base, expect: "result" },
      {
        key: allTogether,
        kind: "all_together",
        input: {
          ...base,
          sort: "relevance",
          in_stock: true,
          seats: "any",
          limit: 24,
          min_price: 20,
          max_price: 100,
          color: "blue",
          ...dates,
        },
        expect: "result",
      },
      {
        key: '{"query":"$empty_probe"}',
        kind: "empty_probe",
        input: { query: token },
        expect: "empty_or_choices",
      },
      {
        key: '{"color":"__unoffered__"}',
        kind: "unoffered_probe",
        input: { ...base, color: "__unoffered__" },
        expect: "choices",
      },
    ]);
    expect(plan.cases.find((entry) => entry.kind === "paging")?.followUp).toEqual({
      kind: "next_page",
      inputField: "cursor",
      outputField: "next_cursor",
    });
    expect(plan.notChecked).toEqual([]);
  });

  it("moves dates with the clock", () => {
    const later = planned(
      controlCasePlan({
        inputSchema: searchInput,
        now: new Date("2027-02-20T08:00:00Z"),
        emptyProbeToken: token,
      }),
    );
    expect(later.cases.find((entry) => entry.kind === "dates")?.input).toMatchObject({
      check_in: "2027-03-13",
      check_out: "2027-03-15",
    });
  });

  it("refuses a schema whose fields have no examples, naming each one", () => {
    expect(
      controlCasePlan({
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            sort: { type: "string", enum: ["a", "b"] },
            max_price: { type: "number" },
          },
        },
        now,
      }),
    ).toEqual({ status: "examples_missing", fields: ["query", "max_price"] });
  });

  it("checks the riskiest fields first and lists what the budget leaves out", () => {
    const plan = planned(
      controlCasePlan({
        inputSchema: searchInput,
        outputSchema: searchOutput,
        now,
        emptyProbeToken: token,
        budget: 6,
        priorities: { changedFields: ["color"], lastFailedFields: ["limit"] },
      }),
    );
    // The all-together case sets the changed field too, so it ranks with it.
    expect(plan.cases.map(({ key }) => key)).toEqual([
      "{}",
      '{"color":"blue"}',
      allTogether,
      '{"color":"__unoffered__"}',
      '{"limit":24}',
      '{"limit":1}',
    ]);
    expect(plan.notChecked).toContainEqual({ key: '{"sort":"price_asc"}', fields: ["sort"] });
    expect(plan.notChecked).toHaveLength(13);
  });

  it("never cuts a field the change touched or a caller failure named", () => {
    const plan = planned(
      controlCasePlan({
        inputSchema: searchInput,
        now,
        emptyProbeToken: token,
        budget: 2,
        priorities: { failureFields: ["sort"] },
      }),
    );
    expect(plan.cases.map(({ key }) => key)).toEqual([
      "{}",
      '{"sort":"relevance"}',
      '{"sort":"price_asc"}',
      '{"sort":"price_desc"}',
      allTogether,
    ]);
  });

  it("plans only the base case for a tool without inputs", () => {
    const plan = planned(
      controlCasePlan({ inputSchema: { type: "object", properties: {} }, now }),
    );
    expect(summary(plan.cases)).toEqual([
      { key: "{}", kind: "base", input: {}, expect: "result" },
    ]);
  });

  it("derives the same empty-probe token for the same schema and day", () => {
    const tokenOf = (at: Date) =>
      planned(controlCasePlan({ inputSchema: searchInput, now: at })).cases.find(
        (entry) => entry.kind === "empty_probe",
      )?.input["query"];
    const first = tokenOf(now);
    expect(first).toMatch(/^zq-[a-z2-7]{8}-xv$/u);
    expect(tokenOf(new Date("2026-10-09T23:00:00Z"))).toBe(first);
    expect(tokenOf(new Date("2026-10-10T01:00:00Z"))).not.toBe(first);
  });
});
