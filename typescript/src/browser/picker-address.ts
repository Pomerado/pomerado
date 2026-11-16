import { foldChoiceText } from "../runtime/text.js";
import { placeMatch, placeMatchLimits } from "./placematch.js";
import type { PlaceExplained, PlaceMatch } from "./placematch.js";

/**
 * What `resolveAddress` accepted: the site's suggestion as `suggest` gave it (`choice`) and as
 * `label` reads it, the text that brought it (`query`) and the unit for the site's own unit field
 * (`unit`, "" for none). Or a refusal that `pickRefusal` takes, listing every suggestion the site
 * gave as `available`: `option_missing` when no text brought a usable suggestion, or
 * `option_unclear`, with the ones to ask about as `matches`.
 */
export type AddressOutcome<T> =
  | {
      readonly picked: true;
      readonly choice: T;
      readonly label: string;
      readonly query: string;
      readonly unit: string;
    }
  | AddressRefusal;

/** Why no suggestion was accepted, for `pickRefusal`, with the unit split off the address. */
export interface AddressRefusal {
  readonly picked: false;
  readonly reason: "option_missing" | "option_unclear";
  readonly wanted: string;
  readonly available: readonly string[];
  readonly matches: readonly string[];
  readonly unit: string;
}

/**
 * A row a site's address list shows, as `pickerAddressRows` reads it: its text, its lines joined
 * by commas, and whether the site shows it with a category of its own, such as a venue type, as it
 * does not for a dropped map pin.
 */
export interface AddressRow {
  readonly text: string;
  readonly categorized?: boolean;
}

/** What `matchAddress` accepted: the row at `index`, as `label`, and the unit, or a refusal. */
export type AddressMatch =
  | { readonly picked: true; readonly index: number; readonly label: string; readonly unit: string }
  | AddressRefusal;

/** How to match: a read or a write, and the address's country, such as `US`, when the tool knows it. */
export interface AddressMatchOptions {
  readonly read?: boolean;
  readonly country?: string;
}

/**
 * The text to ask a site for an address, as a person types it, and the unit split off it. It is
 * pure and self-contained: the page code of `pickerCode` embeds this same function with the
 * picker's own fold.
 *
 * The unit is the part right after a street with a house number, else the part right before it,
 * when it has at most two words, one of them holding a digit or a #, no ZIP, and no plain number
 * opening it before another word; or a # and what follows it ending the street. A unit right after
 * the street and before other parts is left out of `query`; one before the street or ending the
 * address is asked for as typed first. `retry` is the text to ask once more when the first brings
 * no row that is the caller's place: joined words split, the ZIP and a unit asked for as typed left
 * out, and stray punctuation dropped, or "" when that is the first text again.
 */
export const addressRequest = (address: string, fold: (text: string) => string) => {
  const squash = (text: unknown) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const zipGroups = /(?<![\p{L}\p{N}])(\d{5})(?:-\d{4})?(?![\p{L}\p{N}])/gu;
  // A ZIP: the last group of five digits, unless it opens the text before other words, as a
  // house number does.
  const zipOf = (text: string) => {
    const last = [...text.matchAll(zipGroups)].at(-1);
    if (last === undefined) return "";
    return last.index === 0 && /[\p{L}\p{N}]/u.test(text.slice(last[0].length)) ? "" : (last[1] ?? "");
  };
  const parts = squash(address)
    .split(",")
    .map(squash)
    .filter((part) => part !== "");
  const tokens = (text: string) =>
    fold(text)
      .split(" ")
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);
  // Whether a part opens with a house number: digits that may end in a letter or go on after a
  // hyphen or slash, before other words.
  const housed = (text: string) => {
    const each = tokens(text);
    return each.length > 1 && /^\d+(?:\p{L}|[-/]\d+)?$/u.test(each[0] ?? "");
  };
  // The street: the first part with a house number, else the first.
  const street = Math.max(0, parts.findIndex(housed));
  const unitShaped = (part: string) => {
    const each = part.split(" ");
    return part !== "" && each.length <= 2 && each.filter((word) => /[\d#]/u.test(word)).length === 1 && zipOf(part) === "" && !/^\d+ /u.test(part);
  };
  const unitAt = housed(parts[street] ?? "") ? ([street + 1, street - 1].find((index) => index >= 0 && unitShaped(parts[index] ?? "")) ?? -1) : -1;
  const next = parts[unitAt] ?? "";
  const asTyped = (unitAt > street && unitAt === parts.length - 1) || (unitAt >= 0 && unitAt < street);
  const marker = unitAt >= 0 ? null : /^(.*\S)\s*(#\s*[^\s#]+)$/u.exec(parts[street] ?? "");
  const lines = parts.flatMap((part, index) =>
    index === unitAt && !asTyped ? [] : index === street && marker ? [marker[1] ?? ""] : [part],
  );
  const query = lines.join(", ");
  // The retry: the ZIP and a unit asked for as typed left out, joined words split (La Salle for
  // LaSalle) and punctuation other than commas, apostrophes and hyphens dropped.
  const base = lines.filter((_, index) => !asTyped || index !== unitAt).join(", ");
  const zip = zipOf(query);
  const at = zip === "" ? -1 : base.lastIndexOf(zip);
  const tidied = (at < 0 ? base : base.slice(0, at) + base.slice(at + zip.length).replace(/^-\d{4}/u, ""))
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}\s,'-]/gu, " ")
    .split(",")
    .map(squash)
    .filter((part) => part !== "")
    .join(", ");
  return { wanted: squash(address), query, retry: tidied === query ? "" : tidied, unit: next || (marker?.[2] ?? "") };
};

/** The rows one text brought, with PlaceMatch's answer about those that are no control. */
interface Explained {
  readonly labels: readonly string[];
  /** Indexes of the rows that are no control, in the site's order. */
  readonly usable: readonly number[];
  readonly answer: PlaceExplained;
  readonly text: string;
}

const explain = (
  matcher: PlaceMatch,
  wanted: string,
  text: string,
  rows: readonly AddressRow[],
  country: string | undefined,
): Explained => {
  const labels = rows.map((row) => String(row.text ?? "").replace(/\s+/gu, " ").trim());
  // A site's own control for the text, such as one listing more results for it, is no row. Neither
  // is an empty row, nor one longer than PlaceMatch reads, which is no address.
  const usable = labels
    .flatMap((label, index) => (label === "" || label.length > placeMatchLimits.textLength ? [] : [index]))
    .filter((index) => ![wanted, text].some((typed) => matcher.isControl(typed, labels[index] ?? "")))
    .slice(0, placeMatchLimits.rows);
  const answer = matcher.pickExplained(
    wanted,
    usable.map((index) => ({ text: labels[index] ?? "", categorized: rows[index]?.categorized === true })),
    country,
  );
  return { labels, usable, answer, text };
};

/** A text's words, folded, between single spaces. */
const phrase = (text: string) => ` ${foldChoiceText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;

/**
 * The row at `at` of the usable rows, with the unit split off the address for the site's own unit
 * field unless the row shows that unit itself, word for word.
 */
const take = (found: Explained, at: number, unit: string) => {
  const index = found.usable[at] ?? -1;
  const notes = found.answer.rows[at]?.notes ?? [];
  const shown = unit !== "" && phrase(found.labels[index] ?? "").includes(phrase(unit));
  return { index, unit: notes.includes("unit_not_listed") || !shown ? unit : "" };
};

/**
 * The row PlaceMatch takes as the caller's place: of the rows that are, the site's first that keeps
 * the most of the address, such as the caller's unit or state.
 */
const placeRow = (found: Explained, unit: string) =>
  found.answer.outcome === "match" && found.answer.index !== null ? take(found, found.answer.index, unit) : undefined;

/**
 * In a read, with no row that is the caller's place: the row PlaceMatch says a read may take (the
 * categorized venue beside a same-name row); else, for a place's name with no house number, the
 * site's first usable row when it is in the caller's area and does not show the caller's whole text
 * after words of its own, as a control may; else, for a street address, the site's first row with
 * the caller's house, street and town under another postcode.
 */
const readRow = (matcher: PlaceMatch, found: Explained, wanted: string, unit: string, country: string | undefined) => {
  const preferred = found.answer.prefer_on_read;
  if (preferred !== null) return take(found, preferred, unit);
  const label = (at: number) => found.labels[found.usable[at] ?? -1] ?? "";
  if (!/\d/u.test(wanted.split(",")[0] ?? "")) {
    const first = label(0);
    return found.usable.length > 0 && !matcher.showsTypedText(wanted, first) && matcher.inArea(wanted, first, country)
      ? take(found, 0, unit)
      : undefined;
  }
  const at = found.usable.findIndex((_, each) => matcher.sameButPostcode(wanted, label(each), country));
  return at < 0 ? undefined : take(found, at, unit);
};

/**
 * Why no row was taken: `option_missing` when no text brought a usable row, or a read of a street
 * address found none to compare, else `option_unclear` with the rows to ask about as `matches`:
 * those PlaceMatch could not tell apart, or every usable row.
 */
const refusal = (
  found: Explained | undefined,
  available: readonly string[],
  request: ReturnType<typeof addressRequest>,
  read: boolean,
): AddressRefusal => {
  const base = { picked: false as const, wanted: request.wanted, available: [...new Set(available)].slice(0, 100), unit: request.unit };
  if (found === undefined) return { ...base, reason: "option_missing", matches: [] };
  const named = !/\d/u.test(request.wanted.split(",")[0] ?? "");
  if (read && !named && found.answer.outcome === "none") return { ...base, reason: "option_missing", matches: [] };
  const asked = found.answer.outcome === "ambiguous" && found.answer.same.length > 0 ? found.answer.same : found.usable.map((_, at) => at);
  const matches = asked.map((at) => found.labels[found.usable[at] ?? -1] ?? "");
  return { ...base, reason: "option_unclear", matches: [...new Set(matches)].slice(0, 100) };
};

const tooLong = (request: ReturnType<typeof addressRequest>) => request.wanted.length > placeMatchLimits.textLength;

/**
 * Matches an address the caller typed against the rows a site's address list shows now, as
 * `pickerAddressRows` reads them in a Kernel call body: it runs in the script, never on the page.
 * `listed` is that call's answer, `{ rows, read }`, or the rows alone; `options.read` overrides
 * the run's effect the call read, and `options.country` names the address's country when the
 * tool knows it. It returns `{ picked: true, index, label, unit }`, the row to pass to
 * `pickerMatchAddress` in the next call, which clicks it, or a refusal for `pickRefusal`.
 *
 * Matching is PlaceMatch's (third-party/placematch): a row is taken when PlaceMatch says it is the
 * caller's place, the row PlaceMatch takes among such rows, the site's first that keeps the most of
 * the address. A unit the caller gave that the row leaves out is a match, and the unit split off
 * the address is returned as `unit` for the site's own unit field unless the row shows it word for
 * word. Pass `country` when the tool knows the address's country: PlaceMatch reads an address by
 * its country's conventions, and asks more often without one. A site's control that lists more results for
 * the typed text is never a row. In a read, with no row that is the place, it takes the row
 * PlaceMatch says a read may take, such as a categorized venue beside a map pin of the same name;
 * else, for a place's name with no house number, the site's first row when it is in the caller's
 * area and does not show the caller's whole text after words of its own; else, for a street
 * address, the site's first row with the caller's house, street and town under another postcode.
 * Otherwise it refuses: `option_missing` when no row is usable or a read of a street address found
 * no near row, else `option_unclear` with the rows to ask about as `matches`.
 */
export const matchAddress = async (
  address: string,
  listed: readonly (AddressRow | string)[] | { readonly rows: readonly (AddressRow | string)[]; readonly read?: boolean },
  options: AddressMatchOptions = {},
): Promise<AddressMatch> => {
  const given = "rows" in listed ? listed.rows : listed;
  const rows = given.map((row) => (typeof row === "string" ? { text: row } : row));
  const read = options.read ?? ("rows" in listed && listed.read === true);
  const request = addressRequest(String(address ?? ""), foldChoiceText);
  const labels = rows.map((row) => String(row.text ?? "").replace(/\s+/gu, " ").trim()).filter((label) => label !== "");
  if (tooLong(request)) return refusal(undefined, labels, request, read);
  const matcher = await placeMatch();
  const found = explain(matcher, request.wanted, request.query, rows, options.country);
  const available = found.usable.map((index) => found.labels[index] ?? "");
  if (found.usable.length === 0) return refusal(undefined, available, request, read);
  const row = placeRow(found, request.unit) ?? (read ? readRow(matcher, found, request.wanted, request.unit, options.country) : undefined);
  return row === undefined
    ? refusal(found, available, request, read)
    : { picked: true, index: row.index, label: found.labels[row.index] ?? "", unit: row.unit };
};

/**
 * Resolves an address the caller typed through a site's own suggestions, as a person does:
 * `suggest(text)` returns what the site suggests for `text`, such as the predictions of its
 * address lookup request, and `label(item)` reads one as text (`String` by default). Set
 * `options.read` in a read, `options.country` when the tool knows the address's country, and
 * `options.categorized(item)` when the site marks a suggestion with a category of its own, such as
 * a venue type, as it does not for a dropped map pin.
 *
 * It asks for the address with its unit split off (`addressRequest`), and when that brings no
 * suggestion that is the caller's place, once more with the retry text: joined words split, the ZIP
 * and a unit asked for as typed left out, and stray punctuation dropped. Each answer is matched as
 * `matchAddress` matches rows, PlaceMatch deciding which suggestion is the caller's place; in a
 * read with no such suggestion, the read's rules apply to the first text that brought a usable
 * one. It returns the suggestion it accepted, as `choice` and `label`, the text that brought it as
 * `query`, and the unit for the site's own unit field, or `matchAddress`'s refusal, listing every
 * suggestion the site gave as `available`.
 */
export const resolveAddress = async <T = string>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string = String,
  options: AddressMatchOptions & { readonly categorized?: (item: T) => boolean } = {},
): Promise<AddressOutcome<T>> => {
  const read = options.read === true;
  const request = addressRequest(String(address ?? ""), foldChoiceText);
  const texts = [request.query, request.retry].filter((text) => text !== "");
  const seen: string[] = [];
  let first: { readonly found: Explained; readonly items: readonly T[] } | undefined;
  const matcher = tooLong(request) ? undefined : await placeMatch();
  for (const text of texts) {
    const items = [...(await suggest(text))];
    const rows = items.map((item) => ({ text: label(item), categorized: options.categorized?.(item) === true }));
    if (matcher === undefined) {
      seen.push(...rows.map((row) => row.text));
      continue;
    }
    const found = explain(matcher, request.wanted, text, rows, options.country);
    seen.push(...found.usable.map((index) => found.labels[index] ?? ""));
    if (found.usable.length === 0) continue;
    first ??= { found, items };
    const row = placeRow(found, request.unit);
    if (row !== undefined)
      return { picked: true, choice: items[row.index] as T, label: found.labels[row.index] ?? "", query: text, unit: row.unit };
  }
  const taken = read && first !== undefined && matcher !== undefined ? readRow(matcher, first.found, request.wanted, request.unit, options.country) : undefined;
  if (taken === undefined || first === undefined) return refusal(first?.found, seen, request, read);
  return { picked: true, choice: first.items[taken.index] as T, label: first.found.labels[taken.index] ?? "", query: first.found.text, unit: taken.unit };
};
