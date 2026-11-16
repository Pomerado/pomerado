import { foldChoiceText, spellingsOf } from "../runtime/text.js";
import { rankChoices } from "./picker-rank.js";

/**
 * What `resolveAddress` accepted: the site's suggestion as `suggest` gave it (`choice`) and as
 * `label` reads it, the text that brought it (`query`) and the unit split off the caller's
 * address (`unit`, "" for none). Or a refusal that `pickRefusal` takes, listing every suggestion
 * the site gave as `available`: `option_missing` when no text brought a usable suggestion, or
 * `option_unclear`, with the usable ones as `matches`, when the best keeps the address only in part.
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
      readonly reason: "option_missing" | "option_unclear";
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
    readonly spellings: (text: string, options?: { readonly places?: "end" | "after-words" | "never" }) => readonly string[];
    readonly rank: typeof rankChoices;
  },
  options: { readonly read?: boolean } = {},
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
  const toPlace = (part: string, places: "end" | "never" = "end") => ({
    forms: match.spellings(part, { places }).map(phrase),
    words: words(part).map((word) => match.spellings(word, { places }).map(phrase)),
  });
  const lineStreet = streetOf(lines);
  const placeParts = lines
    .slice(lineStreet + 1, last ? -1 : undefined)
    .map((part) => squash(part.replace(zipGroups, "")))
    .filter((part) => words(part).length > 0);
  const places = placeParts.map((part) => toPlace(part));
  // Whether a text is a place's code or name: it has no other form anywhere, but has one as a place
  // that shares none of its words (Illinois for IL, WV for West Virginia).
  const isPlace = (text: string) =>
    match.spellings(text, { places: "never" }).length === 1 && match.spellings(text).some((form) => words(form).every((word) => !words(text).includes(word)));
  // How a part ends in a place: after other words, a place's code or two-word name, split off as its
  // own field, so a town and state in one part are two; the part itself a place; or a place's
  // one-word name after other words, kept in one field that adds two when left out.
  const ending = (part: string) => {
    const each = words(part);
    if (each.length > 1 && (each.at(-1) ?? "").length === 2 && isPlace(each.at(-1) ?? "")) return { split: 1, adds: 1 };
    if (isPlace(part)) return { split: 0, adds: 1 };
    if (each.length > 2 && isPlace(each.slice(-2).join(" "))) return { split: 2, adds: 1 };
    return each.length > 1 && isPlace(each.at(-1) ?? "") ? { split: 0, adds: 2 } : undefined;
  };
  // The caller's place as fields, each with the count it adds when left out. The state's part is the
  // last one that ends in a place, else the last; only it reads a place's other forms, so a town
  // named as a state is not kept by that state's code.
  const endings = placeParts.map(ending);
  const stateAt = endings.some(Boolean) ? endings.map(Boolean).lastIndexOf(true) : placeParts.length - 1;
  const fields = placeParts.flatMap((part, index) => {
    const end = index === stateAt ? endings[index] : undefined;
    const each = words(part);
    return end !== undefined && end.split > 0
      ? [{ ...toPlace(each.slice(0, -end.split).join(" "), "never"), adds: 1 }, { ...toPlace(each.slice(-end.split).join(" ")), adds: 1 }]
      : [{ ...toPlace(part, index === stateAt ? "end" : "never"), adds: end?.adds ?? 1 }];
  });
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
  // tidied. A suggestion's street keeps one when it holds the word in one of its usual forms (Street
  // for St).
  const streetForms = [...new Set([lines[lineStreet] ?? "", tidy(lines[lineStreet] ?? "")])].map((text) =>
    words(text)
      .filter((word) => word.length > 1 && !house.includes(word))
      .map((word) => match.spellings(word).map((form) => match.fold(form))),
  );
  // The caller's street name: those words but the last, a street type such as Ave, when there is
  // another, of three letters or more, so St or Ave ending the street or a direction letter alone
  // never keeps it; and every word of the street holding a digit, as the 9 of Route 9, but the
  // house number's own. A number reads without its ordinal ending, so 107 keeps 107th.
  const numeral = (word: string) => word.replace(/^(\d+)(?:st|nd|rd|th)$/u, "$1");
  const houseWords = house.flatMap(words);
  const names = streetForms
    .flatMap((list) => (list.length > 1 ? list.slice(0, -1) : list).filter((forms) => (forms[0] ?? "").length > 2))
    .concat(words(lines[lineStreet] ?? "").filter((word) => /\d/u.test(word) && !houseWords.includes(word)).map((word) => [word]))
    .map((forms) => forms.map(numeral));
  // A street's words but its house number's, numbers without their ordinal ending.
  const streetWords = (text: string) => words(text).filter((word) => !houseWords.includes(word)).map(numeral);
  const callerWords = streetWords(lines[lineStreet] ?? "");
  // A street's direction words in order, each as its letters (N for North, NW for N.W. or
  // Northwest), and its own number, its first but the house number's, read in its usual forms (5 for
  // Fifth), once its ZIP is left out and, from its end, the other side's places after its street,
  // last first, each in any of its usual forms, unless its own side shows that place, in any of its
  // forms, after its street (`shown`), as a street may run on into its town.
  const compass = /^(?:[nsew]|[ns][ew]|north|south|east|west|(?:north|south)(?:east|west))$/u;
  const bearing = (street: string, after: readonly (readonly string[])[], shown: string) => {
    let rest = phrase(street.replace(zipGroups, "").replace(/(?<![\p{L}\p{N}])([ns])\.\s*([ew])\./giu, "$1$2"));
    for (const forms of [...after].reverse()) {
      if (forms.some((form) => form.trim() !== "" && shown.includes(form))) continue;
      const end = forms.find((form) => form.trim() !== "" && rest.endsWith(form));
      if (end !== undefined) rest = rest.slice(0, -end.length) + " ";
    }
    const each = streetWords(rest);
    return {
      way: each.filter((word) => compass.test(word)).map((word) => word.replace(/north|south|east|west/gu, (part) => part[0] ?? "")).join(" "),
      number: each.map((word) => match.spellings(word).map(numeral).find((form) => /\d/u.test(form)) ?? "").find((form) => form !== "") ?? "",
    };
  };
  // The caller's places after their street, each whole, and without its last word when that word is
  // written another way, as a state's code is, so a town and state in one part are read as two; and
  // the text after their street.
  const placeForms = places.flatMap((part) =>
    part.words.length > 1 && (part.words.at(-1)?.length ?? 0) > 1
      ? [part.forms, match.spellings(part.words.slice(0, -1).map((forms) => (forms[0] ?? "").trim()).join(" ")).map(phrase)]
      : [part.forms],
  );
  const callerAfter = phrase(lines.slice(lineStreet + 1).join(" "));
  // Two streets' names are close when the numbers both show agree and, with their words of two
  // letters or more joined, the last left out when there is another, fewer edits than a third of
  // the shorter's letters, a swap of two letters one edit, turn one into the other (Exampel or Mian
  // for Example or Main, LaSalle for La Salle); or when a word of three letters or more of one is
  // among the first letters of the other's words but the last (MLK for Dr Martin Luther King Jr
  // Blvd).
  const close = (one: readonly string[], two: readonly string[]) => {
    const numbers = (list: readonly string[]) => list.filter((word) => /\d/u.test(word)).join(" ");
    if (numbers(one) !== "" && numbers(two) !== "" && numbers(one) !== numbers(two)) return false;
    const name = (list: readonly string[]) => {
      const kept = list.filter((word) => word.length > 1);
      return kept.length > 1 ? kept.slice(0, -1) : kept;
    };
    const [a, b] = [name(one).join(""), name(two).join("")];
    let [before, row] = [[] as number[], Array.from({ length: b.length + 1 }, (_, index) => index)];
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        const swap = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? (before[j - 2] ?? 0) + 1 : Infinity;
        next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1), swap));
      }
      [before, row] = [row, next];
    }
    const initials = (list: readonly string[]) => (list.length > 1 ? list.slice(0, -1) : list).map((word) => word[0]).join("");
    return (
      (row[b.length] ?? 0) * 3 < Math.min(a.length, b.length) ||
      name(one).some((word) => word.length > 2 && initials(two).includes(word)) ||
      name(two).some((word) => word.length > 2 && initials(one).includes(word))
    );
  };
  // A suggestion's street; its parts after the street, as words (its whole text when it has no
  // comma, and none in `beyond`) and each in its usual forms; its parts but the street; and the words
  // of each of its parts after the street, ZIPs left out.
  const sides = (text: string) => {
    const split = text.split(",");
    const at = streetOf(split);
    return {
      street: split[at] ?? "",
      after: phrase(split.length > 1 ? split.slice(at + 1).join(",") : text),
      beyond: phrase(split.slice(at + 1).join(" ")),
      beyondForms: split.slice(at + 1).map((part) => match.spellings(squash(part.replace(zipGroups, ""))).map(phrase)),
      others: phrase(split.length > 1 ? split.filter((_, index) => index !== at).join(",") : ""),
      rest: split.slice(at + 1).map((part) => words(part.replace(zipGroups, " "))),
    };
  };
  // The words of the caller's unit.
  const unitWords = [next, marker?.[2] ?? ""].flatMap(words);
  // A word written short for another: one to four letters with no vowel (a, e, i, o, u or y), at
  // least two fewer, starting with its first letter and holding the rest of its letters in order.
  const short = (brief: string, full: string) => {
    if (!/^[b-df-hj-np-tv-xz]{1,4}$/u.test(brief) || full.length < brief.length + 2 || full[0] !== brief[0]) return false;
    let at = 0;
    return [...brief].every((letter) => (at = full.indexOf(letter, at) + 1) > 0);
  };
  // A suggestion street's words that the caller's street words but the house number's leave over,
  // each caller's word taken once: first as written or in its usual forms, then written short for
  // it, or as a direction spelled out for its letter.
  const streetTokens = words(lines[lineStreet] ?? "")
    .filter((word) => !houseWords.includes(word))
    .map((word) => [...new Set([word, ...match.spellings(word).flatMap(words)].map(numeral))]);
  const spare = (list: readonly string[]) => {
    const unused = [...streetTokens];
    const take = (fits: (word: string, form: string) => boolean) => (word: string) => {
      const at = unused.findIndex((forms) => forms.some((form) => fits(numeral(word), form)));
      if (at >= 0) unused.splice(at, 1);
      return at < 0;
    };
    return list.filter(take((word, form) => word === form)).filter(take((word, form) => short(word, form) || (compass.test(word) && short(form, word))));
  };
  const holds = (forms: readonly string[], within: string) => forms.some((form) => form.trim() !== "" && within.includes(form));
  const keeps = (list: readonly ReturnType<typeof toPlace>[], within: string) =>
    list.reduce((sum, part) => sum + (holds(part.forms, within) ? part.words.length : part.words.filter((each) => holds(each, within)).length), 0);
  // A suggestion with another house number, one whose street keeps none of the caller's street name
  // words and whose name is not close to the caller's or shows another ZIP, or one that reads the
  // caller's ZIP as its house number, is another address: undefined.
  // Any other ranks, in order, by showing the caller's ZIP while its own street keeps more than half
  // the caller's street words; by the place words, a unit-shaped part's included, it keeps after its
  // own street; by the share of the caller's street words its street keeps; and by showing no other
  // ZIP. It is on the caller's street when the caller gave no house number, or when its street's
  // directions are the caller's street's, in order, and its own number is the caller's street's when
  // both show one, each read past the other side's places that run on from its street. It is whole
  // when it is on the caller's street, its street keeps any of the caller's street words, it keeps
  // every place word, not counting a unit-shaped part, and it shows no other ZIP. It is clean when
  // it is on the caller's street and keeps the address field by field: its street keeps a word of
  // the caller's street, or of its name; its parts after its street and its street's words that the
  // caller's street leaves over, as a suggestion whose lines were joined may hold its town in its
  // street's part, keep each field, or leave out one, only when each of those words of two letters
  // or more, but a ZIP, is taken by a field or is the unit's; it holds no field in part; what the
  // fields it leaves out add, and a ZIP it shows none of, comes to at most one; and it shows no
  // other ZIP, unless `read` is set and the caller gave a house number and a place. Or it is on the
  // caller's street and shows the caller's ZIP on a street that keeps more than half the caller's
  // street words, or the caller's ZIP when that is all they gave. It is loose when it leaves out a
  // place field and shows no caller's ZIP, and then counts as clean only when no other ties with it,
  // nor holds every field it holds on the caller's street with no word of its street left over.
  // A clean one ranks above any other.
  const score = (text: string) => {
    const theirs = houseOf(text);
    const shown = zipOf(text);
    if (house.length > 0 ? !theirs.some((each) => house.includes(each)) : zip !== "" && theirs.includes(zip) && shown !== zip)
      return undefined;
    const { after, street: own, beyond, beyondForms, rest } = sides(text);
    const ownWords = words(own);
    const other = zip !== "" && shown !== "" && shown !== zip;
    // Its street's words but its house number's and those the caller's street keeps, then the words
    // of each part after its street, each with its part. A field is kept when one of its forms sits
    // there whole, its words side by side in one part at places no field before it took; held in part
    // when only some of its words sit there; else left out, adding its count.
    const extra = spare(words(own.replace(zipGroups, " ")).filter((word) => !theirs.flatMap(words).includes(word)));
    const onward = [extra, ...rest].flatMap((list, part) => list.map((word) => ({ word, part })));
    const taken = new Set<number>();
    const find = (form: string) => {
      const list = words(form);
      const at = onward.findIndex(
        (first, start) =>
          list.length > 0 &&
          list.every((word, offset) => !taken.has(start + offset) && onward[start + offset]?.word === word && onward[start + offset]?.part === first.part),
      );
      return at < 0 ? [] : list.map((_, offset) => at + offset);
    };
    const held = fields.map((field) => {
      const spots = field.forms.map(find).find((each) => each.length > 0);
      if (spots === undefined) return field.words.some((forms) => forms.some((form) => find(form).length > 0)) ? "part" : "none";
      for (const spot of spots) taken.add(spot);
      return "kept";
    });
    const left = fields.reduce((sum, field, index) => sum + (held[index] === "none" ? field.adds : 0), 0);
    const fit = !held.includes("part") && left + (zip !== "" && shown === "" ? 1 : 0) <= 1;
    const named = names.some((forms) => forms.some((form) => ownWords.some((word) => !houseWords.includes(word) && numeral(word) === form)));
    if (house.length > 0 && names.length > 0 && !named && (other || !close(callerWords, streetWords(own)))) return undefined;
    const share = Math.max(
      0,
      ...streetForms.map((list) => (list.length === 0 ? 0 : list.filter((forms) => forms.some((form) => ownWords.includes(form))).length / list.length)),
    );
    const kept = keeps(places, after);
    const zipped = zip !== "" && shown === zip;
    const ours = bearing(lines[lineStreet] ?? "", beyondForms, callerAfter);
    const its = bearing(own, placeForms, beyond);
    const same = house.length === 0 || (ours.way === its.way && (ours.number === "" || its.number === "" || ours.number === its.number));
    const plain = left === 0 || onward.every((each, index) => taken.has(index) || each.word.length < 2 || unitWords.includes(each.word));
    const clean =
      same &&
      (((share > 0 || named) && fit && plain && (!other || (options.read === true && house.length > 0 && total > 0))) ||
        (zipped && (share > 0.5 || words(query.replace(zipGroups, "")).length === 0)));
    return {
      value: [clean ? 1 : 0, zipped && share > 0.5 ? 1 : 0, kept + keeps(unitPlace, after), Math.round(share * 1000), other ? 0 : 1],
      whole: same && share > 0 && kept === total && !other,
      clean,
      loose: left > 0 && !zipped,
      held,
      street: same && extra.length === 0,
    };
  };
  // Whether another suggestion on the caller's street, its words only theirs, holds every field the
  // one at `pick` holds.
  const rival = (scores: readonly (ReturnType<typeof score> | undefined)[], pick: number) =>
    scores.some(
      (each, index) =>
        index !== pick && each?.street === true && (scores[pick]?.held ?? []).every((kind, at) => kind !== "kept" || each.held[at] === "kept"),
    );
  // Which of two scores ranks higher: above zero for the first, below for the second.
  const compare = (one: readonly number[], two: readonly number[]) =>
    one.map((each, index) => each - (two[index] ?? 0)).find((difference) => difference !== 0) ?? 0;
  // The street as typed first, then once more tidied, with the ZIP and a unit asked for as typed
  // left out, when the first brings no usable suggestion or none that is whole.
  const base = lines.filter((_, index) => !asTyped || index !== unitAt).join(", ");
  const at = zip === "" ? -1 : base.lastIndexOf(zip);
  const tidied = tidy(at < 0 ? base : base.slice(0, at) + base.slice(at + zip.length).replace(/^-\d{4}/u, ""));
  const seen: string[] = [];
  const usable: string[] = [];
  let best:
    | { readonly choice: T; readonly label: string; readonly query: string; readonly value: readonly number[]; readonly clean: boolean }
    | undefined;
  for (const text of [...new Set([query, tidied])].filter((form) => form !== "")) {
    const items = [...(await suggest(text))];
    const labels = items.map((item) => squash(label(item)));
    seen.push(...labels.filter((name) => name !== ""));
    const scores = labels.map((name) => (name === "" ? undefined : score(name)));
    usable.push(...labels.filter((_, index) => scores[index] !== undefined));
    const top = scores.reduce<readonly number[] | undefined>(
      (most, each) => (each === undefined || (most !== undefined && compare(each.value, most) <= 0) ? most : each.value),
      undefined,
    );
    if (top === undefined) continue;
    // Among the best, the one the typed text names most closely, else the site's first.
    const tied = scores.flatMap((each, index) => (each !== undefined && compare(each.value, top) === 0 ? [index] : []));
    const ranking = match.rank(
      tied.map((index) => ({ names: [labels[index] ?? ""], value: "", disabled: false, key: String(index) })),
      [text],
      match.fold,
      { spellings: match.spellings },
    );
    const pick = tied[ranking.status === "picked" ? ranking.index : ranking.status === "ambiguous" ? (ranking.indexes[0] ?? 0) : 0] ?? 0;
    if (best === undefined || compare(top, best.value) > 0)
      best = {
        choice: items[pick] as T,
        label: labels[pick] ?? "",
        query: text,
        value: top,
        clean: scores[pick]?.clean === true && (scores[pick]?.loose !== true || (tied.length === 1 && !rival(scores, pick))),
      };
    if (scores[pick]?.whole === true) break;
  }
  if (best === undefined || !best.clean)
    return {
      picked: false,
      reason: best === undefined ? "option_missing" : "option_unclear",
      wanted: squash(address),
      available: [...new Set(seen)].slice(0, 100),
      matches: best === undefined ? [] : [...new Set(usable)].slice(0, 100),
      unit: next || (marker?.[2] ?? ""),
    };
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
 * another address and never usable, and so is one whose street keeps none of the caller's street
 * name words: its street's words but the last, a street type such as Ave, when it has another, of
 * three letters or more, and every word holding a digit but the house number's own, as the 9 of
 * Route 9, each in any of its usual forms from `spellingsOf` (Fifth for 5th) and a number without
 * its ordinal ending (107 for 107th), unless it shows no other ZIP and its street's name is close
 * to the caller's: the numbers both show agree and, with their words joined, fewer edits than a
 * third of the shorter's letters, a swap of two letters one edit, turn one into the other (Exampel
 * or Mian for Example or Main, LaSalle for La Salle), or a word of three letters or more of one is
 * among the first letters of the other's words but the last (MLK for Dr Martin Luther King Jr Blvd).
 * So St or Ave ending a street with a longer name word, or a direction letter, alone keeps none. So is one that reads a caller's ZIP as its house
 * number. Of the rest, it prefers one that keeps the address field by field (below), then the one
 * that shows the caller's ZIP while its own street keeps
 * more than half the caller's street words of two letters or more, as typed or tidied, each in any
 * of its usual forms from `spellingsOf`; then the one whose parts after its street keep the most
 * words of the caller's place, the words after the street in any of their usual forms; then the one whose
 * street keeps the largest share of the caller's street words; then one that shows no other ZIP;
 * then the one the text names most closely (`rankChoices`); then the site's first. For an address
 * whose street opens with its house number, a suggestion's street is the caller's street only when
 * it shows the same compass directions in the same order, N, S, E, W, NE, NW, SE and SW, dotted or
 * spelled out, before or after the name, none more and none fewer, and, when both show a number
 * other than the house number, the same first one, in any of its usual forms; each street is read
 * with its ZIP left out and, from its end, the other side's places after its street, each whole or,
 * for the caller's, without a last word written another way, as a state's code is, in any of their
 * usual forms, unless its own side shows that place after its street in any of them, as a site may
 * run a street on into its town. When the text brings no usable suggestion, or none on the caller's
 * street that keeps any of the caller's street words and every place word and shows no other ZIP,
 * it asks once more with a tidied text: joined words split, the ZIP and a unit asked for as typed
 * left out, and stray punctuation dropped. It accepts the best suggestion either text brought when
 * it is on the caller's street and keeps the address field by field, so the tool reports the site's
 * version as it does any rewrite: its street keeps a word of the caller's street or of its name; of
 * the fields the caller gave after the street, the ZIP, each part between commas, and a place's
 * code or name of two words that ends the state's part, the last part that ends in a place, after
 * other words, it leaves out at most one, showing none of it, and shows each of the others whole,
 * in one of its usual forms, a place's other forms only for the state's, its words side by side in
 * one part, each word used once, read in its parts after its street and in its street's words that
 * the caller's street, in their usual forms or written short, leaves over; and it shows no other
 * ZIP, unless `read` is set for a read and the caller gave a house number and a town or state; or
 * it shows the caller's ZIP on a street that keeps more than half the caller's street words, or
 * shows the caller's ZIP when that is all the caller gave. It accepts a field other than the ZIP
 * left out only when each word of two letters or more the suggestion shows after its house number,
 * but a ZIP and one for each of the caller's street words, belongs to a field it shows or to the
 * caller's unit, and, unless it shows the caller's ZIP, no other suggestion ranks the same, nor
 * holds every field it holds on the caller's street with no word of its street left over. The unit
 * is not such a field, since it is returned for the site's own unit field. Otherwise it refuses,
 * with `picked: false` and every suggestion the site gave as `available`, for `pickRefusal`: as
 * `option_missing` when neither text brought a usable one, else as `option_unclear`, with the
 * usable ones as `matches`. It keeps no list of words or addresses of its own but the compass
 * directions.
 */
export const resolveAddress = <T = string>(
  address: string,
  suggest: (text: string) => Promise<readonly T[]> | readonly T[],
  label: (item: T) => string = String,
  options: { readonly read?: boolean } = {},
): Promise<AddressOutcome<T>> =>
  resolveAddressWith(address, suggest, label, { fold: foldChoiceText, spellings: spellingsOf, rank: rankChoices }, options);
