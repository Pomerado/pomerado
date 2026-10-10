/**
 * Text as a person reads it: zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF)
 * removed, a no-break space or any other Unicode space read as a space, runs of spaces and tabs
 * collapsed to one, each line trimmed and empty lines dropped. By default the lines are joined
 * with one space; `lines: true` keeps them, separated by "\n".
 *
 * It is pure and self-contained: the page code of `visibleTextCode` embeds this same function, so a
 * value read over HTTP or from parsed HTML normalizes as one read from the rendered page does.
 */
export const normalizeText = (text: string, options: { readonly lines?: boolean } = {}): string =>
  text
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/gu, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[ \t\v\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(options.lines === true ? "\n" : " ");
