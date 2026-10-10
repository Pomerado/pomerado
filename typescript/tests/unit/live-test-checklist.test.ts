import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  checklistOf,
  cursorPairOf,
  decodeCasesFile,
  judgeCase,
} from "../../src/mint/live-tests.js";

// The checklist and the verdicts are pure and full of edge cases: schema shapes the host must
// read right, so a correct tool never gets a checklist item it cannot have.

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });
const items = (input: unknown, output: unknown) => checklistOf(input, output).map((item) => item.item);

describe("checklistOf", () => {
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
    expect(items(input, output)).toContain("next_page");
    // The cursor is paging, not a control to test on its own.
    expect(items(input, output)).not.toContain("input:cursor");
  });

  it("plans no next page when only a boolean says there is one", () => {
    const output = object({ results: { type: "array" }, has_next_page: { type: "boolean" } });
    const input = object({ query: { type: "string" }, page_token: { type: "boolean" } });
    expect(cursorPairOf(input, output)).toBeUndefined();
    expect(items(input, output)).not.toContain("next_page");
  });

  it("asks for each value of a short list, three of a long one and a switch's other side", () => {
    const checklist = checklistOf(
      object({
        sort: { enum: ["relevance", "price_low", "price_high"] },
        size: { enum: ["xs", "s", "m", "l", "xl", "xxl", "3xl", "4xl"] },
        in_stock: { type: "boolean" },
      }),
      object({ results: { type: "array" } }),
    );
    const needs = Object.fromEntries(checklist.map((item) => [item.item, item.needs]));
    expect(needs).toMatchObject({ "input:sort": 3, "input:size": 3, "input:in_stock": 1 });
    expect(needs).toMatchObject({ all_inputs: 1, combination: 1, unoffered_value: 1, no_results: 1 });
  });

  it("plans other records for a details read and a second store, with both location items", () => {
    const list = items(
      object(
        {
          product_url: { type: "string" },
          store: { type: "string" },
          zipCode: { type: "string" },
        },
        ["product_url"],
      ),
      object({ title: { type: "string" }, price: { type: "number" } }),
    );
    expect(list).toEqual(
      expect.arrayContaining([
        "other_record",
        "other_value:store",
        "location_applied",
        "location_impossible",
      ]),
    );
    expect(list).not.toContain("no_results");
  });

  it("finds a location by its description and resolves local references", () => {
    const input = {
      $defs: { Where: { type: "string", description: "Postal code to deliver to" } },
      ...object({ query: { type: "string" }, where: { $ref: "#/$defs/Where" } }, ["query"]),
    };
    expect(items(input, object({ results: { type: "array" } }))).toEqual(
      expect.arrayContaining(["location_applied", "location_impossible"]),
    );
  });

  it("always asks for the example repeated from fresh browsers", () => {
    expect(checklistOf(undefined, undefined)).toEqual([
      expect.objectContaining({ item: "repeat_example", needs: 3, expect: "result" }),
    ]);
  });
});

describe("judgeCase", () => {
  const completed = (output: unknown) => ({
    id: "case",
    outcome: { status: "completed" as const, output },
    durationMs: 1,
  });

  it("judges results against the expectation, by the output's lists", () => {
    expect(judgeCase({ expect: "result" }, completed({ results: [{}] })).verdict).toBe("pass");
    expect(judgeCase({ expect: "result" }, completed({ results: [] })).verdict).toBe("fail");
    expect(judgeCase({ expect: "empty" }, completed({ results: [] })).verdict).toBe("pass");
    expect(judgeCase({ expect: "empty" }, completed({ results: [{}] }))).toMatchObject({
      verdict: "fail",
      got: "results (1)",
    });
    // A details read returns no list: any output is a result.
    expect(judgeCase({ expect: "result" }, completed({ title: "Lamp" })).verdict).toBe("pass");
    expect(judgeCase({ expect: "invalid_input" }, completed({ title: "Lamp" })).verdict).toBe(
      "fail",
    );
  });

  it("passes a refusal only where one was expected, and a loud failure but not a timeout", () => {
    const refused = {
      id: "case",
      outcome: { status: "invalid_input" as const, field: "size", available: ["s", "m"] },
      durationMs: 1,
    };
    expect(judgeCase({ expect: "invalid_input" }, refused)).toMatchObject({
      verdict: "pass",
      refusal: { field: "size", available: ["s", "m"] },
    });
    expect(judgeCase({ expect: "result" }, refused).verdict).toBe("fail");
    const failed = (errorClass: string) => ({
      id: "case",
      outcome: { status: "failed" as const, errorClass, frame: "src/tool.mjs:40" },
      durationMs: 1,
    });
    expect(judgeCase({ expect: "error" }, failed("LocationNotApplied")).verdict).toBe("pass");
    expect(judgeCase({ expect: "error" }, failed("TimeoutError")).verdict).toBe("fail");
    expect(judgeCase({ expect: "result" }, failed("TimeoutError"))).toMatchObject({
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
    expect(judgeCase({ expect: "result" }, paged)).toMatchObject({ verdict: "fail" });
    expect(
      judgeCase(
        { expect: "result" },
        { id: "case", outcome: { status: "inconclusive", reason: "challenge" }, durationMs: 1 },
      ).verdict,
    ).toBe("inconclusive");
  });
});

describe("decodeCasesFile", () => {
  it("refuses a duplicate case id and a case with no expectation", () => {
    const one = { id: "a", covers: [], input: {}, expect: "result" };
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [one, one] })))).toBe(true);
    expect(
      Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [{ id: "a", covers: [], input: {} }] }))),
    ).toBe(true);
    expect(decodeCasesFile(undefined)).toEqual(Either.right({ cases: [] }));
  });
});
