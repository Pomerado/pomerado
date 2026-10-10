import { describe, expect, it } from "vitest";
import {
  admitListCursor,
  listCursorKeys,
  sealListOutput,
  type ListCursorKeys,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";
import {
  finishList,
  listCursorTtlMs,
  selectRows,
  startList,
  type ListMechanism,
  type ListPosition,
} from "../../src/runtime/list-page.js";

// The cursor's arithmetic and its checks, as a host and a script see them. The whole path, from a
// served run's output to the next run's refusal, is in tests/browser/standalone-list-pages.spec.ts.

const key = (id: string, byte: number) => ({ id, secret: new Uint8Array(32).fill(byte) });
const keys: ListCursorKeys = listCursorKeys({ current: key("k1", 1) });
const issuedAt = Date.UTC(2026, 0, 5, 12);
const scope = (overrides: Partial<ListCursorScope> = {}): ListCursorScope => ({
  keys,
  operation: "tool-1",
  siteOrigin: "https://www.example.test",
  siteDomain: "example.test",
  now: issuedAt,
  ...overrides,
});
const input = { query: "lamps", limit: 2 };
type Row = { readonly id: string; readonly sponsored?: boolean };
const keyOf = (row: Row) => (row.sponsored === true ? `sponsored:${row.id}` : row.id);
const rows = (...ids: readonly string[]): Row[] => ids.map((id) => ({ id }));

/** Page one of a list, sealed by the host: the cursor a caller gets back. */
const pageOne = (
  next: ListPosition | null = { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
  mechanism: ListMechanism = "pages",
) => {
  const list = startList(input, { mechanism });
  const returned = rows("a", "b");
  const fields = finishList(list, {
    rows: returned,
    keyOf,
    next,
    hasMore: true,
    totalResults: 5,
    listChanged: false,
  });
  return sealListOutput({ results: returned, ...fields }, input, scope());
};
const cursorOf = (sealed: { readonly output: unknown }) =>
  String(Reflect.get(sealed.output as object, "next_cursor"));

describe("a sealed cursor", () => {
  it("signs page one's position and says when it expires", () => {
    const sealed = pageOne();
    expect(sealed.dropped).toBeUndefined();
    expect(sealed.output).toMatchObject({
      next_cursor: expect.stringMatching(/^pc1\.k1\./u),
      next_cursor_expires_at: new Date(issuedAt + listCursorTtlMs).toISOString(),
      has_more: true,
      total_results: 5,
      list_changed: false,
    });
  });

  it("gives the next run the position, where limit may change", () => {
    const cursor = cursorOf(pageOne());
    const admitted = admitListCursor({ ...input, limit: 3, cursor }, scope());
    expect(admitted).toMatchObject({ ok: true, continues: true });
    if (!admitted.ok) throw new Error("refused");
    const list = startList(admitted.input, { mechanism: "pages" });
    expect(list).toMatchObject({
      limit: 3,
      returned: 2,
      position: { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
    });
  });

  it.each([
    ["altered", (cursor: string) => cursor.replace(/\.(.)/u, ".X"), scope()],
    ["malformed", () => "page-2", scope()],
    ["other_tool", (cursor: string) => cursor, scope({ operation: "tool-2" })],
    ["expired", (cursor: string) => cursor, scope({ now: issuedAt + listCursorTtlMs })],
    [
      "off_site",
      (cursor: string) => cursor,
      scope({ siteOrigin: "https://other.test", siteDomain: "other.test" }),
    ],
  ] as const)("refuses a cursor that is %s", (reason, change, at) => {
    const cursor = change(cursorOf(pageOne()));
    expect(admitListCursor({ ...input, cursor }, at)).toMatchObject({
      ok: false,
      reason,
      message: expect.stringContaining("Call again without cursor"),
    });
  });

  it("refuses a cursor sent with other inputs", () => {
    const cursor = cursorOf(pageOne());
    expect(admitListCursor({ query: "desks", cursor }, scope())).toMatchObject({
      ok: false,
      reason: "inputs_changed",
    });
  });

  it("keeps verifying under a rotated key until the old key is dropped", () => {
    const cursor = cursorOf(pageOne());
    const rotated = listCursorKeys({ current: key("k2", 2), previous: [key("k1", 1)] });
    expect(admitListCursor({ ...input, cursor }, scope({ keys: rotated }))).toMatchObject({
      ok: true,
    });
    expect(
      admitListCursor({ ...input, cursor }, scope({ keys: { current: key("k2", 2) } })),
    ).toMatchObject({ ok: false, reason: "altered" });
  });

  it("drops a next position off the tool's site, or one the runtime did not write", () => {
    expect(pageOne({ page: 2, offset: 0, href: "https://elsewhere.test/s?page=2" })).toMatchObject({
      dropped: "off_site",
      output: { next_cursor: null, next_cursor_expires_at: null, has_more: true },
    });
    expect(
      sealListOutput({ results: [], next_cursor: "page=2", has_more: true }, input, scope()),
    ).toMatchObject({ dropped: "not_a_draft", output: { next_cursor: null } });
  });

  it("passes an input without a cursor, and refuses a draft a caller wrote", () => {
    expect(admitListCursor(input, scope())).toEqual({ ok: true, input, continues: false });
    const list = startList(input, { mechanism: "pages" });
    const draft = finishList(list, {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: "https://elsewhere.test/" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    }).next_cursor;
    expect(admitListCursor({ ...input, cursor: draft }, scope())).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("the rows a later page returns", () => {
  const continued = (sitePage: readonly Row[]) => {
    const admitted = admitListCursor({ ...input, cursor: cursorOf(pageOne()) }, scope());
    if (!admitted.ok) throw new Error("refused");
    return selectRows(startList(admitted.input, { mechanism: "pages" }), sitePage, keyOf);
  };

  it("continue after the last returned row, wherever rows were inserted above it", () => {
    expect(continued(rows("a", "b", "c", "d"))).toEqual({
      rows: rows("c", "d"),
      listChanged: false,
    });
    expect(continued(rows("new", "a", "b", "c"))).toEqual({ rows: rows("c"), listChanged: false });
  });

  it("continue after the last returned row still there, and say so, when the anchor is gone", () => {
    expect(continued(rows("a", "c", "d"))).toEqual({ rows: rows("c", "d"), listChanged: true });
    expect(continued(rows("c", "d"))).toEqual({ rows: rows("c", "d"), listChanged: true });
  });

  it("never repeat a returned row, and keep a sponsored copy of one", () => {
    expect(continued([...rows("a", "b"), { id: "a", sponsored: true }, ...rows("c", "a")])).toEqual(
      { rows: [{ id: "a", sponsored: true }, ...rows("c")], listChanged: true },
    );
  });
});

describe("finishList", () => {
  const list = startList({}, { mechanism: "append" });
  const finish = (next: ListPosition | null, returned = rows("a")) =>
    finishList(list, {
      rows: returned,
      keyOf,
      next,
      hasMore: false,
      totalResults: null,
      listChanged: false,
    });

  it("gives no cursor past the deepest replay, and keeps has_more", () => {
    expect(finish({ steps: 20, offset: 0 }).next_cursor).toMatch(/^pcd1\./u);
    expect(finish({ steps: 21, offset: 0 })).toMatchObject({ next_cursor: null, has_more: true });
  });

  it("refuses more rows than limit", () => {
    expect(() =>
      finishList(startList({ limit: 1 }, { mechanism: "append" }), {
        rows: rows("a", "b"),
        keyOf,
        next: null,
        hasMore: false,
        totalResults: null,
        listChanged: false,
      }),
    ).toThrow("at most limit rows");
  });

  it("refuses a cursor from before the tool paged another way", () => {
    const admitted = admitListCursor({ ...input, cursor: cursorOf(pageOne()) }, scope());
    if (!admitted.ok) throw new Error("refused");
    expect(() => startList(admitted.input, { mechanism: "append" })).toThrow(
      expect.objectContaining({ name: "InvalidInput", field: "cursor", kind: "mechanism_changed" }),
    );
  });
});
