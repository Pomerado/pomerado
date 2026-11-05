import { describe, expect, it } from "vitest";
import {
  checkFindings,
  findingsOf,
  loweredBaseline,
  readBaseline,
  type Finding,
} from "../../../tools/check-lint.js";

// `pnpm lint` lets the repository keep the findings it had when it adopted the linter, rule by
// rule, while every finding a change adds fails.

const finding = (rule: string, file = "typescript/src/a.ts", severity = "error"): Finding => ({
  severity,
  file,
  line: 1,
  column: 1,
  rule,
  message: "found",
});

describe("the lint baseline check", () => {
  it("reads oxlint's JSON report and names rules as the config does", () => {
    const report = {
      diagnostics: [
        {
          severity: "warning",
          filename: "tools/x.ts",
          code: "eslint(max-lines)",
          message: "too long",
          labels: [{ span: { line: 3, column: 7 } }],
        },
        { severity: "error", filename: "tools/y.ts", message: "could not parse", labels: [] },
      ],
    };
    expect(findingsOf(report)).toEqual([
      {
        severity: "warning",
        file: "tools/x.ts",
        line: 3,
        column: 7,
        rule: "eslint/max-lines",
        message: "too long",
      },
      {
        severity: "error",
        file: "tools/y.ts",
        line: 0,
        column: 0,
        rule: "",
        message: "could not parse",
      },
    ]);
    expect(() => findingsOf({ files: [] })).toThrow("no diagnostics array");
  });

  it("fails each finding of a rule the baseline does not list, even a warning", () => {
    const { problems } = checkFindings(
      [
        finding("typescript/no-floating-promises"),
        finding("eslint/complexity", "b.ts", "warning"),
        finding(""),
      ],
      { "typescript/no-unsafe-call": 2 },
    );
    expect(problems).toEqual([
      expect.stringContaining("typescript/no-floating-promises"),
      expect.stringContaining("warning eslint/complexity"),
      expect.stringContaining("a.ts:1:1: error : found"),
    ]);
  });

  it("allows a listed rule up to its count and fails it above", () => {
    const baseline = { "typescript/no-unsafe-call": 2 };
    const two = [finding("typescript/no-unsafe-call"), finding("typescript/no-unsafe-call")];
    expect(checkFindings(two, baseline)).toEqual({ problems: [], notices: [] });
    const three = [...two, finding("typescript/no-unsafe-call")];
    expect(checkFindings(three, baseline).problems).toEqual([
      expect.stringContaining("typescript/no-unsafe-call: 3 findings exceed the baseline of 2"),
    ]);
  });

  it("only notes a rule under its count, and lowering never raises or adds a rule", () => {
    const baseline = { "typescript/no-unsafe-call": 2, "eslint/complexity": 4 };
    const findings = [
      finding("typescript/no-unsafe-call"),
      ...Array.from({ length: 6 }, () => finding("eslint/complexity", "c.ts", "warning")),
      finding("typescript/no-explicit-any"),
    ];
    expect(checkFindings(findings, baseline).notices).toEqual([
      "typescript/no-unsafe-call: 1 findings, under the baseline of 2",
    ]);
    expect(loweredBaseline(findings, baseline)).toEqual({
      "typescript/no-unsafe-call": 1,
      "eslint/complexity": 4,
    });
    expect(loweredBaseline([], baseline)).toEqual({});
  });

  it("refuses a baseline that isn't a map of positive whole counts", () => {
    expect(readBaseline('{"rules":{"eslint/complexity":3}}')).toEqual({ "eslint/complexity": 3 });
    expect(() => readBaseline('{"warnings":3}')).toThrow('must hold {"rules"');
    expect(() => readBaseline('{"rules":{"eslint/complexity":0}}')).toThrow("positive whole count");
    expect(() => readBaseline('{"rules":{"eslint/max-depth":1.5}}')).toThrow("whole count");
  });
});
