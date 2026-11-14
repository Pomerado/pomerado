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
  // A unit is the second part when it has one word holding a digit or a #, no ZIP, and no plain
  // number opening it before other words, as a street or a town may have; or a # and what follows
  // it ending the first part.
  const second = parts[1] ?? "";
  const unitPart =
    second.split(" ").filter((word) => /[\d#]/u.test(word)).length === 1 && zipOf(second) === "" && !/^\d+ /u.test(second);
  const marker = unitPart ? null : /^(.*\S)\s*(#\s*[^\s#]+)$/u.exec(parts[0] ?? "");
  const unit = unitPart ? second : (marker?.[2] ?? "");
  const lines = unitPart ? [parts[0] ?? "", ...parts.slice(2)] : marker ? [marker[1] ?? "", ...parts.slice(1)] : parts;
  const query = lines.join(", ");
  const zip = zipOf(query);
  // The caller's place: the last part after the street, its ZIP left out, such as a state or town,
  // in each of its usual forms, such as a state's code and name.
  const place = lines.slice(1).map((part) => squash(part.replace(zipGroups, ""))).filter((part) => part !== "").at(-1);
  const places = place === undefined ? [] : match.spellings(place).map(phrase).filter((form) => form.trim() !== "");
  // The house number: the street's first word, when it holds a digit.
  const first = words(lines[0] ?? "")[0];
  const house = first !== undefined && /\d/u.test(first) ? first : undefined;
  // A suggestion without the caller's house number is another address, never usable (-1). Of the
  // rest, one that shows the caller's ZIP and holds the place scores 4; a ZIP it doesn't show
  // costs 1 and another ZIP 2, and a place it lacks 2.
  const score = (text: string) => {
    if (house !== undefined && !words(text).includes(house)) return -1;
    const shown = zipOf(text);
    return (zip === "" || shown === zip ? 2 : shown === "" ? 1 : 0) + (places.length === 0 || places.some((form) => phrase(text).includes(form)) ? 2 : 0);
  };
  // The street as typed first, then once more tidied, with joined words split (La Salle for
  // LaSalle), the ZIP left out and punctuation other than commas, apostrophes and hyphens dropped,
  // when the first brings nothing usable or nothing that keeps the caller's ZIP and place.
  const at = zip === "" ? -1 : query.lastIndexOf(zip);
  const tidied = (at < 0 ? query : query.slice(0, at) + query.slice(at + zip.length).replace(/^-\d{4}/u, ""))
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}\s,'-]/gu, " ")
    .split(",")
    .map(squash)
    .filter((part) => part !== "")
    .join(", ");
  const seen: string[] = [];
  let best: { readonly choice: T; readonly label: string; readonly query: string; readonly score: number } | undefined;
  for (const text of [...new Set([query, tidied])].filter((form) => form !== "")) {
    const items = [...(await suggest(text))];
    const labels = items.map((item) => squash(label(item)));
    seen.push(...labels.filter((name) => name !== ""));
    const scores = labels.map((name) => (name === "" ? -1 : score(name)));
    const top = Math.max(-1, ...scores);
    if (top < 0) continue;
    // Among the best, the one the typed text names most closely, else the site's first.
    const tied = scores.flatMap((each, index) => (each === top ? [index] : []));
    const ranking = match.rank(
      tied.map((index) => ({ names: [labels[index] ?? ""], value: "", disabled: false, key: String(index) })),
      [text],
      match.fold,
      { spellings: match.spellings },
    );
    const pick = tied[ranking.status === "picked" ? ranking.index : ranking.status === "ambiguous" ? (ranking.indexes[0] ?? 0) : 0] ?? 0;
    if (best === undefined || top > best.score)
      best = { choice: items[pick] as T, label: labels[pick] ?? "", query: text, score: top };
    if (top === 4) break;
  }
  if (best === undefined)
    return { picked: false, reason: "option_missing", wanted: squash(address), available: [...new Set(seen)].slice(0, 100), matches: [], unit };
  return { picked: true, choice: best.choice, label: best.label, query: best.query, unit };
};

/**
 * Resolves an address the caller typed through a site's own suggestions, as a person does:
 * `suggest(text)` returns what the site suggests for `text`, such as the predictions of its
 * address lookup request, and `label(item)` reads one as text (`String` by default).
 *
 * It splits off a unit first: the second comma-separated part when it has one word holding a
 * digit or a #, no ZIP, and no plain number opening it before other words, or a # and what follows
 * it ending the first part. It returns the unit for the site's own unit field and asks for the
 * rest. A suggestion lacking the caller's house number is another address and never usable. Of
 * the rest, it prefers one that keeps the caller's ZIP and place (the last part after the street,
 * such as a state, in any of its usual forms from `spellingsOf`), then one that shows no other
 * ZIP, then the one the text names most closely (`rankChoices`), then the site's first. When the
 * text brings nothing usable, or nothing that keeps the ZIP and place, it asks once more with a
 * tidied text: joined words split, the ZIP left out and stray punctuation dropped. It accepts the
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
