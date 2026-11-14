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
  // A house number: the first word of the first part that opens with a digit and goes on, read
  // also joined to a one-letter word after it, so 12A and 12 A are one house.
  const tokens = (text: string) =>
    match
      .fold(text)
      .split(" ")
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);
  const houseOf = (text: string) => {
    const part = text.split(",").map(tokens).find((each) => each.length > 1 && /^\d/u.test(each[0] ?? ""));
    if (part === undefined) return [];
    const [number = "", next = ""] = part;
    return next.length === 1 ? [number, number + next] : [number];
  };
  // A unit is the second part, after a first part with a house number and before another part,
  // when it has at most two words, one of them holding a digit or a #, no ZIP, and no plain number
  // opening it before another word, as a street or a town may have; or a # and what follows it
  // ending the first part.
  const second = parts[1] ?? "";
  const secondWords = second.split(" ");
  const unitPart =
    parts.length > 2 &&
    houseOf(parts[0] ?? "").length > 0 &&
    secondWords.length <= 2 &&
    secondWords.filter((word) => /[\d#]/u.test(word)).length === 1 &&
    zipOf(second) === "" &&
    !/^\d+ /u.test(second);
  const marker = unitPart ? null : /^(.*\S)\s*(#\s*[^\s#]+)$/u.exec(parts[0] ?? "");
  const unit = unitPart ? second : (marker?.[2] ?? "");
  const lines = unitPart ? [parts[0] ?? "", ...parts.slice(2)] : marker ? [marker[1] ?? "", ...parts.slice(1)] : parts;
  const query = lines.join(", ");
  const zip = zipOf(query);
  const house = houseOf(query);
  // The caller's place: the parts after the street, ZIP left out, as words. A word counts as kept
  // when a suggestion holds it in one of its usual forms (Illinois for IL), or holds a usual form of
  // its whole part (NY for New York).
  const street = Math.max(0, lines.findIndex((line) => houseOf(line).length > 0));
  const places = lines
    .slice(street + 1)
    .map((part) => squash(part.replace(zipGroups, "")))
    .filter((part) => part !== "")
    .map((part) => ({ forms: match.spellings(part).map(phrase), words: words(part).map((word) => match.spellings(word).map(phrase)) }));
  const total = places.reduce((sum, part) => sum + part.words.length, 0);
  // A suggestion without the caller's house number, or one that reads the caller's ZIP as its
  // house number, is another address: undefined. Any other scores two for each place word it
  // keeps, one for showing the caller's ZIP and minus one for showing another, so one that keeps
  // every place word and shows no other ZIP, which is whole, outscores any other.
  const score = (text: string) => {
    const theirs = houseOf(text);
    const shown = zipOf(text);
    if (house.length > 0 ? !theirs.some((each) => house.includes(each)) : zip !== "" && theirs.includes(zip) && shown !== zip)
      return undefined;
    const have = phrase(text);
    const holds = (forms: readonly string[]) => forms.some((form) => form.trim() !== "" && have.includes(form));
    const kept = places.reduce((sum, part) => sum + (holds(part.forms) ? part.words.length : part.words.filter(holds).length), 0);
    const zipScore = zip === "" || shown === "" ? 0 : shown === zip ? 1 : -1;
    return { value: 2 * kept + zipScore, whole: kept === total && zipScore >= 0 };
  };
  // The street as typed first, then once more tidied, with joined words split (La Salle for
  // LaSalle), the ZIP left out and punctuation other than commas, apostrophes and hyphens dropped,
  // when the first brings no usable suggestion or none that is whole.
  const at = zip === "" ? -1 : query.lastIndexOf(zip);
  const tidied = (at < 0 ? query : query.slice(0, at) + query.slice(at + zip.length).replace(/^-\d{4}/u, ""))
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
    return { picked: false, reason: "option_missing", wanted: squash(address), available: [...new Set(seen)].slice(0, 100), matches: [], unit };
  return { picked: true, choice: best.choice, label: best.label, query: best.query, unit };
};

/**
 * Resolves an address the caller typed through a site's own suggestions, as a person does:
 * `suggest(text)` returns what the site suggests for `text`, such as the predictions of its
 * address lookup request, and `label(item)` reads one as text (`String` by default).
 *
 * It splits off a unit first: the second comma-separated part, after a first part with a house
 * number and before another part, when it has at most two words, one of them holding a digit or a
 * #, no ZIP, and no plain number opening it before another word; or a # and what follows it ending
 * the first part. It returns the unit for the site's own unit field and asks for the rest. A
 * suggestion with another house number than the caller's (the first word of the first part that
 * opens with a digit, 12A and 12 A alike), or that reads a caller's ZIP as its house number, is
 * another address and never usable. Of the rest, it prefers the one that keeps the most of the
 * caller's place, the words after the street in any of their usual forms from `spellingsOf`, then
 * shows the caller's ZIP rather than none or another, then the one the text names most closely
 * (`rankChoices`), then the site's first. When the text brings no usable suggestion, or none that
 * keeps every place word and shows no other ZIP, it asks once more with a tidied text: joined words
 * split, the ZIP left out and stray punctuation dropped. It accepts the best suggestion either text
 * brought, so the tool reports the site's version as it does any rewrite, and refuses only when
 * neither brought a usable one, with `picked: false` and every suggestion the site gave as
 * `available`, for `pickRefusal`. It keeps no list of words or addresses of its own.
 */
export const resolveAddress = <T = string>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string = String,
): Promise<AddressOutcome<T>> =>
  resolveAddressWith(address, suggest, label, { fold: foldChoiceText, spellings: spellingsOf, rank: rankChoices });
