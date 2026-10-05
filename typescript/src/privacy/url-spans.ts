/**
 * URL spans that screening must leave byte-exact. By user decision every part of a URL (scheme,
 * username, host, path, query, fragment, nested URLs) stays raw in all readable, stored and log
 * copies, because browser navigation and HTTP requests need the whole URL. Nothing inside these
 * spans is masked, aliased or registered.
 */
export interface UrlSpan {
  readonly start: number;
  readonly end: number;
}

// Scheme URLs (including JSON-escaped `https:\/\/`) and schemeless `www.` hosts.
const URL_CANDIDATE =
  /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)|www\.)[^\s"'`<>]+/giu;
const SCHEME_RELATIVE_CANDIDATE = /(?<![A-Za-z0-9+.:/\\-])\/\/[^\s"'`<>]+/gu;
const TRAILING_PROSE = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "\\"]);
// A backward scan: a `[...]+$` regex retries every run start, quadratic on long punctuation runs.
const trimmedLength = (candidate: string) => {
  let length = candidate.length;
  while (length > 0 && TRAILING_PROSE.has(candidate[length - 1] ?? "")) length--;
  return length;
};
export const urlSpans = (text: string): UrlSpan[] =>
  [
    ...text.matchAll(URL_CANDIDATE),
    ...[...text.matchAll(SCHEME_RELATIVE_CANDIDATE)].filter((match) => {
      const authority = match[0].slice(2).split(/[/?#\\]/u)[0] ?? "";
      return authority.includes(".") || authority.includes("@") || /:\d+$/u.test(authority);
    }),
  ]
    .map((match) => ({
      start: match.index,
      end: match.index + trimmedLength(match[0]),
    }))
    .sort((left, right) => left.start - right.start)
    .reduce<UrlSpan[]>((ranges, range) => {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && range.start <= last.end)
        ranges[ranges.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      else ranges.push(range);
      return ranges;
    }, []);
