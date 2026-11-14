import { foldChoiceText, sameText, spellingsOf } from "../runtime/text.js";
import { rankChoices } from "./picker-rank.js";

/**
 * What `resolveAddress` accepted: the site's suggestion as `suggest` gave it (`choice`) and as
 * `label` reads it, the text that brought it (`query`) and the unit split off the caller's
 * address (`unit`, "" for none). Or, when no text brought a usable suggestion, a refusal that
 * `pickRefusal` takes, listing every suggestion the site gave as `available`.
 */
export type AddressOutcome<T> =
  | {
      readonly picked: true;
      readonly choice: T;
      readonly label: string;
      readonly query: string;
      readonly unit: string;
    }
  | {
      readonly picked: false;
      readonly reason: "option_missing";
      readonly wanted: string;
      readonly available: readonly string[];
      readonly matches: readonly string[];
      readonly unit: string;
    };

/**
 * `resolveAddress` with its matching passed in. It is pure and self-contained: the page code of
 * `pickerCode` embeds this same function with the picker's own fold, spellings and ranking.
 */
export const resolveAddressWith = async <T>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string,
  match: {
    readonly fold: (text: string) => string;
    readonly spellings: (text: string) => readonly string[];
    readonly rank: typeof rankChoices;
    readonly same: typeof sameText;
  },
): Promise<AddressOutcome<T>> => {
  const squash = (text: unknown) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const words = (text: string) => match.fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrase = (text: string) => " " + words(text).join(" ") + " ";
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
  // A house number: the first word of the first part that opens with one, digits that may end in a
  // letter or go on after a hyphen or slash, and goes on; read also joined to a one-letter word
  // after it, so 12A and 12 A are one house.
  const tokens = (text: string) =>
    match
      .fold(text)
      .split(" ")
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);
  const houseOf = (text: string) => {
    const part = text.split(",").map(tokens).find((each) => each.length > 1 && /^\d+(?:\p{L}|[-/]\d+)?$/u.test(each[0] ?? ""));
    if (part === undefined) return [];
    const [number = "", next = ""] = part;
    return next.length === 1 ? [number, number + next] : [number];
  };
  // The street: the first part with a house number, else the first.
  const streetOf = (list: readonly string[]) => Math.max(0, list.findIndex((part) => houseOf(part).length > 0));
  // A unit is the part right after a street with a house number, else the part right before it,
  // when it has at most two words, one of them holding a digit or a #, no ZIP, and no plain number
  // opening it before another word, as a street or a town may have; or a # and what follows it
  // ending the street. Such a part may be a town and postcode, or a street, instead, so it is the
  // unit only when the suggestion taken keeps none of its words, and one before the street or ending
  // the address is asked for as typed first and left out of the retry.
  const street = streetOf(parts);
  const unitShaped = (part: string) => {
    const each = part.split(" ");
    return part !== "" && each.length <= 2 && each.filter((word) => /[\d#]/u.test(word)).length === 1 && zipOf(part) === "" && !/^\d+ /u.test(part);
  };
  const unitAt =
    houseOf(parts[street] ?? "").length > 0 ? ([street + 1, street - 1].find((index) => index >= 0 && unitShaped(parts[index] ?? "")) ?? -1) : -1;
  const next = parts[unitAt] ?? "";
  const last = unitAt > street && unitAt === parts.length - 1;
  const asTyped = last || (unitAt >= 0 && unitAt < street);
  const marker = unitAt >= 0 ? null : /^(.*\S)\s*(#\s*[^\s#]+)$/u.exec(parts[street] ?? "");
  const lines = parts.flatMap((part, index) =>
    index === unitAt && !asTyped ? [] : index === street && marker ? [marker[1] ?? ""] : [part],
  );
  const query = lines.join(", ");
  const zip = zipOf(query);
  const house = houseOf(query);
  // The caller's place: the parts after the street, ZIP left out, as words. A word counts as kept
  // when a suggestion's parts after its own street hold it in one of its usual forms (Illinois for
  // IL), or hold a usual form of its whole part (NY for New York).
  const toPlace = (part: string) => ({
    forms: match.spellings(part).map(phrase),
    words: words(part).map((word) => match.spellings(word).map(phrase)),
  });
  const lineStreet = streetOf(lines);
  const places = lines
    .slice(lineStreet + 1, last ? -1 : undefined)
    .map((part) => squash(part.replace(zipGroups, "")))
    .filter((part) => part !== "")
    .map(toPlace);
  const unitPlace = next === "" ? [] : [toPlace(next)];
  const total = places.reduce((sum, part) => sum + part.words.length, 0);
  // Joined words split (La Salle for LaSalle) and punctuation other than commas, apostrophes and
  // hyphens dropped.
  const tidy = (text: string) =>
    text
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .replace(/[^\p{L}\p{N}\s,'-]/gu, " ")
      .split(",")
      .map(squash)
      .filter((part) => part !== "")
      .join(", ");
  // The caller's street words of two letters or more, its house number left out, as typed and as
  // tidied. A suggestion's street keeps one when it holds one of its usual forms (Street for St), or
  // either is written short for the other (Blvd for Boulevard), word by word.
  const streetForms = [...new Set([lines[lineStreet] ?? "", tidy(lines[lineStreet] ?? "")])].map((text) =>
    words(text).filter((word) => word.length > 1 && !house.includes(word)),
  );
  const sameWord = (want: string, have: string) =>
    match.spellings(want).some((form) => match.fold(form) === have) || match.same(have, want) || match.same(want, have);
  // A suggestion's street, its parts after the street, and its parts but the street.
  const sides = (text: string) => {
    const split = text.split(",");
    const at = streetOf(split);
    return {
      street: split[at] ?? "",
      after: phrase(split.length > 1 ? split.slice(at + 1).join(",") : text),
      others: phrase(split.length > 1 ? split.filter((_, index) => index !== at).join(",") : ""),
    };
  };
  const holds = (forms: readonly string[], within: string) => forms.some((form) => form.trim() !== "" && within.includes(form));
  const keeps = (list: readonly ReturnType<typeof toPlace>[], within: string) =>
    list.reduce((sum, part) => sum + (holds(part.forms, within) ? part.words.length : part.words.filter((each) => holds(each, within)).length), 0);
  // A suggestion with another house number, or one that reads the caller's ZIP as its house number,
  // is another address: undefined. Any other ranks first by the share of the caller's street words
  // its own street keeps, then by showing the caller's ZIP, then by the place words, a unit-shaped
  // part's included, it keeps after its own street, then by showing no other ZIP. It is whole when
  // its street keeps any of the caller's street words, it keeps every place word, not counting a
  // unit-shaped part, and it shows no other ZIP.
  const score = (text: string) => {
    const theirs = houseOf(text);
    const shown = zipOf(text);
    if (house.length > 0 ? !theirs.some((each) => house.includes(each)) : zip !== "" && theirs.includes(zip) && shown !== zip)
      return undefined;
    const { after, street: own } = sides(text);
    const ownWords = words(own).filter((word) => word.length > 1);
    const share = Math.max(
      0,
      ...streetForms.map((list) =>
        list.length === 0 ? 0 : list.filter((want) => ownWords.some((have) => sameWord(want, have))).length / list.length,
      ),
    );
    const kept = keeps(places, after);
    const all = kept + keeps(unitPlace, after);
    const other = zip !== "" && shown !== "" && shown !== zip;
    const same = zip !== "" && shown === zip;
    return {
      value: Math.round(share * 1000) * 1_000_000 + (same ? 10_000 : 0) + 100 * all - (other ? 50 : 0),
      whole: share > 0 && kept === total && !other,
    };
  };
  // The street as typed first, then once more tidied, with the ZIP and a unit asked for as typed
  // left out, when the first brings no usable suggestion or none that is whole.
  const base = lines.filter((_, index) => !asTyped || index !== unitAt).join(", ");
  const at = zip === "" ? -1 : base.lastIndexOf(zip);
  const tidied = tidy(at < 0 ? base : base.slice(0, at) + base.slice(at + zip.length).replace(/^-\d{4}/u, ""));
  const seen: string[] = [];
  let best: { readonly choice: T; readonly label: string; readonly query: string; readonly value: number } | undefined;
  for (const text of [...new Set([query, tidied])].filter((form) => form !== "")) {
    const items = [...(await suggest(text))];
    const labels = items.map((item) => squash(label(item)));
    seen.push(...labels.filter((name) => name !== ""));
    const scores = labels.map((name) => (name === "" ? undefined : score(name)));
    const top = Math.max(-Infinity, ...scores.flatMap((each) => (each === undefined ? [] : [each.value])));
    if (top === -Infinity) continue;
    // Among the best, the one the typed text names most closely, else the site's first.
    const tied = scores.flatMap((each, index) => (each?.value === top ? [index] : []));
    const ranking = match.rank(
      tied.map((index) => ({ names: [labels[index] ?? ""], value: "", disabled: false, key: String(index) })),
      [text],
      match.fold,
      { spellings: match.spellings },
    );
    const pick = tied[ranking.status === "picked" ? ranking.index : ranking.status === "ambiguous" ? (ranking.indexes[0] ?? 0) : 0] ?? 0;
    if (best === undefined || top > best.value)
      best = { choice: items[pick] as T, label: labels[pick] ?? "", query: text, value: top };
    if (scores[pick]?.whole === true) break;
  }
  if (best === undefined)
    return { picked: false, reason: "option_missing", wanted: squash(address), available: [...new Set(seen)].slice(0, 100), matches: [], unit: next || (marker?.[2] ?? "") };
  // A unit-shaped part the suggestion keeps, its number outside the suggestion's own street, was a
  // town and postcode or a street rather than a unit.
  const number = phrase(next.split(" ").find((word) => /[\d#]/u.test(word)) ?? "");
  const unit = next !== "" && !holds([number], sides(best.label).others) ? next : (marker?.[2] ?? "");
  return { picked: true, choice: best.choice, label: best.label, query: best.query, unit };
};

/**
 * Resolves an address the caller typed through a site's own suggestions, as a person does:
 * `suggest(text)` returns what the site suggests for `text`, such as the predictions of its
 * address lookup request, and `label(item)` reads one as text (`String` by default).
 *
 * It splits off a unit first: the part right after a street with a house number, else the part
 * right before it, when it has at most two words, one of them holding a digit or a #, no ZIP, and
 * no plain number opening it before another word; or a # and what follows it ending the street. It
 * asks for the rest, and returns the unit for the site's own unit field unless the suggestion
 * taken keeps its number outside its own street, as a town and postcode or a street would be; such
 * a part before the street or ending the address is asked for as typed first. For an address whose
 * street opens with its house number, a suggestion with another one (12A and 12 A alike) is
 * another address and never usable, and so is one that reads a caller's ZIP as its house number.
 * Of the rest, it prefers the one whose own street keeps the largest share of the caller's street
 * words of two letters or more, as typed or tidied, each in its usual forms from `spellingsOf` or
 * written short for the other either way (`sameText`), so a direction letter the site adds or
 * drops makes no difference; then the one that shows the caller's ZIP; then the one whose parts
 * after its street keep the most words of the caller's place, the words after the street in any of
 * their usual forms; then one that shows no other ZIP; then the one the text names most closely
 * (`rankChoices`); then the site's first. When the text brings no usable suggestion, or none that
 * keeps any of the caller's street words and every place word and shows no other ZIP, it asks once
 * more with a tidied text: joined words split, the ZIP and a unit asked for as typed left out, and
 * stray punctuation dropped. It accepts the best suggestion either text brought, so the tool
 * reports the site's version as it does any rewrite, and refuses only when neither brought a
 * usable one, with `picked: false` and every suggestion the site gave as `available`, for
 * `pickRefusal`. It keeps no list of words or addresses of its own.
 */
export const resolveAddress = <T = string>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string = String,
): Promise<AddressOutcome<T>> =>
  resolveAddressWith(address, suggest, label, { fold: foldChoiceText, spellings: spellingsOf, rank: rankChoices, same: sameText });
