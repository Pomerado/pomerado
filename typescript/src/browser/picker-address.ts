import { foldChoiceText, spellingsOf } from "../runtime/text.js";
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
  // A unit is the part right after a street with a house number when it has at most two words, one
  // of them holding a digit or a #, no ZIP, and no plain number opening it before another word, as a
  // street or a town may have; or a # and what follows it ending the street. A unit-shaped last
  // part may be a town and postcode instead: it is asked for as typed, left out of the retry, and
  // is the unit only when the suggestion taken keeps none of its words.
  const street = streetOf(parts);
  const next = houseOf(parts[street] ?? "").length > 0 ? (parts[street + 1] ?? "") : "";
  const nextWords = next.split(" ");
  const unitShaped =
    nextWords.length <= 2 &&
    nextWords.filter((word) => /[\d#]/u.test(word)).length === 1 &&
    zipOf(next) === "" &&
    !/^\d+ /u.test(next);
  const lastUnit = unitShaped && street + 2 === parts.length;
  const marker = unitShaped ? null : /^(.*\S)\s*(#\s*[^\s#]+)$/u.exec(parts[street] ?? "");
  const lines = parts.flatMap((part, index) =>
    unitShaped && !lastUnit && index === street + 1 ? [] : index === street && marker ? [marker[1] ?? ""] : [part],
  );
  const typedUnit = unitShaped && !lastUnit ? next : (marker?.[2] ?? "");
  const query = lines.join(", ");
  const zip = zipOf(query);
  const house = houseOf(query);
  // The caller's place: the parts after the street, ZIP left out, as words. A word counts as kept
  // when a suggestion's parts after its own street hold it in one of its usual forms (Illinois for
  // IL), or hold a usual form of its whole part (NY for New York).
  const places = lines
    .slice(street + 1)
    .map((part) => squash(part.replace(zipGroups, "")))
    .filter((part) => part !== "")
    .map((part) => ({ forms: match.spellings(part).map(phrase), words: words(part).map((word) => match.spellings(word).map(phrase)) }));
  const total = places.reduce((sum, part) => sum + part.words.length, 0);
  // The street's own words, its house number left out, each in its usual forms (Street for St).
  const streetWords = words(lines[street] ?? "")
    .filter((word) => !house.includes(word))
    .map((word) => match.spellings(word).map(phrase));
  // A suggestion with another house number, or one that reads the caller's ZIP as its house number,
  // is another address: undefined. Any other scores the place words it keeps, half more for showing
  // the caller's ZIP, and below any that shows no other ZIP when it shows another; then, among
  // equals, the street words its own street keeps. It is whole when it keeps every place word, or
  // the place is only a unit-shaped part, and shows no other ZIP.
  const score = (text: string) => {
    const theirs = houseOf(text);
    const shown = zipOf(text);
    if (house.length > 0 ? !theirs.some((each) => house.includes(each)) : zip !== "" && theirs.includes(zip) && shown !== zip)
      return undefined;
    const split = text.split(",");
    const at = streetOf(split);
    const have = phrase(split.length > 1 ? split.slice(at + 1).join(",") : text);
    const road = phrase(split[at] ?? "");
    const holds = (forms: readonly string[], within = have) => forms.some((form) => form.trim() !== "" && within.includes(form));
    const kept = places.reduce((sum, part) => sum + (holds(part.forms) ? part.words.length : part.words.filter((each) => holds(each)).length), 0);
    const other = zip !== "" && shown !== "" && shown !== zip;
    return {
      value: 100 * (other ? kept - total - 1 : kept + (zip !== "" && shown === zip ? 0.5 : 0)) + streetWords.filter((each) => holds(each, road)).length,
      whole: (lastUnit || kept === total) && !other,
    };
  };
  // The street as typed first, then once more tidied, with joined words split (La Salle for
  // LaSalle), the ZIP left out and punctuation other than commas, apostrophes and hyphens dropped,
  // when the first brings no usable suggestion or none that is whole.
  const base = (lastUnit ? lines.slice(0, -1) : lines).join(", ");
  const at = zip === "" ? -1 : base.lastIndexOf(zip);
  const tidied = (at < 0 ? base : base.slice(0, at) + base.slice(at + zip.length).replace(/^-\d{4}/u, ""))
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}\s,'-]/gu, " ")
    .split(",")
    .map(squash)
    .filter((part) => part !== "")
    .join(", ");
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
    return { picked: false, reason: "option_missing", wanted: squash(address), available: [...new Set(seen)].slice(0, 100), matches: [], unit: lastUnit ? next : typedUnit };
  const taken = words(best.label);
  const unit = lastUnit && !words(next).some((word) => taken.includes(word)) ? next : typedUnit;
  return { picked: true, choice: best.choice, label: best.label, query: best.query, unit };
};

/**
 * Resolves an address the caller typed through a site's own suggestions, as a person does:
 * `suggest(text)` returns what the site suggests for `text`, such as the predictions of its
 * address lookup request, and `label(item)` reads one as text (`String` by default).
 *
 * It splits off a unit first: the part right after a street with a house number, when it has at
 * most two words, one of them holding a digit or a #, no ZIP, and no plain number opening it before
 * another word; or a # and what follows it ending the street. It returns the unit for the site's
 * own unit field and asks for the rest. Such a part that ends the address may be a town and
 * postcode instead, so it is asked for as typed and is the unit only when the suggestion taken
 * keeps none of its words. For an address whose street opens with its house number, a suggestion
 * with another one (12A and 12 A alike) is another address and never usable, and so is one that
 * reads a caller's ZIP as its house number. Of the rest, it prefers the one whose parts after its
 * street keep the most words of the caller's place, the words after the street in any of their
 * usual forms from `spellingsOf`, ranking one that shows another ZIP below the others and one that
 * shows the caller's ZIP above its equals; then the one whose street keeps the most words of the
 * caller's street; then the one the text names most closely
 * (`rankChoices`); then the site's first. When the text brings no usable suggestion, or none that
 * keeps every place word and shows no other ZIP, it asks once more with a tidied text: joined words
 * split, the ZIP and a unit-shaped last part left out and stray punctuation dropped. It accepts the
 * best suggestion either text brought, so the tool reports the site's version as it does any
 * rewrite, and refuses only when neither brought a usable one, with `picked: false` and every
 * suggestion the site gave as `available`, for `pickRefusal`. It keeps no list of words or
 * addresses of its own.
 */
export const resolveAddress = <T = string>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string = String,
): Promise<AddressOutcome<T>> =>
  resolveAddressWith(address, suggest, label, { fold: foldChoiceText, spellings: spellingsOf, rank: rankChoices });
