import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import { OperationFailure, operationErrors } from "./operation-failure.js";

// One page of a list per call, and a cursor to the next. A script reads the position it continues
// from with `startList`, picks the rows it returns with `selectRows` and writes the list's output
// fields with `finishList`. The host signs every cursor a caller sees and checks it before the
// next run starts, so a script never writes, signs or parses a cursor itself: the position it
// gets is one this tool returned within the hour, for the same inputs.

/** Rows a call returns when the caller names no `limit`, and the most it may ask for. */
export const listLimitDefault = 20;
export const listLimitMax = 50;
/** The longest cursor a caller may send back. */
export const listCursorMaxLength = 2_048;
/** How long a cursor can be used after the run that returned it. */
export const listCursorTtlMs = 3_600_000;
/** The most one call reads before it returns what it has with a cursor that continues. */
export const listCallBounds = { sitePages: 5, steps: 10 } as const;
/**
 * The deepest position a cursor may hold when it has no link or token from the site to open: the
 * replay from the first page grows with depth, so past it `next_cursor` is null.
 */
export const listDepth = { sitePages: 10, steps: 20 } as const;

/**
 * How a site shows the next rows: `pages` (numbered page links), `next_link` (only a Next link,
 * often with an opaque token), `append` (a "Load more" control), `scroll` (rows that load as the
 * list scrolls), `api` (the page's own list endpoint with an offset, page or token) or `offset`
 * (the whole list on one page, read in windows).
 */
export const ListMechanism = Schema.Literal(
  "pages",
  "next_link",
  "append",
  "scroll",
  "api",
  "offset",
);
export type ListMechanism = typeof ListMechanism.Type;

/**
 * Why a cursor was refused. The host refuses `malformed`, `altered`, `version`, `other_tool`,
 * `inputs_changed`, `expired` and `off_site` before the run starts; the script refuses
 * `mechanism_changed` when the tool now pages another way, and `site_expired` when the site
 * refuses its own link or token and the position cannot be rebuilt.
 */
export const CursorRefusal = Schema.Literal(
  "malformed",
  "altered",
  "version",
  "other_tool",
  "inputs_changed",
  "expired",
  "off_site",
  "mechanism_changed",
  "site_expired",
);
export type CursorRefusal = typeof CursorRefusal.Type;

/** A row key's or context's digest in a cursor: 48 bits, so no account value rides in it. */
const Digest = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{8}$/u));
const Count = Schema.Int.pipe(Schema.between(0, 100_000));

/**
 * Where the next rows start on the site: the site page and the offset within it, the steps of a
 * "Load more" or scroll replay, and the site's own link to that page (`href`) or its list API's
 * token (`token`) exactly as this run read them. `scope` is a list scope the site applies by its
 * own value, such as a year or a tab.
 */
export const ListPosition = Schema.Struct({
  page: Schema.optional(Schema.Int.pipe(Schema.between(1, 100_000))),
  steps: Schema.optional(Count),
  offset: Count,
  pageSize: Schema.optional(Schema.Int.pipe(Schema.between(1, 10_000))),
  href: Schema.optional(Schema.String.pipe(Schema.maxLength(1_024))),
  token: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
  scope: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
});
export type ListPosition = typeof ListPosition.Type;

/**
 * The part of a cursor a script writes and reads: its mechanism, position, the rows returned so
 * far, the anchor (the last returned row's key digest), the digests of the last page's keys and
 * the digest of the context the site applied. The host adds the tool, the inputs' digest and the
 * expiry, and signs it.
 */
export const ListDraft = Schema.Struct({
  m: ListMechanism,
  pos: ListPosition,
  n: Count,
  a: Schema.optional(Digest),
  s: Schema.Array(Digest).pipe(Schema.maxItems(listLimitMax)),
  cx: Schema.optional(Digest),
});
export type ListDraft = typeof ListDraft.Type;

/** How a draft travels between the runtime and its host, never to a caller. */
export const listDraftPrefix = "pcd1.";

export const encodeListDraft = (draft: ListDraft) =>
  `${listDraftPrefix}${Buffer.from(JSON.stringify(Schema.encodeSync(ListDraft)(draft))).toString("base64url")}`;

/** The draft a `pcd1.` string holds, or undefined for any other value. */
export const decodeListDraft = (value: unknown): ListDraft | undefined => {
  if (typeof value !== "string" || !value.startsWith(listDraftPrefix)) return undefined;
  const body = value.slice(listDraftPrefix.length);
  if (!/^[A-Za-z0-9_-]*$/u.test(body)) return undefined;
  try {
    const decoded = Schema.decodeUnknownEither(ListDraft, { onExcessProperty: "error" })(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    return Either.isRight(decoded) ? decoded.right : undefined;
    // error-reporting-allow: parse-predicate a draft that is not JSON is no draft
  } catch {
    return undefined;
  }
};

/** A row key's or context's digest, as cursors carry it. */
export const listDigest = (value: string) =>
  createHash("sha256").update(value).digest("base64url").slice(0, 8);

/** The list inputs every list tool takes; spread them into its input schema's fields. */
export const listInputFields = {
  limit: Schema.optional(
    Schema.Int.pipe(Schema.between(1, listLimitMax)).annotations({
      description: `The most results to return in this call, 1 to ${listLimitMax}. Default ${listLimitDefault}.`,
    }),
  ),
  cursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(listCursorMaxLength)).annotations({
      description:
        "The next_cursor a previous call returned, to get the results that follow. Send the same other inputs as that call; limit may change.",
    }),
  ),
};

/** The list outputs every list tool returns; spread them into its output schema's fields. */
export const listOutputFields = {
  next_cursor: Schema.NullOr(Schema.String).annotations({
    description:
      "Pass as cursor, with the same inputs, to get the results that follow. Null when no more can be fetched.",
  }),
  next_cursor_expires_at: Schema.NullOr(Schema.String).annotations({
    description:
      "When next_cursor stops working, as an ISO 8601 UTC time; null when next_cursor is null.",
  }),
  has_more: Schema.Boolean.annotations({
    description: "Whether the site shows more results after these, reachable or not.",
  }),
  total_results: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())).annotations({
    description:
      "The site's own exact count of results; null when it shows none or only an approximate one.",
  }),
  list_changed: Schema.Boolean.annotations({
    description:
      "True when the site's list changed since the cursor was issued; rows may be missing or repeated relative to earlier pages.",
  }),
};

/** The list fields `finishList` writes into a tool's output. */
export interface ListOutput {
  readonly next_cursor: string | null;
  readonly next_cursor_expires_at: string | null;
  readonly has_more: boolean;
  readonly total_results: number | null;
  readonly list_changed: boolean;
}

/** Where a call starts: its `limit`, and on a later page the position the cursor holds. */
export interface ListStart {
  readonly limit: number;
  readonly mechanism: ListMechanism;
  /** Undefined on the first page. */
  readonly position?: ListPosition;
  /** Rows earlier pages returned. */
  readonly returned: number;
  readonly anchor?: string;
  readonly seen: ReadonlySet<string>;
  readonly context?: string;
}

const refuse = (reason: CursorRefusal, message: string) =>
  new operationErrors.InvalidInput(message, { field: "cursor", kind: reason });

/**
 * Reads the call's `limit` and the position its cursor holds, before any browser work. A cursor
 * reaches the script only after the host checked its signature, tool, inputs and expiry. It
 * throws `errors.InvalidInput` with `field: "cursor"` when the cursor is not one the host
 * checked, or the tool now pages another way than when it was issued.
 */
export const startList = (
  input: unknown,
  options: { readonly mechanism: ListMechanism },
): ListStart => {
  const limitValue: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "limit") : undefined;
  const cursor: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "cursor") : undefined;
  const limit =
    typeof limitValue === "number" && Number.isInteger(limitValue)
      ? Math.min(Math.max(limitValue, 1), listLimitMax)
      : listLimitDefault;
  if (cursor === undefined || cursor === null)
    return { limit, mechanism: options.mechanism, returned: 0, seen: new Set() };
  const draft = decodeListDraft(cursor);
  if (draft === undefined)
    throw refuse(
      "malformed",
      "The cursor is not one this tool returned. Call again without cursor to start from the first page.",
    );
  if (draft.m !== options.mechanism)
    throw refuse(
      "mechanism_changed",
      "This tool now pages the site another way, so the cursor no longer applies. Call again without cursor to start from the first page and skip the results you already have.",
    );
  return {
    limit,
    mechanism: draft.m,
    position: draft.pos,
    returned: draft.n,
    ...(draft.a === undefined ? {} : { anchor: draft.a }),
    seen: new Set(draft.s),
    ...(draft.cx === undefined ? {} : { context: draft.cx }),
  };
};

/**
 * Picks the rows that follow the previous page from `rows`, the rows the call read in the site's
 * order from where its position starts. It continues after the anchor, the last row the previous
 * page returned, wherever that row now is. When the anchor is gone, it continues after the last
 * row the previous page returned that is still there, else from the first row, so a change
 * repeats rows rather than skipping them. It drops rows the previous page returned and any key
 * twice. `listChanged` is true when the anchor is gone, a returned row came back or the
 * context the site applied (such as a location it chose) differs. A key is the row's stable ID;
 * give a promoted copy of a row its own key, such as `sponsored:` plus the ID, to keep both.
 */
export const selectRows = <Row>(
  list: ListStart,
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  options: { readonly context?: string } = {},
): { readonly rows: Row[]; readonly listChanged: boolean } => {
  const digests = rows.map((row) => listDigest(keyOf(row)));
  let start = 0;
  let changed = false;
  const position = list.position;
  if (position !== undefined) {
    const anchor = list.anchor === undefined ? -1 : digests.lastIndexOf(list.anchor);
    if (anchor >= 0) start = anchor + 1;
    else {
      // The anchor is gone, or on the site page before: continue after the last returned row
      // still here, so a removal repeats rows rather than skipping them.
      const lastSeen = digests.findLastIndex((digest) => list.seen.has(digest));
      start = lastSeen + 1;
      if (position.offset > 0 || lastSeen >= 0) changed = true;
    }
    if (
      list.context !== undefined &&
      options.context !== undefined &&
      listDigest(options.context) !== list.context
    )
      changed = true;
  }
  const kept = new Set<string>();
  const selected: Row[] = [];
  for (let index = start; index < rows.length; index++) {
    const digest = digests[index] ?? "";
    if (list.seen.has(digest)) {
      changed = true;
      continue;
    }
    if (kept.has(digest)) continue;
    kept.add(digest);
    const row = rows[index];
    if (row !== undefined) selected.push(row);
  }
  return { rows: selected, listChanged: changed };
};

/** Whether the tool can rebuild `next` on a later call. */
const reachable = (next: ListPosition) =>
  next.href !== undefined ||
  next.token !== undefined ||
  ((next.page ?? 1) <= listDepth.sitePages && (next.steps ?? 0) <= listDepth.steps);

/**
 * Writes the list's output fields for the rows this call returns. `next` is where the following
 * rows start, null when the site shows nothing further. Past the deepest position the tool can
 * rebuild without a site link or token, `next_cursor` is null and `has_more` stays true. The host
 * signs `next_cursor` and fills `next_cursor_expires_at` after the run.
 */
export const finishList = <Row>(
  list: ListStart,
  page: {
    readonly rows: readonly Row[];
    readonly keyOf: (row: Row) => string;
    readonly next: ListPosition | null;
    readonly hasMore: boolean;
    readonly totalResults: number | null;
    readonly listChanged: boolean;
    readonly context?: string;
  },
): ListOutput => {
  if (page.rows.length > list.limit)
    throw new OperationFailure(
      `finishList got ${page.rows.length} rows for a limit of ${list.limit}; return at most limit rows`,
      { dispatch: "unknown" },
    );
  const digests = page.rows.map((row) => listDigest(page.keyOf(row)));
  const next = page.next !== null && reachable(page.next) ? page.next : null;
  const anchor = digests.at(-1) ?? list.anchor;
  const seen = digests.length > 0 ? digests : [...list.seen];
  const context = page.context === undefined ? list.context : listDigest(page.context);
  return {
    next_cursor:
      next === null
        ? null
        : encodeListDraft({
            m: list.mechanism,
            pos: Schema.decodeUnknownSync(ListPosition)(next),
            n: list.returned + page.rows.length,
            ...(anchor === undefined ? {} : { a: anchor }),
            s: seen.slice(-listLimitMax),
            ...(context === undefined ? {} : { cx: context }),
          }),
    next_cursor_expires_at: null,
    has_more: page.hasMore || page.next !== null,
    total_results: page.totalResults,
    list_changed: page.listChanged,
  };
};
