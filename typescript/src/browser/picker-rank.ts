/** One option a picker listed, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its text, first line, accessible name, title, cells. */
  readonly names: readonly string[];
  /** The value the option carries in an attribute, such as `data-value`, or "". */
  readonly value: string;
  readonly disabled: boolean;
  /** Options with one key are one option seen twice; different keys are different options. */
  readonly key: string;
  /**
   * The lines the option shows, its first line first, when the picker read them (rank `place`).
   * Joined with commas, as a picker's refusal lists the option, they are one more of its names.
   */
  readonly lines?: readonly string[];
}

/** How closely the winning option matched, best first. */
export const pickerRanks = ["exact", "normalized", "folded", "leading", "place", "alike", "words", "allWords", "anyOrder", "stem", "extraWords", "searched"] as const;
export type PickerRank = (typeof pickerRanks)[number];

/** The ranks that name the value itself, written another way at most: a write picks only these. */
export const cleanRanks: readonly PickerRank[] = ["exact", "normalized", "folded", "leading", "place", "alike"];

export type PickerRanking =
  | { readonly status: "picked"; readonly index: number; readonly rank: PickerRank }
  | { readonly status: "disabled"; readonly index: number; readonly rank: PickerRank }
  | {
      readonly status: "ambiguous";
      readonly indexes: readonly number[];
      readonly rank: PickerRank;
    }
  | { readonly status: "missing" };

/**
 * The one option `wanted` names, a list of spellings of one choice, by rank: a name or the value
 * as written (trimmed), then ignoring case and spacing, then also ignoring accents and
 * punctuation (`fold`), then, only with `options.leading`, a name whose leading part, its text
 * before one of its commas that are not between two digits, is a spelling, folded the same way
 * (`leading`: York, UK for York, or Austin, TX, USA for Austin, TX, but not 1,000 miles for 1),
 * then, for an option whose `lines` are known, a spelling whose text before one of those commas is
 * the option's first line and each of whose later comma parts, in order, is one of the comma parts
 * of the option's later lines, all folded, any of those left out (`place`: Example Square,
 * Exampleton, CA for Example Square above Main St, Exampleton, CA, US, but not Sample Monument
 * above Example Square, Exampleton, CA), then the same name written another way: a name, or
 * with `options.leading` its leading part,
 * whose words pair one for one, in order, with a spelling's, splitting words at spacing and
 * punctuation (not a period, comma or colon between digits, nor a mark that ends a word, as in C#
 * or 1%, other than a bracket, quote or . , : ; ! ?), each pair equal, a singular and its
 * plural (a final s, not after s; es after s, x, z, ch, sh or o; or ies for a y after a consonant;
 * the singular three or more letters, so Adam pairs with Adams), or one written
 * short for the other either way, and at least one pair not short (`alike`: Union Square for
 * Union Sq, Union Sq for Union Square, 29 59 for 29-59, Bananas for banana, but never Square for
 * Sq alone). A word written short there is an abbreviation: two to four Latin letters with no
 * vowel (a, e, i, o, u or y), at least two fewer than the other, starting with its first letter
 * and holding the rest of its letters in order, such as Sq, Blvd or NW, so UK never pairs with
 * Ukraine nor Oak with Oakwood, either way. Then a name holding a spelling as whole words (New
 * York for York), then a name made of a
 * spelling's words, no more and no fewer,
 * whose parts, as its own or the spelling's commas, semicolons, colons, slashes, bars, brackets or
 * spaced dashes separate them, come in another order, each part's words in order and the numbers
 * in the spelling's order (`allWords`: Harbor Street Station, Example City for Example City Harbor
 * Street Station, but never Example Fort for Fort Example, Floor 12 Room 3 for Room 12 Floor 3, or
 * a name with a word the spelling lacks, such as Example Harbor 5th Avenue Mall for Example 5th
 * Avenue, which may be another place than the one asked for), then a name some of whose parts,
 * each whole and each keeping its words' order though the spelling may interleave them, hold the
 * spelling's words one for one, each equal or written short in the name, with the numbers in the
 * spelling's order (`anyOrder`: Transit - Lakeside Station, 12 Main St for Lakeside Transit
 * Station, or Example Hall, 1 Harbor Plz, Example City for Example Hall, 1 Harbor Plaza). A name's
 * word is written short for a spelling's when both are Latin letters and it has two to four
 * letters, at least two fewer than the spelling's, starts with its first letter and holds the rest
 * of its letters in order, such as Plz for Plaza, Sta for Station, Blvd for Boulevard or NW for
 * Northwest. Only the name's word is ever the short one, so a spelling's UK never matches Ukraine
 * nor Oak Oakwood, and a part matched only through short words never counts. Then, only with
 * `options.stem`, a name whose words pair one
 * for one, in order, with a spelling's (`stem`), as a read asks for and a write never does. Two
 * words pair when they are equal, or when both are Latin letters only and the shorter, of five or
 * more letters, is the whole start of the longer, such as Dentist and Dentistry or Dentists and
 * Dentist, but not Employee and Employer, County and Country, Physician and Physics, Adam and
 * Adams, or UK and Ukraine. Then, only with `options.extraWords` and when no spelling holds a
 * digit, a name holding every word of a spelling, in any order and among words the spelling lacks,
 * each as written or in its singular or plural form, plus or minus a final s or es, or with y for
 * ies (`extraWords`: Green Seedless Grapes for green grape, but not Lemonade for lemon), as a
 * product search asks for. Then, only with `options.searched`, for choices that are the site's
 * own results for the typed text in its order, the first enabled choice when a word of its names
 * is, as written or as its singular or plural as at `alike`, a word holding a letter of a spelling
 * or of its other written forms that are no place (`searched`), and no other: a first result
 * sharing no word, or one only written short, matches nothing.
 * The value never matches by stem. A name beats the value at each rank.
 * Options at the first rank that matches decide: one option (by key) is picked, or reported
 * disabled when every copy of it is; two or more are ambiguous, never guessed. A weaker rank never
 * overrules a stronger one, so a disabled exact match is not replaced by a looser one. Without
 * `options.leading`, no option ranks `leading`; without `options.stem`, none ranks `stem`; without
 * `options.extraWords`, none ranks `extraWords`; without `options.searched`, none ranks `searched`. With
 * `options.spellings`, such as `spellingsOf`, each rank also tries the other written forms of a
 * spelling against option names, never values, once the spellings as given match nothing at that
 * rank: so Fifth Avenue for 5th Avenue matches as a name before any option holding the same words
 * in another order, while a spelling that already matches at a rank is never overruled by one of
 * its forms. As whole words, a place's other form counts only after the value's other words and
 * where it ends the name or one of its parts, so Ontario never matches Turn on and Example City,
 * Oregon never matches Example City or Town; at `extraWords`, only the forms that are no place
 * count. From `folded` on, a leading "the" makes no other name, so The Example Tower is Example
 * Tower. With `options.listedFirst`, for options listed by how well they match, as a search's
 * results are, a match at `exact`, `normalized`, `folded`, `leading`, `place` or `alike` that an option of
 * several `lines` makes through its first line alone, by a spelling whose text up to one of its
 * commas is that line, none being the option's whole text, is withdrawn when an enabled option
 * listed before it holds the spelling's text before its first comma as whole words in its first
 * line and each of the spelling's later comma parts, or, with `options.spellings`, another written
 * form of it, as whole words in its text: a search lists the place it means first, so those options and the matches are
 * returned ambiguous, at `words`, in the list's order. Each name and each list of spellings is read once per call.
 *
 * It is pure and self-contained: the page code of `pickerCode` embeds this same function with
 * `fold` set to `foldChoiceText`.
 */
export const rankChoices = (
  given: readonly PickerChoice[],
  wanted: readonly string[],
  fold: (text: string) => string,
  options: {
    readonly leading?: boolean;
    readonly stem?: boolean;
    readonly extraWords?: boolean;
    readonly searched?: boolean;
    readonly listedFirst?: boolean;
    readonly spellings?: (
      text: string,
      options?: { readonly places?: "end" | "after-words" | "never" },
    ) => readonly string[];
  } = {},
): PickerRanking => {
  const choices = given.map((choice) => {
    const lines = choice.lines ?? [];
    return lines.length > 1 ? { ...choice, names: [...choice.names, lines.map((line) => line.replace(/[\s,;]+$/u, "")).join(", ")] } : choice;
  });
  const squash = (text: string) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const lower = (text: string) => squash(text).toLowerCase();
  const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrase = (text: string) => " " + words(text).join(" ") + " ";
  // Each name is read once per call, however many spellings and ranks try it.
  const once = <T>(make: (text: string) => T) => {
    const known = new Map<string, T>();
    return (text: string): T => {
      if (!known.has(text)) known.set(text, make(text));
      return known.get(text) as T;
    };
  };
  // A text's parts between its commas that are not thousands separators, as in 1,000.
  const commaParts = (text: string) =>
    String(text ?? "")
      .split(/(?<!\p{N}),|,(?!\p{N})/u)
      .map((part) => part.trim())
      .filter(Boolean);
  // A text's words in the parts its own commas, semicolons, colons, slashes, bars, brackets or
  // spaced dashes separate, such as "Harbor Street Station" and "Example City" in "Harbor Street
  // Station - Example City". A hyphen inside a word, as in St-Mary, separates nothing.
  const parted = (text: string) => {
    const parts = String(text ?? "")
      .split(/[,;:|/\\()[\]{}\u2013\u2014]|\s-|-\s/u)
      .map(words)
      .filter((part) => part.length > 0);
    const all = parts.flat();
    // Where each part ends, counted in words.
    const ends = parts.map((_, index) => parts.slice(0, index + 1).flat().length);
    return { parts, all, ends, numbers: all.filter((word) => /\p{N}/u.test(word)).join(" ") };
  };
  // Whether `target` is `parts` laid end to end in some order, each part's words in its order.
  const composes = (target: readonly string[], parts: readonly (readonly string[])[]) => {
    if (parts.length < 2) return false;
    const used = parts.map(() => false);
    const from = (at: number): boolean =>
      at === target.length ||
      parts.some((part, index) => {
        if (used[index] || !part.every((word, offset) => target[at + offset] === word)) return false;
        used[index] = true;
        const done = from(at + part.length);
        used[index] = false;
        return done;
      });
    return from(0);
  };
  // Whether a name's word is written short for a spelling's, such as Plz for Plaza.
  const short = (brief: string, full: string) => {
    if (!/^\p{Script=Latin}{2,4}$/u.test(brief) || !/^\p{Script=Latin}+$/u.test(full) || full.length < brief.length + 2 || brief[0] !== full[0])
      return false;
    let at = 0;
    for (const letter of full) if (letter === brief[at]) at += 1;
    return at === brief.length;
  };
  // Whether some of `parts`, each whole, hold `want`'s words one for one, each part's words in
  // its order but the parts interleaved, no part only through short forms, and the parts'
  // numbers are `numbers`.
  const covers = (want: readonly string[], numbers: string, parts: readonly (readonly string[])[]) => {
    const next = parts.map(() => 0);
    const same = parts.map(() => false);
    const from = (at: number): boolean => {
      if (at === want.length)
        return (
          parts.every((part, index) => next[index] === 0 || (next[index] === part.length && same[index] === true)) &&
          parts.filter((_, index) => next[index] !== 0).flat().filter((word) => /\p{N}/u.test(word)).join(" ") === numbers
        );
      const word = want[at] ?? "";
      return parts.some((part, index) => {
        const count = next[index] ?? 0;
        const have = part[count];
        if (have === undefined || (have !== word && !short(have, word))) return false;
        const was = same[index] === true;
        next[index] = count + 1;
        same[index] = was || have === word;
        const done = from(at + 1);
        next[index] = count;
        same[index] = was;
        return done;
      });
    };
    return from(0);
  };
  // Folded, with a leading "the" dropped, so The Example Tower names what Example Tower does.
  const bare = (text: string) => fold(text).replace(/^the\s+/u, "");
  const named = {
    lower: once(lower),
    fold: once(bare),
    words: once(words),
    phrase: once(phrase),
    parted: once(parted),
    alike: once((text: string) => alikeWords(text)),
  };
  // Two words pair when they are equal, or when both are Latin letters only and the shorter, of
  // five or more letters, is the whole start of the longer.
  const latin = /^\p{Script=Latin}+$/u;
  const pairs = (want: string, have: string) => {
    if (want === have) return true;
    if (!latin.test(want) || !latin.test(have)) return false;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    return short.length >= 5 && long.startsWith(short);
  };
  // At `extraWords`, two words pair when they are equal, or when one is the other plus s or es, or
  // with y for ies.
  const plural = (one: string, other: string) =>
    other === one + "s" || other === one + "es" || (one.endsWith("y") && other === one.slice(0, -1) + "ies");
  const pairsAsNoun = (want: string, have: string) => want === have || plural(want, have) || plural(have, want);
  // A text's words for `alike`, past a leading "the": spacing and punctuation split them, except a
  // period, comma or colon between two digits, which is part of a number, and a mark that ends a
  // word, as in C# or 1%, which is part of the word; brackets, quotes and . , : ; ! ? never are.
  const alikeWords = (text: string) => {
    const each = fold(text)
      .split(/(?:\s|(?!(?<=[\p{L}\p{N}])(?:(?![.,:;!?'"\u00a1\u00bf])\p{Po})+(?=[^\p{L}\p{N}]|$))(?!(?<=\p{N})[.,:]\p{N})\p{P})+/u)
      .filter(Boolean);
    return each[0] === "the" && each.length > 1 ? each.slice(1) : each;
  };
  // A singular and its plural at `alike`: plus s, except after s; plus es after s, x, z, ch, sh or
  // o; or y after a consonant as ies.
  const alikePlural = (one: string, other: string) =>
    (other === one + "s" && !one.endsWith("s")) ||
    (other === one + "es" && /(?:s|x|z|ch|sh|o)$/u.test(one)) ||
    (/[^aeiou]y$/u.test(one) && other === one.slice(0, -1) + "ies");
  // An abbreviation: two to four Latin letters with no vowel, written short for a longer word.
  const abbreviates = (brief: string, full: string) => !/[aeiouy]/u.test(brief) && short(brief, full);
  // How two words pair at `alike`: "same" as written, "noun" as a singular and its plural, "short"
  // as an abbreviation either way, or not at all.
  const alikePair = (want: string, have: string) =>
    want === have
      ? "same"
      : /^\p{L}{3,}$/u.test(want.length < have.length ? want : have) && (alikePlural(want, have) || alikePlural(have, want))
        ? "noun"
        : abbreviates(want, have) || abbreviates(have, want)
          ? "short"
          : undefined;
  // Whether two texts' words pair one for one, in order, not only through abbreviations.
  const alikeAll = (want: readonly string[], have: readonly string[]) => {
    if (want.length !== have.length || want.length === 0) return false;
    const pairs = want.map((word, at) => alikePair(word, have[at] ?? ""));
    return pairs.every((pair) => pair !== undefined) && pairs.some((pair) => pair !== "short");
  };
  const spellings = wanted.map(squash).filter((spelling) => spelling !== "");
  // A value with a number in it, such as a size or a count, never matches with extra words.
  const numbered = spellings.some((spelling) => /\p{N}/u.test(spelling));
  // The other written forms of the spellings, such as Fifth for 5th, which only names match.
  const formsOf = (places: "end" | "after-words" | "never") => [
    ...new Set(
      spellings
        .flatMap((spelling) => options.spellings?.(spelling, { places }) ?? [])
        .map(squash)
        .filter((form) => form !== "" && !spellings.includes(form)),
    ),
  ];
  const others = formsOf("end");
  // As whole words, a place's other form, such as on for Ontario or or for Oregon, counts only
  // after the value's other words and where it ends the name or one of its parts: alone it is a
  // common word, as in Turn on or Yes or no.
  const plainOthers = formsOf("never");
  const wordOthers = [...new Set([...plainOthers, ...formsOf("after-words")])];
  const placed = new Set(wordOthers.filter((form) => !plainOthers.includes(form)));
  // What a rank reads from a list of spellings, worked out once per list rather than per option.
  const perList = <T>(make: (list: readonly string[]) => T) => {
    const known = new Map<readonly string[], T>();
    return (list: readonly string[]): T => {
      if (!known.has(list)) known.set(list, make(list));
      return known.get(list) as T;
    };
  };
  const formSets = {
    lower: perList((list) => new Set(list.map(lower).filter((spelling) => spelling !== ""))),
    fold: perList((list) => new Set(list.map(bare).filter((spelling) => spelling !== ""))),
  };
  const phrases = perList((list) => ({
    anywhere: list.filter((form) => !placed.has(form)).map(phrase).filter((part) => part.trim() !== ""),
    ending: list.filter((form) => placed.has(form)).map(words).filter((each) => each.length > 0),
  }));
  const wordLists = perList((list) => list.map(words).filter((each) => each.length > 0));
  const alikeLists = perList((list) => list.map(alikeWords).filter((each) => each.length > 0));
  // A name's text up to each comma that is not a thousands separator, as in 1,000.
  const leadingParts = (text: string) =>
    [...text.matchAll(/(?<!\p{N}),|,(?!\p{N})/gu)].flatMap((comma) => ((comma.index ?? 0) > 0 ? [text.slice(0, comma.index)] : []));
  const partLists = perList((list) => list.map(parted).filter((each) => each.all.length > 1));
  type Test = (choice: PickerChoice, list: readonly string[]) => boolean;
  const tests: readonly (readonly [PickerRank, Test, boolean])[] = [
    ["exact", (choice, list) => choice.names.some((name) => list.includes(squash(name))), true],
    ["exact", (choice, list) => choice.value !== "" && list.includes(squash(choice.value)), false],
    ...(["lower", "fold"] as const).flatMap((form) => {
      const rank = form === "lower" ? "normalized" : "folded";
      return [
        [rank, (choice: PickerChoice, list: readonly string[]) => {
          const set = formSets[form](list);
          return choice.names.some((name) => set.has(named[form](name)));
        }, true],
        [rank, (choice: PickerChoice, list: readonly string[]) =>
          choice.value !== "" && formSets[form](list).has(named[form](choice.value)), false],
      ] as const;
    }),
    ...(options.leading === true
      ? ([
          [
            "leading",
            (choice: PickerChoice, list: readonly string[]) => {
              const forms = formSets.fold(list);
              return choice.names.some((name) => {
                const text = String(name ?? "");
                // The name up to each comma that is not a thousands separator, as in 1,000.
                return [...text.matchAll(/(?<!\p{N}),|,(?!\p{N})/gu)].some((comma) => (comma.index ?? 0) > 0 && forms.has(bare(text.slice(0, comma.index))));
              });
            },
            true,
          ],
        ] as const)
      : []),
    [
      "place",
      (choice, list) => {
        const lines = choice.lines ?? [];
        if (lines.length < 2) return false;
        const first = named.fold(lines[0] ?? "");
        const later = lines.slice(1).flatMap(commaParts).map(named.fold);
        return list.some((spelling) => {
          const parts = commaParts(spelling).map(fold);
          return parts.some((_, end) => {
            if (end === 0 || bare(parts.slice(0, end).join(" ")) !== first) return false;
            let at = 0;
            return parts.slice(end).map(bare).every((part) => {
              while (at < later.length && later[at] !== part) at++;
              return at++ < later.length;
            });
          });
        });
      },
      true,
    ],
    [
      "alike",
      (choice, list) => {
        const wants = alikeLists(list);
        return choice.names.some((name) => {
          const text = String(name ?? "");
          const texts = options.leading === true ? [text, ...leadingParts(text)] : [text];
          return texts.some((each) => wants.some((want) => alikeAll(want, named.alike(each))));
        });
      },
      true,
    ],
    [
      "words",
      (choice, list) => {
        const { anywhere, ending } = phrases(list);
        return choice.names.some((name) => {
          const have = named.phrase(name);
          if (anywhere.some((part) => have.includes(part))) return true;
          if (ending.length === 0) return false;
          const { all, ends } = named.parted(name);
          return ending.some((want) =>
            ends.some((end) => end >= want.length && want.every((word, at) => all[end - want.length + at] === word)),
          );
        });
      },
      true,
    ],
    [
      "allWords",
      // The same words, no more and no fewer, with the name's or the spelling's parts in another
      // order, and the numbers in the spelling's order.
      (choice, list) => {
        const wants = partLists(list);
        return choice.names.some((name) => {
          const have = named.parted(name);
          return wants.some(
            (want) =>
              want.all.length === have.all.length &&
              want.numbers === have.numbers &&
              (composes(want.all, have.parts) || composes(have.all, want.parts)),
          );
        });
      },
      true,
    ],
    [
      "anyOrder",
      (choice, list) => {
        const wants = partLists(list);
        return choice.names.some((name) => {
          const { parts } = named.parted(name);
          return wants.some((want) => covers(want.all, want.numbers, parts));
        });
      },
      true,
    ],
    [
      "stem",
      (choice, list) => {
        if (options.stem !== true) return false;
        const wants = wordLists(list);
        return choice.names.some((name) => {
          const have = named.words(name);
          return wants.some((want) => want.length === have.length && want.every((word, at) => pairs(word, have[at] ?? "")));
        });
      },
      true,
    ],
    [
      "extraWords",
      // Every word of the spelling, in any order, among words it lacks.
      (choice, list) => {
        if (options.extraWords !== true || numbered) return false;
        const wants = wordLists(list);
        return choice.names.some((name) => {
          const have = named.words(name);
          return wants.some((want) => want.every((word) => have.some((each) => pairsAsNoun(word, each))));
        });
      },
      true,
    ],
  ];
  // In a list ordered by how well each option matches, a clean match on an option's first line
  // alone, of an option that shows more lines, is withdrawn when an enabled option listed before it
  // holds the value's name, its text before its first comma, as whole words in its first line, and
  // each of the value's later comma parts, in any written form, as whole words in its text, as a
  // search lists the place it means first: those options and the matches come back in the list's
  // order, as matching by words.
  const namedEarlier = (rank: PickerRank, list: readonly string[], matched: readonly number[]): PickerRanking | undefined => {
    if (!["exact", "normalized", "folded", "leading", "place", "alike"].includes(rank)) return undefined;
    // At `alike`, texts are the same, or a line holds a name, word for word as `alike` pairs them.
    const same = (one: string, other: string) =>
      rank === "alike" ? alikeAll(alikeWords(one), alikeWords(other)) : phrase(bare(one)) === phrase(bare(other));
    const holds = (line: string, name: string) => {
      if (rank !== "alike") return phrase(bare(line)).includes(phrase(bare(name)));
      const want = alikeWords(name);
      const have = alikeWords(line);
      return have.some((_, at) => alikeAll(want, have.slice(at, at + want.length)));
    };
    // The spellings as given, whose commas their other forms drop, name an option by its first line
    // alone when one's text up to one of its commas is that line and no spelling or form at this
    // rank is the option's whole text.
    const alone = matched.filter((index) => {
      const lines = choices[index]?.lines ?? [];
      if (lines.length < 2) return false;
      const first = lines[0] ?? "";
      const whole = lines.join(" ");
      return (
        ![...spellings, ...list].some((spelling) => same(spelling, whole)) &&
        spellings.some((spelling) => {
          const parts = commaParts(spelling);
          return parts.some((_, end) => same(parts.slice(0, end + 1).join(" "), first));
        })
      );
    });
    if (alone.length === 0) return undefined;
    // Each spelling's name, and its later comma parts, each with its other written forms.
    const asked = spellings
      .map((spelling) => {
        const [head = "", ...rest] = commaParts(spelling);
        const later = rest.map((part) => [part, ...(options.spellings?.(part) ?? [])].map((form) => phrase(bare(form))));
        return { head, later: later.filter((forms) => (forms[0] ?? "").trim() !== "") };
      })
      .filter(({ head }) => phrase(bare(head)).trim() !== "");
    const earlier = choices.slice(0, Math.min(...alone)).flatMap((choice, index) => {
      if (matched.includes(index) || choice.disabled) return [];
      const first = choice.lines?.[0] ?? choice.names[0] ?? "";
      const text = phrase([...(choice.lines ?? []), ...choice.names].join(" "));
      return asked.some(({ head, later }) => holds(first, head) && later.every((forms) => forms.some((form) => text.includes(form)))) ? [index] : [];
    });
    if (earlier.length === 0) return undefined;
    const keys = new Set<string | undefined>();
    const indexes = [...earlier, ...matched]
      .sort((a, b) => a - b)
      .filter((index) => {
        const key = choices[index]?.key;
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
    return { status: "ambiguous", indexes, rank: "words" };
  };
  for (const [rank, test, byName] of tests) {
    // At each rank the spellings as given decide first; their other forms only when they match
    // nothing there, and never an option's value.
    // At `extraWords`, a place's other form is never tried, since that rank reads words anywhere.
    const forms = rank === "words" ? wordOthers : rank === "extraWords" ? plainOthers : others;
    const lists = byName && forms.length > 0 ? [spellings, forms] : [spellings];
    for (const list of lists) {
      const matched = choices.flatMap((choice, index) => (test(choice, list) ? [index] : []));
      if (matched.length === 0) continue;
      const withdrawn = byName && options.listedFirst === true ? namedEarlier(rank, list, matched) : undefined;
      if (withdrawn !== undefined) return withdrawn;
      const keys = [...new Set(matched.map((index) => choices[index]?.key))];
      if (keys.length > 1) {
        const indexes = keys.map((key) => matched.find((index) => choices[index]?.key === key) ?? 0);
        return { status: "ambiguous", indexes, rank };
      }
      const enabled = matched.find((index) => choices[index]?.disabled === false);
      return enabled === undefined
        ? { status: "disabled", index: matched[0] ?? 0, rank }
        : { status: "picked", index: enabled, rank };
    }
  }
  // The site's first result for the typed text, when it shares a word with the value, as written
  // or as a singular or plural, never only as an abbreviation.
  if (options.searched === true) {
    const first = choices.findIndex((choice) => !choice.disabled);
    const wants = [...spellings, ...plainOthers].flatMap(alikeWords).filter((word) => /\p{L}/u.test(word));
    const shares = (name: string) => named.alike(name).some((have) => wants.some((want) => ["same", "noun"].includes(alikePair(want, have) ?? "")));
    if (first >= 0 && (choices[first]?.names ?? []).some(shares)) return { status: "picked", index: first, rank: "searched" };
  }
  return { status: "missing" };
};

/**
 * `labels` with those closest to `query` first, by `score` (such as `rankByWords`, which scores
 * every label against the query at once), keeping the given order among equal scores, so the
 * options nearest a value the picker lacks survive a cap on how many a refusal lists. An empty
 * query keeps the given order.
 */
export const closestFirst = (
  labels: readonly string[],
  query: string,
  score: (query: string, texts: readonly string[]) => readonly number[],
): string[] => {
  if (String(query ?? "").trim() === "" || labels.length < 2) return [...labels];
  const scores = score(query, labels);
  return labels
    .map((label, index) => ({ label, index, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ label }) => label);
};
