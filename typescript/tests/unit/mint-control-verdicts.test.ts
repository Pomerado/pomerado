import { describe, expect, it } from "vitest";
import type { ControlCase, ControlCheckPlan } from "../../src/mint/control-cases.js";
import {
  controlCheckFeedback,
  evaluateControlChecks,
  type ControlCaseResult,
  type ControlCaseRun,
  type ControlRunOutcome,
} from "../../src/mint/control-verdicts.js";

const outputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "price"],
        properties: {
          name: { type: "string" },
          price: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
      },
    },
    next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
const testCase = (
  key: string,
  overrides: Partial<ControlCase> = {},
): ControlCase => ({
  key,
  kind: key === "{}" ? "base" : "field",
  fields: key === "{}" ? [] : Object.keys(JSON.parse(key) as object),
  input: {},
  expect: "result",
  priority: key === "{}" ? 0 : 5,
  ...overrides,
});
const planOf = (...cases: ControlCase[]): ControlCheckPlan => ({
  entrypoint: "src/tool.mjs",
  cases,
  notChecked: [],
});
const items = (...names: string[]) => ({
  items: names.map((name, index) => ({ name, price: 10 + index })),
});
const completed = (output: unknown): ControlRunOutcome => ({ status: "completed", output });
const ran = (key: string, outcome: ControlRunOutcome, followUp?: ControlRunOutcome): ControlCaseRun => ({
  key,
  outcome,
  ...(followUp === undefined ? {} : { followUp }),
});
const verdictOf = (controlCase: ControlCase, outcome: ControlRunOutcome, followUp?: ControlRunOutcome) =>
  evaluateControlChecks(
    planOf(controlCase),
    { cases: [ran(controlCase.key, outcome, followUp)] },
    { outputSchema },
  ).results[0];

describe("evaluateControlChecks", () => {
  it("judges each outcome by what its case expects", () => {
    const sort = testCase('{"sort":"price_asc"}');
    const probe = testCase('{"query":"$empty_probe"}', {
      kind: "empty_probe",
      expect: "empty_or_choices",
    });
    const unoffered = testCase('{"size":"__unoffered__"}', {
      kind: "unoffered_probe",
      expect: "choices",
    });
    const inverted = testCase('{"max_price":20,"min_price":100}', {
      kind: "inverted_range",
      expect: "refusal_or_empty",
    });
    const timeout: ControlRunOutcome = {
      status: "failed",
      errorClass: "TimeoutError",
      failingFrame: "src/tool.mjs:12",
    };
    const choices: ControlRunOutcome = {
      status: "invalid_input",
      field: "size",
      available: ["S", "M"],
    };
    const bare: ControlRunOutcome = { status: "invalid_input" };
    const rows: readonly [ControlCase, ControlRunOutcome, ControlRunOutcome | undefined, unknown][] = [
      // O1: a result with items passes; the site's own empty result is `empty`.
      [sort, completed(items("a", "b")), undefined, { verdict: "pass" }],
      [sort, completed({ items: [] }), undefined, { verdict: "empty" }],
      // O1: a required field that comes back null fails.
      [
        sort,
        completed({ items: [{ name: "a", price: null }] }),
        undefined,
        { verdict: "fail", errorClass: "RequiredOutputNull" },
      ],
      [sort, timeout, undefined, { verdict: "fail", errorClass: "TimeoutError", failingFrame: "src/tool.mjs:12" }],
      // A tool that refuses a value its own schema offers is broken.
      [sort, bare, undefined, { verdict: "fail", errorClass: "InvalidInput" }],
      // O2: a refusal naming the page's choices passes only when the first choice then passes.
      [unoffered, choices, completed(items("a")), { verdict: "refused_with_choices" }],
      [unoffered, choices, timeout, { verdict: "fail", errorClass: "TimeoutError" }],
      // A refusal without choices says nothing yet.
      [unoffered, bare, undefined, { verdict: "inconclusive", inconclusive: "no_choices" }],
      [unoffered, timeout, undefined, { verdict: "fail" }],
      // The empty probe: the site's empty result, or its choices; a throw where empty was right fails.
      [probe, completed({ items: [] }), undefined, { verdict: "empty" }],
      [probe, timeout, undefined, { verdict: "fail", errorClass: "TimeoutError" }],
      // An inverted range may be refused or come back empty, never crash.
      [inverted, bare, undefined, { verdict: "pass" }],
      [inverted, completed({ items: [] }), undefined, { verdict: "empty" }],
      [inverted, timeout, undefined, { verdict: "fail" }],
      // A challenge or a host incident is inconclusive.
      [sort, { status: "inconclusive", reason: "challenge" }, undefined, { verdict: "inconclusive", inconclusive: "challenge" }],
    ];
    for (const [controlCase, outcome, followUp, expected] of rows)
      expect(verdictOf(controlCase, outcome, followUp), JSON.stringify(outcome)).toMatchObject(
        expected as object,
      );
  });

  it("follows paging to a second page that must differ from the first", () => {
    const paging = testCase('{"cursor":"$next_page"}', {
      kind: "paging",
      followUp: { kind: "next_page", inputField: "cursor", outputField: "next_cursor" },
    });
    const first = completed({ ...items("a", "b"), next_cursor: "p2" });
    expect(verdictOf(paging, first, completed(items("c", "d")))).toMatchObject({ verdict: "pass" });
    expect(verdictOf(paging, first, completed({ ...items("a", "b"), next_cursor: null }))).toMatchObject({
      verdict: "fail",
      errorClass: "PageRepeated",
    });
    expect(
      verdictOf(paging, first, { status: "inconclusive", reason: "no_next_page" }),
    ).toMatchObject({ verdict: "inconclusive", inconclusive: "no_next_page" });
  });

  it("blocks on a broken control and names the case, its error and frame", () => {
    const plan = planOf(testCase("{}"), testCase('{"sort":"price_asc"}'));
    const evaluation = evaluateControlChecks(
      plan,
      {
        cases: [
          ran("{}", completed(items("a", "b"))),
          ran('{"sort":"price_asc"}', {
            status: "failed",
            errorClass: "TimeoutError",
            failingFrame: "src/tool.mjs:12",
          }),
        ],
      },
      { outputSchema },
    );
    expect(evaluation.refusal).toBe("control_broken");
    expect(evaluation.findings).toEqual([
      {
        reason: "control_broken",
        key: '{"sort":"price_asc"}',
        fields: ["sort"],
        verdict: "fail",
        errorClass: "TimeoutError",
        failingFrame: "src/tool.mjs:12",
      },
    ]);
    // Results keep no output or input.
    expect(JSON.stringify(evaluation.results)).not.toContain('"a"');
    const feedback = controlCheckFeedback(evaluation);
    expect(feedback).toContain('{"sort":"price_asc"}');
    expect(feedback).toContain("TimeoutError");
    expect(feedback).toContain("src/tool.mjs:12");
  });

  it("finds an inert control only when the base returned two or more items", () => {
    const cases = [
      testCase("{}"),
      testCase('{"sort":"price_asc"}'),
      testCase('{"sort":"price_desc"}'),
    ];
    const same = (output: unknown) =>
      evaluateControlChecks(
        planOf(...cases),
        { cases: cases.map(({ key }) => ran(key, completed(output))) },
        { outputSchema },
      );
    expect(same(items("a", "b"))).toMatchObject({
      refusal: "control_inert",
      findings: [{ reason: "control_inert", fields: ["sort"] }],
    });
    // One item cannot show an order, so identical output proves nothing.
    expect(same(items("a")).refusal).toBeUndefined();
    // A control whose values change the output is live.
    const live = evaluateControlChecks(
      planOf(...cases),
      {
        cases: [
          ran("{}", completed(items("a", "b"))),
          ran('{"sort":"price_asc"}', completed(items("a", "b"))),
          ran('{"sort":"price_desc"}', completed(items("b", "a"))),
        ],
      },
      { outputSchema },
    );
    expect(live.refusal).toBeUndefined();
    // A single value of a field (a boolean) is never enough to call it inert.
    const flag = [testCase("{}"), testCase('{"in_stock":true}')];
    expect(
      evaluateControlChecks(
        planOf(...flag),
        { cases: flag.map(({ key }) => ran(key, completed(items("a", "b")))) },
        { outputSchema },
      ).refusal,
    ).toBeUndefined();
  });

  it("compares a candidate with its baseline: regressions, already-broken controls and nulled fields", () => {
    const cases = [testCase("{}"), testCase('{"sort":"price_asc"}'), testCase('{"color":"blue"}')];
    const passed = (key: string, nonNullFields: readonly string[] = []): ControlCaseResult => ({
      key,
      fields: [],
      verdict: "pass",
      nonNullFields,
    });
    const evaluation = evaluateControlChecks(
      planOf(...cases),
      {
        cases: [
          ran("{}", completed({ items: [{ name: "a", price: 3 }, { name: "b", price: 4 }] })),
          ran('{"sort":"price_asc"}', { status: "failed", errorClass: "TimeoutError" }),
          ran('{"color":"blue"}', { status: "failed", errorClass: "TimeoutError" }),
        ],
        baseline: [
          passed("{}", ["items", "items[]", "items[].name", "items[].price", "next_cursor"]),
          passed('{"sort":"price_asc"}'),
          { key: '{"color":"blue"}', fields: ["color"], verdict: "fail", errorClass: "TimeoutError" },
        ],
      },
      { outputSchema },
    );
    expect(evaluation.findings).toEqual([
      expect.objectContaining({
        reason: "control_regression",
        key: '{"sort":"price_asc"}',
        passedOnBaseline: true,
      }),
      expect.objectContaining({
        reason: "output_regression",
        key: "{}",
        nulledFields: ["next_cursor"],
      }),
      // Broken on both revisions still blocks: a repair fixes broken controls too.
      expect.objectContaining({
        reason: "control_broken",
        key: '{"color":"blue"}',
        passedOnBaseline: false,
      }),
    ]);
    expect(evaluation.refusal).toBe("control_regression");
    expect(controlCheckFeedback(evaluation)).toContain("passed on the published revision");
  });

  it("never blocks on inconclusive cases and records the fields an output filled", () => {
    const cases = [testCase("{}"), testCase('{"sort":"price_asc"}')];
    const evaluation = evaluateControlChecks(
      planOf(...cases),
      {
        cases: [
          ran("{}", completed({ items: [{ name: "a", price: null }, { name: "b", price: 2 }] })),
          ran('{"sort":"price_asc"}', { status: "inconclusive", reason: "challenge" }),
        ],
      },
    );
    expect(evaluation.refusal).toBeUndefined();
    expect(evaluation.results[0]?.nonNullFields).toEqual([
      "items",
      "items[]",
      "items[].name",
      "items[].price",
    ]);
  });
});
