import { describe, expect, it } from "vitest";
import { selectJson } from "../../src/browser/index.js";

// Selective reads of large JSON: only the selected values come back, the rest is skipped unparsed,
// and the same selection gives the same answer on JSON text and on the value in memory.

const store = {
  store: { name: "Corner Market", id: "s-1" },
  sections: [
    {
      title: "Fruit",
      items: [
        { id: "a1", title: "Apple", price: { amount: 120, currency: "USD" }, notes: 'says "fresh" {not json}' },
        { id: "a2", title: "Pear", price: { amount: 90, currency: "USD" }, notes: "back\\slash\\" },
      ],
    },
    { title: "Bakery", items: [{ id: "b1", title: "Bread", tags: ["warm", "daily"] }] },
  ],
};

const both = (select: Parameters<typeof selectJson>[1], options?: Parameters<typeof selectJson>[2]) => {
  const fromText = selectJson(JSON.stringify(store, null, 2), select, options);
  expect(selectJson(store, select, options)).toEqual(fromText);
  return fromText;
};

const failureOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return { ...(error as object), name: (error as Error).name, message: (error as Error).message };
  }
  throw new Error("expected a failure");
};

describe("selectJson", () => {
  it("returns each selection's matches in document order, with only the fields it names", () => {
    expect(
      both({
        name: "store.name",
        items: { path: "sections.*.items.*", fields: { id: "id", price: "price.amount", tag: "tags.0" } },
        second: ["sections", 1, "title"],
      }),
    ).toEqual({
      name: ["Corner Market"],
      items: [
        { id: "a1", price: 120, tag: null },
        { id: "a2", price: 90, tag: null },
        { id: "b1", price: null, tag: "warm" },
      ],
      second: ["Bakery"],
    });
  });

  it('matches "**" at any depth, none included, and "" as the whole data', () => {
    expect(both({ ids: "**.id", amounts: "sections.**.amount" })).toEqual({
      ids: ["s-1", "a1", "a2", "b1"],
      amounts: [120, 90],
    });
    expect(both({ all: "" })).toEqual({ all: [store] });
  });

  it("stops reading once every selection has its limit", () => {
    // Everything after the first item is broken: a read that went on would fail.
    const text = '{"items":[{"id":1},{"id":2},{"id":' + "[".repeat(10) + "oops";
    expect(selectJson(text, { first: { path: "items.*.id", limit: 2 } })).toEqual({ first: [1, 2] });
    expect(failureOf(() => selectJson(text, { first: { path: "items.*.id", limit: 3 } }))).toMatchObject({
      name: "PageDataFailure",
      reason: "not_json",
    });
  });

  it("reads keys and strings with escapes, and skips brackets inside strings", () => {
    const text = String.raw`{"a\"b":{"x":"}]\"{["},"café":[1,"]",{"k":true}],"z":null}`;
    expect(selectJson(text, { quoted: 'a"b.x', accented: ["café", "2", "k"], last: "z" })).toEqual({
      quoted: ['}]"{['],
      accented: [true],
      last: [null],
    });
  });

  it("starts after a marker for data assigned in a script", () => {
    const text = 'window.__CONFIG__ = {"a":1};\nwindow.__STATE__ = {"user":{"id":"u-7"}};';
    expect(selectJson(text, { id: "user.id", a: "a" }, { after: "__STATE__ =" })).toEqual({ id: ["u-7"], a: [] });
    expect(failureOf(() => selectJson(text, { id: "user.id" }, { after: "__MISSING__" }))).toMatchObject({
      name: "PageDataFailure",
      reason: "not_found",
    });
  });

  it("outlines data too large to read whole: types, sizes, keys and each array's first item", () => {
    const text = JSON.stringify(store);
    const [outline] = selectJson(text, { shape: { path: "sections", outline: 2 } }).shape as [
      Record<string, unknown>,
    ];
    expect(outline).toEqual({
      type: "array",
      chars: JSON.stringify(store.sections).length,
      length: 2,
      first: {
        type: "object",
        chars: JSON.stringify(store.sections[0]).length,
        keys: 2,
        children: {
          title: { type: "string", chars: 5, preview: "Fruit" },
          items: { type: "array", chars: JSON.stringify(store.sections[0]?.items).length, length: 2 },
        },
      },
    });
    const [listed] = selectJson(store, { shape: { path: "store", outline: 1 } }, { maxKeys: 1 }).shape as [
      Record<string, unknown>,
    ];
    expect(listed).toEqual({
      type: "object",
      keys: 2,
      children: { name: { type: "string", chars: 13, preview: "Corner Market" } },
      more: 1,
    });
  });

  it("refuses to return more than maxChars, naming the selection, never the data", () => {
    const failure = failureOf(() =>
      both({ items: { path: "sections.*.items.*" } }, { maxChars: 100 }),
    ) as Record<string, unknown>;
    expect(failure).toMatchObject({ name: "PageDataFailure", reason: "too_large", maxChars: 100, field: "items" });
    expect(String(failure.message)).not.toContain("Apple");
    // Fields alone fit where whole items don't.
    expect(both({ ids: { path: "sections.*.items.*", fields: { id: "id" } } }, { maxChars: 100 })).toEqual({
      ids: [{ id: "a1" }, { id: "a2" }, { id: "b1" }],
    });
  });

  it("fails on text that holds no JSON or breaks off, with the place and no text", () => {
    expect(failureOf(() => selectJson("no data here", { a: "a" }))).toMatchObject({
      name: "PageDataFailure",
      reason: "not_json",
      message: "not_json: the text holds no JSON object or array",
    });
    expect(failureOf(() => selectJson('{"a":"secret value', { a: "a" }))).toMatchObject({
      reason: "not_json",
      message: "not_json: the data ends inside a string",
      at: 5,
    });
  });

  it("walks a value with cycles without looping", () => {
    const node: Record<string, unknown> = { id: "n1" };
    node.self = node;
    expect(selectJson({ root: node }, { ids: "**.id" })).toEqual({ ids: ["n1"] });
  });

  it("rejects a malformed selection before reading", () => {
    expect(() => selectJson("{}", { a: { path: "a", limit: 0 } })).toThrow(TypeError);
    expect(() => selectJson("{}", { a: { path: "a", outline: 1, fields: { b: "b" } } })).toThrow(TypeError);
  });
});
