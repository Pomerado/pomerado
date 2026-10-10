import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  cursorPairOf,
  decodeCasesFile,
  judgeCase,
  primaryListOf,
} from "../../src/mint/live-tests.js";

// What the runner reads from a tool's schemas, and the verdicts, are pure and full of edge cases:
// schema shapes the host must read right, so a correct tool is judged by its real results list.

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });

describe("cursorPairOf", () => {
  it("reads a string cursor beside a boolean has_next_page, never the boolean", () => {
    const output = object({
      results: { type: "array" },
      has_next_page: { type: "boolean" },
      next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    const input = object({ query: { type: "string" }, cursor: { type: ["string", "null"] } }, [
      "query",
    ]);
    expect(cursorPairOf(input, output)).toEqual({ inputField: "cursor", outputField: "next_cursor" });
  });

  it("finds no cursor when only a boolean says there is a next page", () => {
    const output = object({ results: { type: "array" }, has_next_page: { type: "boolean" } });
    const input = object({ query: { type: "string" }, page_token: { type: "boolean" } });
    expect(cursorPairOf(input, output)).toBeUndefined();
  });
});

describe("primaryListOf", () => {
  it("reads a details record with image and variant lists as a details read", () => {
    const input = object({ url: { type: "string" }, size: { type: "string" } }, ["url"]);
    const output = object({
      title: { type: "string" },
      price: { type: "number" },
      images: { type: "array", items: { type: "string" } },
      variants: { type: "array", items: object({ name: { type: "string" } }) },
    });
    expect(primaryListOf(input, output)).toBeUndefined();
  });

  it("finds the results list of a search beside other arrays", () => {
    const input = object(
      { query: { type: "string" }, limit: { type: "integer" }, store_id: { type: "string" } },
      ["query"],
    );
    const output = object({
      facets: { type: "array", items: object({ name: { type: "string" } }) },
      results: { type: "array", items: object({ title: { type: "string" } }) },
    });
    expect(primaryListOf(input, output)).toEqual({ field: "results" });
  });
});

describe("judgeCase", () => {
  const completed = (output: unknown) => ({
    id: "case",
    outcome: { status: "completed" as const, output },
    durationMs: 1,
  });

  it("judges a list read by its results list", () => {
    const results = { field: "results" };
    const judge = (expectation: "result" | "empty", output: unknown) =>
      judgeCase({ expect: expectation }, completed(output), results);
    expect(judge("result", { results: [{}], facets: [] }).verdict).toBe("pass");
    expect(judge("result", { results: [], facets: [{}] }).verdict).toBe("fail");
    expect(judge("empty", { results: [], facets: [{}] }).verdict).toBe("pass");
    expect(judge("empty", { results: [{}] })).toMatchObject({ verdict: "fail", got: "results (1)" });
  });

  it("judges a details record by its values, never by its empty lists", () => {
    const record = { title: "Lamp", price: 10, images: [], variants: [] };
    expect(judgeCase({ expect: "result" }, completed(record), undefined).verdict).toBe("pass");
    expect(judgeCase({ expect: "result" }, completed({ title: null, images: [] }), undefined).verdict).toBe(
      "fail",
    );
    expect(judgeCase({ expect: "invalid_input" }, completed(record), undefined).verdict).toBe("fail");
  });

  it("passes a refusal only where one was expected, and a loud failure but not a timeout", () => {
    const refused = {
      id: "case",
      outcome: { status: "invalid_input" as const, field: "size", available: ["s", "m"] },
      durationMs: 1,
    };
    expect(judgeCase({ expect: "invalid_input" }, refused, undefined)).toMatchObject({
      verdict: "pass",
      refusal: { field: "size", available: ["s", "m"] },
    });
    expect(judgeCase({ expect: "result" }, refused, undefined).verdict).toBe("fail");
    const failed = (errorClass: string) => ({
      id: "case",
      outcome: { status: "failed" as const, errorClass, frame: "src/tool.mjs:40" },
      durationMs: 1,
    });
    expect(judgeCase({ expect: "error" }, failed("LocationNotApplied"), undefined).verdict).toBe("pass");
    expect(judgeCase({ expect: "error" }, failed("TimeoutError"), undefined).verdict).toBe("fail");
    expect(judgeCase({ expect: "result" }, failed("TimeoutError"), undefined)).toMatchObject({
      verdict: "fail",
      frame: "src/tool.mjs:40",
    });
  });

  it("judges a next-page case on page 2, and never fails it for a challenge", () => {
    const paged = {
      id: "case",
      outcome: { status: "completed" as const, output: { results: [{}], next_cursor: "c2" } },
      followUp: { status: "completed" as const, output: { results: [] } },
      durationMs: 1,
    };
    expect(judgeCase({ expect: "result" }, paged, { field: "results" })).toMatchObject({ verdict: "fail" });
    expect(
      judgeCase(
        { expect: "result" },
        { id: "case", outcome: { status: "inconclusive", reason: "challenge" }, durationMs: 1 },
        { field: "results" },
      ).verdict,
    ).toBe("inconclusive");
  });
});

describe("decodeCasesFile", () => {
  it("refuses a duplicate case id, a case with no expectation and one with no purpose", () => {
    const one = { id: "a", purpose: "The example again.", input: {}, expect: "result" };
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [one, one] })))).toBe(true);
    const { expect: _expect, ...unexpecting } = one;
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [unexpecting] })))).toBe(true);
    const { purpose: _purpose, ...unexplained } = one;
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [unexplained] })))).toBe(true);
    expect(decodeCasesFile(undefined)).toEqual(Either.right({ cases: [] }));
  });

  it("keeps what the agent chose not to test, with why", () => {
    const notTested = [{ what: "A location the site cannot apply", reason: "No location control." }];
    expect(decodeCasesFile(JSON.stringify({ cases: [], notTested }))).toEqual(
      Either.right({ cases: [], notTested }),
    );
    expect(
      Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [], notTested: [{ what: "Sort" }] }))),
    ).toBe(true);
  });
});
