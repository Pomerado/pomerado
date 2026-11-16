import { readFile } from "node:fs/promises";
import { Schema } from "effect";

/*
 * PlaceMatch (third-party/placematch/source.json names its repository and commit) decides whether
 * an address a caller typed is the same place as a row a site lists, in any script. It is a
 * WebAssembly module with a small JavaScript loader, both copied into this package beside this
 * module, so a script loads it from its own package with no network and no install step.
 */

/** The loader and module: beside this module once built, in third-party/ in a source checkout. */
const folder = new URL(
  import.meta.url.endsWith(".ts") ? "../../../third-party/placematch/" : "./placematch/",
  import.meta.url,
);

/** The longest text and the most rows one call takes; PlaceMatch refuses more, never cuts it. */
export const placeMatchLimits = { textLength: 512, rows: 100 } as const;

/** A row a site lists, and whether the site shows it with a category of its own, as a venue. */
export interface PlaceRow {
  readonly text: string;
  readonly categorized: boolean;
}

const Explained = Schema.Struct({
  outcome: Schema.Literal("match", "none", "ambiguous"),
  index: Schema.NullOr(Schema.Int),
  same: Schema.Array(Schema.Int),
  reasons: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
  cross_script: Schema.Boolean,
  prefer_on_read: Schema.NullOr(Schema.Int),
  rows: Schema.Array(
    Schema.Struct({
      verdict: Schema.Literal("same", "different", "unknown"),
      reasons: Schema.Array(Schema.String),
      notes: Schema.Array(Schema.String),
    }),
  ),
});

/**
 * PlaceMatch's answer for a caller's address and a site's rows: `match` with every row that is the
 * caller's place in `same`, in the site's order; `ambiguous` with the rows to choose between in
 * `same` and why in `reasons`; or `none`. `prefer_on_read` names the row a read may take when a
 * same-name row stands beside a longer form of the name. Each row has its verdict and `notes`, such
 * as `unit_not_listed` for a row of the place that leaves out the caller's unit.
 */
export type PlaceExplained = typeof Explained.Type;

export interface PlaceMatch {
  readonly pickExplained: (
    query: string,
    rows: readonly PlaceRow[],
    country: string | undefined,
  ) => PlaceExplained;
  /** The row is a site's control, such as "See more results for <text>", never a place. */
  readonly isControl: (query: string, row: string) => boolean;
  /** The row shows the caller's whole text, of two parts or more, after words of its own. */
  readonly showsTypedText: (query: string, row: string) => boolean;
  /** The row, after its first part, is in the town, region or postcode the caller gave. */
  readonly inArea: (query: string, row: string, country: string | undefined) => boolean;
  /** The caller's house, street and town under another postcode of the same postal area. */
  readonly sameButPostcode: (query: string, row: string, country: string | undefined) => boolean;
}

interface Loaded {
  readonly pickExplained: (query: string, rows: readonly PlaceRow[], options: object) => unknown;
  readonly isControl: (query: string, row: string) => unknown;
  readonly showsTypedText: (query: string, row: string, minWords: number) => unknown;
  readonly inArea: (query: string, row: string, country: string | undefined) => unknown;
  readonly sameButPostcode: (query: string, row: string, country: string | undefined) => unknown;
}

const decodeExplained = Schema.decodeUnknownSync(Explained);

/** PlaceMatch's answer, checked: its shape, and every row it names among the rows it was given. */
const checked = (answer: unknown, count: number): PlaceExplained => {
  const explained = decodeExplained(answer);
  const named = [explained.index, explained.prefer_on_read, ...explained.same];
  if (explained.rows.length !== count || named.some((at) => at !== null && (at < 0 || at >= count)))
    throw new TypeError("PlaceMatch answered about rows it was not given");
  return explained;
};

const flag = (answer: unknown) => {
  if (typeof answer !== "boolean") throw new TypeError("PlaceMatch answered a check with no yes or no");
  return answer;
};

const open = async (): Promise<PlaceMatch> => {
  const [loader, bytes]: [unknown, Uint8Array] = await Promise.all([
    import(new URL("placematch.mjs", folder).href),
    readFile(new URL("placematch.wasm", folder)),
  ]);
  const load: unknown = Reflect.get(Object(loader), "load");
  if (typeof load !== "function") throw new TypeError("PlaceMatch's loader has no load function");
  const matcher = (await load(bytes)) as Loaded;
  return {
    pickExplained: (query, rows, country) =>
      checked(matcher.pickExplained(query, rows, country === undefined ? {} : { country }), rows.length),
    isControl: (query, row) => flag(matcher.isControl(query, row)),
    showsTypedText: (query, row) => flag(matcher.showsTypedText(query, row, 1)),
    inArea: (query, row, country) => flag(matcher.inArea(query, row, country)),
    sameButPostcode: (query, row, country) => flag(matcher.sameButPostcode(query, row, country)),
  };
};

let opened: Promise<PlaceMatch> | undefined;

/** PlaceMatch, loaded once per process from this package; a load that failed is tried again. */
export const placeMatch = (): Promise<PlaceMatch> => {
  opened ??= open().catch((error: unknown) => {
    opened = undefined;
    throw new Error("PlaceMatch could not be loaded from this package", { cause: error });
  });
  return opened;
};
