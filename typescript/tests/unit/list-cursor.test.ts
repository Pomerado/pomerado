import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import {
  admitListCursor,
  listCursorKeys,
  sealListOutput,
  type ListCursorKeys,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";
import {
  finishList,
  listCursorMaxLength,
  listCursorTtlMs,
  listSeenMax,
  selectRows,
  startList,
  withListHost,
  type ListHost,
  type ListMechanism,
  type ListPosition,
} from "../../src/runtime/list-page.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// The cursor's arithmetic and its checks, as a host and a script see them. The whole path, from a
// served run's output to the next run's refusal, is in tests/browser/standalone-list-pages.spec.ts.

const key = (id: string, byte: number) => ({ id, secret: new Uint8Array(32).fill(byte) });
const keys: ListCursorKeys = listCursorKeys({ current: key("k1", 1) });
const issuedAt = Date.UTC(2026, 0, 5, 12);
const scope = (overrides: Partial<ListCursorScope> = {}): ListCursorScope => ({
  keys,
  operation: "tool-1",
  siteOrigin: "https://www.example.test",
  now: issuedAt,
  ...overrides,
});
const input = { query: "lamps", limit: 2 };
type Row = { readonly id: string; readonly sponsored?: boolean };
const keyOf = (row: Row) => (row.sponsored === true ? `sponsored:${row.id}` : row.id);
const rows = (...ids: readonly string[]): Row[] => ids.map((id) => ({ id }));
/** A run's input as a host that signs cursors hands it to the script. */
const hosted = (value: object, host: ListHost = {}) => withListHost(value, host);

/** Page one of a list, sealed by the host: the cursor a caller gets back. */
const pageOne = (
  next: ListPosition | null = { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
  mechanism: ListMechanism = "pages",
  at: ListCursorScope = scope(),
) => {
  const list = startList(hosted(input), { mechanism });
  const returned = rows("a", "b");
  const fields = finishList(list, {
    rows: returned,
    keyOf,
    next,
    hasMore: true,
    totalResults: 5,
    listChanged: false,
  });
  return sealListOutput({ results: returned, ...fields }, input, at);
};
const cursorOf = (sealed: { readonly output: unknown }) =>
  String(Reflect.get(sealed.output as object, "next_cursor"));
/** The list a later page starts from, once the host admitted its cursor. */
const continuing = (cursor: string, mechanism: ListMechanism = "pages", at = scope()) => {
  const value = { ...input, cursor };
  const admitted = admitListCursor(value, at);
  if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
  return startList(hosted(value, admitted.list), { mechanism });
};

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
    const value = { ...input, limit: 3, cursor };
    const admitted = admitListCursor(value, scope());
    if (!admitted.ok) throw new Error("refused");
    expect(startList(hosted(value, admitted.list), { mechanism: "pages" })).toMatchObject({
      limit: 3,
      returned: 2,
      position: { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
    });
  });

  it.each([
    ["altered", (cursor: string) => cursor.replace(/(\.[A-Za-z0-9_-]{8})/u, "$1X"), scope()],
    ["other_tool", (cursor: string) => cursor, scope({ operation: "tool-2" })],
    ["expired", (cursor: string) => cursor, scope({ now: issuedAt + listCursorTtlMs })],
    ["off_site", (cursor: string) => cursor, scope({ siteOrigin: "https://other.test" })],
    ["other_account", (cursor: string) => cursor, scope({ subject: "account-b" })],
    ["unknown_key", (cursor: string) => cursor, scope({ keys: { current: key("k9", 9) } })],
    ["version", (cursor: string) => cursor.replace(/^pc1\./u, "pc2."), scope()],
    ["malformed", (cursor: string) => `${cursor}.extra`, scope()],
  ] as const)("refuses a cursor that is %s", (reason, change, at) => {
    const cursor = change(cursorOf(pageOne(undefined, undefined, scope({ subject: "account-a" }))));
    const checked = at.subject === undefined ? { ...at, subject: "account-a" } : at;
    expect(admitListCursor({ ...input, cursor }, checked)).toMatchObject({
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
    ).toMatchObject({ ok: false, reason: "unknown_key" });
  });

  it("drops a next position off the tool's site, and says why", () => {
    expect(pageOne({ page: 2, offset: 0, href: "https://elsewhere.test/s?page=2" })).toMatchObject({
      dropped: "off_site",
      output: {
        next_cursor: null,
        next_cursor_expires_at: null,
        has_more: true,
        next_cursor_unavailable: "off_site",
      },
    });
  });

  it("treats an empty cursor as none", () => {
    expect(admitListCursor({ ...input, cursor: "" }, scope())).toEqual({ ok: true, list: {} });
    expect(startList(hosted({ ...input, cursor: "" }), { mechanism: "pages" }).position).toBe(
      undefined,
    );
  });
});

describe("a tool that pages with its own cursor", () => {
  // A tool built before the runtime's cursors keeps its own continuation, which the host passes
  // through untouched, and a runtime draft sent in as a cursor is refused.
  it("gets its own cursor back unchanged, and its own next cursor reaches the caller", () => {
    const legacy = { query: "lamps", cursor: "page=2" };
    const admitted = admitListCursor(legacy, scope());
    expect(admitted).toEqual({ ok: true, list: {} });
    const output = { results: [], next_cursor: "page=3" };
    expect(sealListOutput(output, legacy, scope())).toEqual({ output });
    const ended = { results: [], next_cursor: null };
    expect(sealListOutput(ended, legacy, scope())).toEqual({ output: ended });
  });

  it("refuses a runtime draft sent in as a cursor", () => {
    const draft = finishList(startList(hosted(input), { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: "https://www.example.test/s?page=2" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    }).next_cursor;
    expect(draft).toMatch(/^pcd1\./u);
    expect(admitListCursor({ ...input, cursor: draft }, scope())).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("is refused by the runtime's list, which reads only the position a host checked", () => {
    expect(() =>
      startList(hosted({ ...input, cursor: "page=2" }), { mechanism: "pages" }),
    ).toThrow(expect.objectContaining({ name: "InvalidInput", field: "cursor", kind: "malformed" }));
  });
});

describe("a host that does not sign cursors", () => {
  const referenceTool = async () =>
    stripTypeScriptTypes(await readFile("typescript/authoring/examples/pagination.ts", "utf8"))
      .replace('"../../src/browser/index.js"', '"../../runtime/index.js"');
  const entrypoint = "operation/src/tool.mjs";

  it("refuses a hand-written draft before the script touches the site", async () => {
    const forged = `pcd1.${Buffer.from(
      JSON.stringify({
        m: "pages",
        pos: { page: 2, offset: 0, href: "http://169.254.169.254/latest/" },
        n: 1,
        s: [],
      }),
    ).toString("base64url")}`;
    let browserCalls = 0;
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, yield* Effect.promise(referenceTool)]],
            input: { query: "lamps", cursor: forged },
            browser: {
              sessionId: "local",
              executeResponse: () => {
                browserCalls++;
                return Effect.succeed({ success: true, result: null });
              },
            },
          }).pipe(Effect.flip, Effect.map(runOutcomeFailure("read", "operation")));
        }),
      ),
    );
    expect(failure.outcome).toMatchObject({
      code: "input_rejected",
      details: { field: "cursor", kind: "malformed" },
    });
    expect(browserCalls).toBe(0);
  });

  it("returns no cursor it cannot sign, and says why", () => {
    const fields = finishList(startList(input, { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: "https://www.example.test/s?page=2" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    });
    expect(fields).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "unsigned_host",
    });
  });
});

describe("the rows a later page returns", () => {
  const continued = (sitePage: readonly Row[]) =>
    selectRows(continuing(cursorOf(pageOne())), sitePage, keyOf);

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

  it("say the list changed when a position at a site page's start lacks the anchor", () => {
    // Page one ended at a site page's end; a position naming the next site page cannot tell a row
    // removed above the boundary from no change, so it says the list may have changed.
    const cursor = cursorOf(
      pageOne({ page: 2, offset: 0, href: "https://www.example.test/s?q=lamps&page=2" }),
    );
    expect(selectRows(continuing(cursor), rows("d", "e"), keyOf)).toEqual({
      rows: rows("d", "e"),
      listChanged: true,
    });
  });

  it("follow a site's own continuation token without calling the list changed", () => {
    const cursor = cursorOf(pageOne({ offset: 0, token: "after-b" }, "api"));
    expect(selectRows(continuing(cursor, "api"), rows("c", "d"), keyOf)).toEqual({
      rows: rows("c", "d"),
      listChanged: false,
    });
  });

  it("never repeat a returned row, and keep a sponsored copy of one", () => {
    expect(continued([...rows("a", "b"), { id: "a", sponsored: true }, ...rows("c", "a")])).toEqual(
      { rows: [{ id: "a", sponsored: true }, ...rows("c")], listChanged: true },
    );
  });
});

describe("finishList", () => {
  const list = startList(hosted({}), { mechanism: "append" });
  const finish = (next: ListPosition | null, returned = rows("a")) =>
    finishList(list, {
      rows: returned,
      keyOf,
      next,
      hasMore: false,
      totalResults: null,
      listChanged: false,
    });

  it("gives no cursor past the deepest replay, keeps has_more and says why", () => {
    expect(finish({ steps: 20, offset: 0 }).next_cursor).toMatch(/^pcd1\./u);
    expect(finish({ steps: 21, offset: 0 })).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "depth_cap",
    });
  });

  it("refuses more rows than limit", () => {
    expect(() =>
      finishList(startList(hosted({ limit: 1 }), { mechanism: "append" }), {
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
    expect(() => continuing(cursorOf(pageOne()), "append")).toThrow(
      expect.objectContaining({ name: "InvalidInput", field: "cursor", kind: "mechanism_changed" }),
    );
  });
});

describe("a cursor at the size limits", () => {
  const longest = (length: number) =>
    `https://www.example.test/s?q=${"x".repeat(length - "https://www.example.test/s?q=".length)}`;
  const fullPage = (count: number) => rows(...Array.from({ length: count }, (_, i) => `row-${i}`));

  it("signs a full page whose site link is as long as a position holds", () => {
    const limitInput = { query: "lamps", limit: 50 };
    const returned = fullPage(50);
    const fields = finishList(startList(hosted(limitInput), { mechanism: "next_link" }), {
      rows: returned,
      keyOf,
      next: {
        page: 100_000,
        steps: 100_000,
        offset: 100_000,
        pageSize: 10_000,
        href: longest(1_024),
      },
      hasMore: true,
      totalResults: null,
      listChanged: false,
      context: "a location the site chose",
    });
    const sealed = sealListOutput(
      { results: returned, ...fields },
      limitInput,
      scope({
        keys: { current: key("k".repeat(16), 3) },
        subject: "an account",
        now: 9_999_999_999_000,
      }),
    );
    expect(sealed.dropped).toBeUndefined();
    const cursor = cursorOf(sealed);
    expect(cursor.length).toBeLessThanOrEqual(listCursorMaxLength);
    const list = continuing(
      cursor,
      "next_link",
      scope({
        keys: { current: key("k".repeat(16), 3) },
        subject: "an account",
        now: 9_999_999_999_000,
      }),
    );
    expect(list.seen.size).toBe(listSeenMax);
  });

  it("signs the largest draft a position can make, whatever its text", () => {
    // Text that JSON escapes takes the most bytes per character; the draft's byte bound decides.
    const fullInput = { query: "lamps", limit: 50 };
    const largest = Array.from({ length: 201 }, (_, length) => 200 - length)
      .map((scopeLength) =>
        finishList(startList(hosted(fullInput), { mechanism: "pages" }), {
          rows: fullPage(50),
          keyOf,
          next: {
            page: 100_000,
            steps: 100_000,
            offset: 100_000,
            pageSize: 10_000,
            href: longest(1_024),
            scope: "\u0001".repeat(scopeLength),
          },
          hasMore: true,
          totalResults: null,
          listChanged: false,
          context: "x",
        }),
      )
      .find((fields) => fields.next_cursor !== null);
    expect(largest?.next_cursor).toMatch(/^pcd1\./u);
    const at = scope({ keys: { current: key("k".repeat(16), 3) }, subject: "an account" });
    const sealed = sealListOutput({ results: [], ...largest }, fullInput, at);
    expect(sealed.dropped).toBeUndefined();
    expect(cursorOf(sealed).length).toBeLessThanOrEqual(listCursorMaxLength);
  });

  it("ends the list with a reason when the site's link is longer than a cursor holds", () => {
    const fields = finishList(startList(hosted(input), { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: longest(1_025) },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    });
    expect(fields).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "position_too_long",
    });
  });
});
