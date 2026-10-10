import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Either, Schema } from "effect";
import { canonicalJson } from "./fingerprint.js";
import {
  decodeListDraft,
  encodeListDraft,
  ListDraft,
  listCursorMaxLength,
  listCursorTtlMs,
  type CursorRefusal,
} from "./list-page.js";

// The host's side of list cursors. A run's script writes an unsigned draft of where the next rows
// start (`finishList`); the host signs it into the cursor the caller sees (`sealListOutput`). When
// a caller sends a cursor back, the host checks it before the run starts, before any browser or
// machine is provisioned for it (`admitListCursor`), and hands the script the draft it signed. A
// script never sees the key, so it cannot make a cursor the host accepts.

/** One signing key: a short id the cursor names and at least 32 secret bytes. */
export interface ListCursorKey {
  readonly id: string;
  readonly secret: Uint8Array;
}

/**
 * The host's keys: `current` signs, and `current` or any of `previous` verifies, so a rotated
 * key keeps its cursors working until they expire. Keep a replaced key in `previous` for at least
 * `listCursorTtlMs`.
 */
export interface ListCursorKeys {
  readonly current: ListCursorKey;
  readonly previous?: readonly ListCursorKey[];
}

const keyIdPattern = /^[A-Za-z0-9_-]{1,16}$/u;
const minimumSecretBytes = 32;

/** Keys a host checks once, at start: a bad id or a short secret throws. */
export const listCursorKeys = (keys: ListCursorKeys): ListCursorKeys => {
  for (const key of [keys.current, ...(keys.previous ?? [])]) {
    if (!keyIdPattern.test(key.id))
      throw new TypeError("A list cursor key id is 1 to 16 letters, digits, - or _");
    if (key.secret.byteLength < minimumSecretBytes)
      throw new TypeError(`A list cursor key holds at least ${minimumSecretBytes} bytes`);
  }
  return keys;
};

/** A fresh random key, for a host that keeps its cursors only while its process runs. */
export const randomListCursorKeys = (): ListCursorKeys => ({
  current: { id: randomBytes(6).toString("base64url"), secret: randomBytes(32) },
});

/** Where a cursor applies: the host's stable id for the tool, its site and the host's clock. */
export interface ListCursorScope {
  readonly keys: ListCursorKeys;
  /** The tool, the same across its repairs, such as a host's tool id or a local integration's name. */
  readonly operation: string;
  /** The site's origin; a cursor's site link must be on it. */
  readonly siteOrigin?: string;
  /** The site's registrable domain, when the host computed one: its HTTPS hosts are the site too. */
  readonly siteDomain?: string;
  /** The host's clock, in milliseconds since the epoch. */
  readonly now: number;
}

const wirePrefix = "pc1";

/** The signed part of a cursor: the draft, the tool, the inputs' digest and its lifetime. */
const SignedCursor = Schema.Struct({
  v: Schema.Literal(1),
  op: Schema.String,
  ih: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  ...ListDraft.fields,
});

const digest = (text: string, length: number) =>
  createHash("sha256").update(text).digest("base64url").slice(0, length);

/** The inputs that make a list: every input but `cursor`, `limit` and `include`. */
const listInputs = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const {
    cursor: _cursor,
    limit: _limit,
    include: _include,
    ...rest
  } = input as Record<string, unknown>;
  return rest;
};

/**
 * The digest of the inputs a cursor is bound to. `limit` and `include` may change between pages.
 * Input that is not JSON data has no digest.
 */
export const listInputDigest = (input: unknown): string | undefined => {
  try {
    return digest(canonicalJson(JSON.parse(JSON.stringify(listInputs(input) ?? null))), 16);
    // error-reporting-allow: parse-predicate input that is not JSON data binds no cursor
  } catch {
    return undefined;
  }
};

const operationDigest = (operation: string) => digest(`operation\0${operation}`, 16);

const mac = (key: ListCursorKey, signed: string) =>
  createHmac("sha256", key.secret).update(signed).digest();

/** Whether a site link is on the cursor's site: its origin, or an HTTPS host in its domain. */
const onSite = (href: string, scope: Pick<ListCursorScope, "siteOrigin" | "siteDomain">) => {
  const url = URL.parse(href);
  if (url === null || url.username !== "" || url.password !== "") return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (scope.siteOrigin !== undefined && url.origin === scope.siteOrigin) return true;
  const domain = scope.siteDomain;
  return (
    domain !== undefined &&
    url.protocol === "https:" &&
    (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  );
};

/** What each refusal tells the caller. Each says to start over, which always works. */
const refusalText: { readonly [Reason in CursorRefusal]: string } = {
  malformed: "The cursor is not one this tool returned.",
  altered: "The cursor was changed after this tool returned it.",
  version: "The cursor comes from an older version of the host.",
  other_tool: "The cursor belongs to another tool.",
  inputs_changed: "The cursor was returned for other inputs; only limit may change between pages.",
  expired: "The cursor expired; a cursor works for an hour after the call that returned it.",
  off_site: "The cursor points off the tool's site.",
  mechanism_changed: "This tool now pages the site another way, so the cursor no longer applies.",
  site_expired: "The site no longer accepts the position this cursor holds.",
};

/** A refused cursor's message for the caller. */
export const listCursorRefusalMessage = (reason: CursorRefusal) =>
  `${refusalText[reason]} Call again without cursor to start from the first page, and skip the results you already have by their IDs.`;

export type ListCursorAdmission =
  | {
      readonly ok: true;
      /** The input the script runs with: the cursor replaced by the draft the host signed. */
      readonly input: unknown;
      /** Whether the input continues a list. */
      readonly continues: boolean;
    }
  | { readonly ok: false; readonly reason: CursorRefusal; readonly message: string };

const refused = (reason: CursorRefusal): ListCursorAdmission => ({
  ok: false,
  reason,
  message: listCursorRefusalMessage(reason),
});

/**
 * Checks a run's `cursor` input before the run starts: a cursor this host signed for this tool
 * and these inputs, unexpired, whose site link is on the tool's site. An input without a cursor
 * passes unchanged. A host refuses the run at once on `ok: false`, as an input the caller fixes,
 * with nothing provisioned and no repair; it runs the script with `input` on `ok: true`.
 */
export const admitListCursor = (input: unknown, scope: ListCursorScope): ListCursorAdmission => {
  const cursor: unknown =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Reflect.get(input, "cursor")
      : undefined;
  if (cursor === undefined || cursor === null) return { ok: true, input, continues: false };
  if (typeof cursor !== "string" || cursor.length > listCursorMaxLength)
    return refused("malformed");
  const parts = cursor.split(".");
  const [prefix, keyId, body, signature] = parts;
  if (
    parts.length !== 4 ||
    prefix !== wirePrefix ||
    keyId === undefined ||
    body === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(body) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  )
    return refused("malformed");
  const key = [scope.keys.current, ...(scope.keys.previous ?? [])].find(
    (candidate) => candidate.id === keyId,
  );
  if (key === undefined) return refused("altered");
  const expected = mac(key, `${wirePrefix}.${keyId}.${body}`);
  const given = Buffer.from(signature, "base64url");
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected))
    return refused("altered");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    // error-reporting-allow: parse-predicate a signed body that is not JSON is malformed
  } catch {
    return refused("malformed");
  }
  if (typeof payload !== "object" || payload === null || Reflect.get(payload, "v") !== 1)
    return refused("version");
  const decoded = Schema.decodeUnknownEither(SignedCursor, { onExcessProperty: "error" })(payload);
  if (Either.isLeft(decoded)) return refused("malformed");
  const signed = decoded.right;
  if (signed.op !== operationDigest(scope.operation)) return refused("other_tool");
  if (signed.ih !== listInputDigest(input)) return refused("inputs_changed");
  if (scope.now >= signed.exp * 1000) return refused("expired");
  if (signed.pos.href !== undefined && !onSite(signed.pos.href, scope)) return refused("off_site");
  const { v: _v, op: _op, ih: _ih, iat: _iat, exp: _exp, ...draft } = signed;
  return {
    ok: true,
    input: { ...(input as Record<string, unknown>), cursor: encodeListDraft(draft) },
    continues: true,
  };
};

/** Why a host dropped a script's next cursor instead of signing it. */
export type DroppedListCursor = "not_a_draft" | "off_site" | "too_long" | "inputs_not_json";

/**
 * Signs the `next_cursor` a run's output holds and fills `next_cursor_expires_at`, an hour from
 * `now`. `input` is the caller's input for the run, as sent. A next cursor the runtime did not
 * write, one whose site link is off the tool's site, or one too long for a caller to send back
 * is dropped: `next_cursor` becomes null, `has_more` stays true and `dropped` says why. An
 * output without `next_cursor` passes unchanged.
 */
export const sealListOutput = (
  output: unknown,
  input: unknown,
  scope: ListCursorScope,
): { readonly output: unknown; readonly dropped?: DroppedListCursor } => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return { output };
  const fields = output as Record<string, unknown>;
  if (!("next_cursor" in fields)) return { output };
  const drop = (dropped: DroppedListCursor) => ({
    output: { ...fields, next_cursor: null, next_cursor_expires_at: null, has_more: true },
    dropped,
  });
  const next = fields["next_cursor"];
  if (next === null || next === undefined)
    return { output: { ...fields, next_cursor: null, next_cursor_expires_at: null } };
  const draft = decodeListDraft(next);
  if (draft === undefined) return drop("not_a_draft");
  if (draft.pos.href !== undefined && !onSite(draft.pos.href, scope)) return drop("off_site");
  const inputs = listInputDigest(input);
  if (inputs === undefined) return drop("inputs_not_json");
  const issued = Math.floor(scope.now / 1000);
  const expires = issued + listCursorTtlMs / 1000;
  const body = Buffer.from(
    JSON.stringify(
      Schema.encodeSync(SignedCursor)({
        v: 1,
        op: operationDigest(scope.operation),
        ih: inputs,
        iat: issued,
        exp: expires,
        ...draft,
      }),
    ),
  ).toString("base64url");
  const key = scope.keys.current;
  const signed = `${wirePrefix}.${key.id}.${body}`;
  const cursor = `${signed}.${mac(key, signed).toString("base64url")}`;
  if (cursor.length > listCursorMaxLength) return drop("too_long");
  return {
    output: {
      ...fields,
      next_cursor: cursor,
      next_cursor_expires_at: new Date(expires * 1000).toISOString(),
    },
  };
};
