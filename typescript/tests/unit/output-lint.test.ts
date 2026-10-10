import { describe, expect, it } from "vitest";
import {
  applyOutputOverrides,
  controlLabelsFromAriaSnapshot,
  lintOutput,
  type OutputCheck,
} from "../../src/runtime/output-lint.js";

const checksOf = (output: unknown, options?: Parameters<typeof lintOutput>[1]) =>
  lintOutput(output, options).map(({ path, check }) => `${path} ${check}`);
const checkOf = (value: string, options?: Parameters<typeof lintOutput>[1]) =>
  lintOutput({ value }, options).map(({ check }) => check);

describe("output checks of one string", () => {
  const positives: readonly (readonly [OutputCheck, string])[] = [
    ["script", "var data = window.__state || {}; init(data);"],
    ["script", "function render(items) { return items.map(format); }"],
    ["script", "if (window.dataLayer) window.dataLayer.push({event:'view'});"],
    ["css", ".price{color:#b12704;font-size:18px}"],
    ["css", "@media (max-width: 600px) { .card { display: block; } }"],
    ["css", "margin: 0; padding: 4px; border: none;"],
    ["markup", "Free returns<br/>on most items"],
    ["markup", "Fish &amp; chips"],
    ["template_residue", "undefined"],
    ["template_residue", "Colour: undefined"],
    ["template_residue", "[object Object]"],
    ["template_residue", "Hello {{name}}"],
    ["template_residue", "Total ${amount}"],
    ["json_text", '{"sku":"A1","price":3}'],
    ["invisible_chars", "Blue\u200B shirt"],
    ["untrimmed", " leading space"],
    ["collapsed_text", "A bright room facing the garden, with a desk and\u2026"],
    ["collapsed_text", "A bright room facing the garden..."],
    ["duplicate_entries", "Customer reviews Customer reviews"],
  ];
  it.each(positives)("flags %s in %j", (check, value) => {
    expect(checkOf(value)).toContain(check);
  });

  it("leaves ordinary page text alone", () => {
    const corpus = [
      "2 for $9; limit 4 per order",
      "Rated 4.7 out of 5 (1,203 reviews)",
      "C++ Primer, 5th edition",
      "null and void",
      "Ships in 3-5 days (some exclusions apply)",
      "Size: M; Colour: navy",
      "The set {x: x > 0} is open",
      "Read the document.pdf attached",
      "Save 20% = $12.00 off",
      "Wait... what? Find out tonight at 9.",
      "Downstairs: kitchen, lounge; upstairs: two bedrooms",
      "<3 years old",
    ];
    for (const value of corpus) expect(checkOf(value), value).toEqual([]);
  });

  it("allows markup or JSON text where the schema declares that media type", () => {
    const outputSchema = {
      type: "object",
      properties: {
        value: { type: "string", contentMediaType: "text/html" },
        data: { type: "string", contentMediaType: "application/json" },
      },
    };
    expect(checksOf({ value: "<p>Hello</p>", data: '{"a":1}' }, { outputSchema })).toEqual([]);
  });

  it("flags a long string in a list's record, unless its schema allows that length", () => {
    const long = Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ");
    expect(checksOf({ results: [{ text: long }] })).toContain("results[].text too_long");
    const outputSchema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { $ref: "#/$defs/row" },
        },
      },
      $defs: { row: { type: "object", properties: { text: { type: "string", maxLength: 5000 } } } },
    };
    expect(checksOf({ results: [{ text: long }] }, { outputSchema })).not.toContain(
      "results[].text too_long",
    );
    expect(checksOf({ text: long })).toEqual([]);
  });

  it("flags text that ends with a page control's label or holds one on its own line", () => {
    const controlLabels = ["Show more", "Add to cart"];
    expect(checkOf("A bright room facing the garden. Show more", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    expect(checkOf("Registration\nSTR-0001\nShow more", { controlLabels })).toEqual([
      "collapsed_text",
    ]);
    // A value that is only the label, or holds its words inside a sentence, is not.
    expect(checkOf("Show more", { controlLabels })).toEqual([]);
    expect(checkOf("Show more of the garden from the balcony", { controlLabels })).toEqual([]);
  });

  it("only samples when asked, and cuts a sample to 80 characters", () => {
    const value = `${"x".repeat(100)} var a = 1;`;
    expect(lintOutput({ value })[0]?.sample).toBeUndefined();
    expect(lintOutput({ value }, { samples: true })[0]?.sample).toHaveLength(80);
  });
});

describe("output checks across a list's records", () => {
  const rows = [
    { title: "Blue mug", price: 12, brand: "Acme", seller: "Shop A", note: null },
    { title: "Red mug", price: 14, brand: "Acme", seller: "Shop B", note: null },
    { title: "Green mug", price: 9, brand: "Acme", seller: "Shop C", note: "" },
  ];

  it("flags a field that never varies, one that is always empty, and repeated records", () => {
    const findings = checksOf({ results: [...rows, rows[0]] });
    expect(findings).toContain("results[].brand constant_field");
    expect(findings).toContain("results[].note empty_field");
    expect(findings).toContain("results duplicate_records");
    expect(findings).not.toContain("results[].title constant_field");
  });

  it("leaves a field the schema declares as a closed set, and fewer than three records, alone", () => {
    const outputSchema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: { type: "object", properties: { brand: { type: "string", enum: ["Acme"] } } },
        },
      },
    };
    expect(checksOf({ results: rows }, { outputSchema })).not.toContain(
      "results[].brand constant_field",
    );
    expect(checksOf({ results: rows.slice(0, 2) })).toEqual([]);
  });

  it("flags one field holding most of its siblings' values: a whole card's text", () => {
    const cards = rows.map((row) => ({
      ...row,
      text: `${row.title} by ${row.brand} $${row.price} sold by ${row.seller} Add to cart`,
    }));
    expect(checksOf({ results: cards })).toContain("results[].text card_text");
    // A title that names a brand and a colour is not a card's text.
    const titled = rows.map((row, index) => ({
      ...row,
      colour: ["Blue", "Red", "Green"][index],
      size: "12 oz",
      title: `${row.brand} ${row.title} 12 oz`,
    }));
    expect(checksOf({ results: titled })).not.toContain("results[].title card_text");
  });

  it("flags repeated entries in a list of strings", () => {
    expect(checksOf({ tags: ["New", "Sale", "New"] })).toEqual(["tags[] duplicate_entries"]);
  });
});

describe("overrides", () => {
  it("keeps an overridden finding with its reason and stops it blocking", () => {
    const findings = lintOutput({ code: "const total = 1;", note: "Fish &amp; chips" });
    const applied = applyOutputOverrides(findings, [
      { path: "code", check: "script", reason: "The tool returns code samples" },
      { path: "other", check: "css", reason: "Unused" },
    ]);
    expect(applied.findings).toContainEqual(
      expect.objectContaining({
        path: "code",
        check: "script",
        blocking: false,
        override: "The tool returns code samples",
      }),
    );
    expect(applied.blocking.map(({ path, check }) => `${path} ${check}`)).toEqual(["note markup"]);
    expect(applied.unmatched).toEqual([{ path: "other", check: "css", reason: "Unused" }]);
  });
});

describe("control labels from an accessibility snapshot", () => {
  it("lists short button and link names, not long link text", () => {
    const snapshot = [
      '- heading "Garden room" [level=1]',
      '- paragraph: A bright room. Show more',
      '- button "Show more"',
      '- link "Read all 42 reviews"',
      '- link "Garden room with a balcony, a desk and a view over the lawn"',
      "- button",
      '- textbox "Search"',
    ].join("\n");
    expect(controlLabelsFromAriaSnapshot(snapshot)).toEqual(["Show more", "Read all 42 reviews"]);
  });
});
