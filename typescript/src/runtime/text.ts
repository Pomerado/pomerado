/**
 * Text as a person reads it: characters that never show (zero-width space U+200B, word joiner
 * U+2060, byte order mark U+FEFF and soft hyphen U+00AD) removed, while the zero-width
 * non-joiner and joiner (U+200C, U+200D), which spell words in many scripts and join emoji, stay;
 * a no-break space or any other Unicode space read as a space, runs of spaces and tabs collapsed
 * to one, each line trimmed and empty lines dropped. By default the lines are joined
 * with one space; `lines: true` keeps them, separated by "\n".
 *
 * It is pure and self-contained: the page code of `visibleTextCode` embeds this same function, so a
 * value read over HTTP or from parsed HTML normalizes as one read from the rendered page does.
 */
export const normalizeText = (text: string, options: { readonly lines?: boolean } = {}): string =>
  text
    .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[ \t\v\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(options.lines === true ? "\n" : " ");
