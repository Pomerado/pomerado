import { Effect } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { sourceChunkOf } from "./review-layout.js";
import { ReviewFailure } from "./review.js";
import type { ReviewTurn } from "./review.js";

/** A read at an offset the model supplied that no chunk can start at; context holds only it. */
const offsetFailure = (
  operation: "guardian.source.offset_invalid" | "guardian.source.offset_mid_character",
  offset: number,
) =>
  new ReviewFailure({
    code: "SourceUnavailable",
    failureDetail: failureDetail("invalid_input", { operation, context: { offset } }),
  });

export type SourceProjection = (
  path: string,
  bytes: Uint8Array,
) => Effect.Effect<string, ReviewFailure>;
export const sourceChunk = (
  path: string,
  text: string,
  offset: number,
): Effect.Effect<string, ReviewFailure> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(offset) || offset < 0)
      return yield* offsetFailure("guardian.source.offset_invalid", offset);
    const screened = { text };
    // Offsets address the screened UTF-8 view, not raw private source bytes.
    const visible = new TextEncoder().encode(screened.text);
    // A read at or past the end is the empty final chunk, not a failure: models sometimes
    // precompute offsets and read one chunk beyond the last.
    if (offset >= visible.byteLength)
      return JSON.stringify({
        kind: "untrusted_source",
        path,
        byteOffset: visible.byteLength,
        nextOffset: visible.byteLength,
        hasMore: false,
        source: "",
      });
    if (((visible[offset] ?? 0) & 0xc0) === 0x80)
      return yield* offsetFailure("guardian.source.offset_mid_character", offset);
    let nextOffset = Math.min(offset + 64 * 1024, visible.byteLength);
    while (nextOffset > offset && ((visible[nextOffset] ?? 0) & 0xc0) === 0x80) nextOffset--;
    return JSON.stringify({
      kind: "untrusted_source",
      path,
      byteOffset: offset,
      nextOffset,
      hasMore: nextOffset < visible.byteLength,
      source: new TextDecoder().decode(visible.subarray(offset, nextOffset)),
    });
  });
export const makeSourceInspector =
  (
    read: (path: string) => Effect.Effect<Uint8Array, ReviewFailure>,
    project: SourceProjection,
  ): ReviewTurn["readSource"] =>
  (path, offset) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(offset) || offset < 0)
        return yield* offsetFailure("guardian.source.offset_invalid", offset);
      const bytes = yield* read(path);
      const text = yield* project(path, bytes);
      return yield* sourceChunk(path, text, offset);
    });

/** The most chunks of one file the host reads to anchor a quote or answer a query: 4 MiB. */
const wholeSourceChunks = 64;

/**
 * A file's whole screened text through a reviewer's chunked reader: what Guardian would see by
 * following `nextOffset`, up to 4 MiB.
 */
export const wholeSource = (
  read: ReviewTurn["readSource"],
  path: string,
): Effect.Effect<string, ReviewFailure> =>
  Effect.gen(function* () {
    let text = "";
    let offset = 0;
    for (let index = 0; index < wholeSourceChunks; index++) {
      const chunk = sourceChunkOf(yield* read(path, offset));
      const source = chunk?.value["source"];
      if (chunk === undefined || typeof source !== "string")
        return yield* new ReviewFailure({ code: "SourceUnavailable" });
      text += source;
      if (!chunk.hasMore || chunk.nextOffset <= offset) break;
      offset = chunk.nextOffset;
    }
    return text;
  });

/** `text` as a pattern that matches it literally. */
export const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;
const lowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Characters kept on each side of a query's match, and the most slices one query returns. */
const matchContext = 300;
const maximumMatches = 20;

/**
 * The slices of a file around each case-insensitive occurrence of `match`, each with the UTF-8
 * byte offset it starts at, so Guardian can query a large capture rather than read it whole.
 * Overlapping slices merge; past 20 slices the result says how many matches there were.
 */
export const sourceMatches = (read: ReviewTurn["readSource"], path: string, match: string) =>
  wholeSource(read, path).pipe(
    Effect.map((text) => {
      const slices: { start: number; end: number }[] = [];
      let matchCount = 0;
      for (const found of text.matchAll(new RegExp(literalPattern(match), "giu"))) {
        matchCount++;
        let start = Math.max(0, found.index - matchContext);
        let end = Math.min(text.length, found.index + found[0].length + matchContext);
        // Never split a surrogate pair, so each slice and its offset are whole characters.
        if (lowSurrogate(text.charCodeAt(start))) start--;
        if (lowSurrogate(text.charCodeAt(end))) end++;
        const last = slices.at(-1);
        if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
        else if (slices.length < maximumMatches) slices.push({ start, end });
      }
      return JSON.stringify({
        kind: "untrusted_source_matches",
        path,
        match,
        byteLength: utf8Length(text),
        matchCount,
        matches: slices.map(({ start, end }) => ({
          byteOffset: utf8Length(text.slice(0, start)),
          source: text.slice(start, end),
        })),
      });
    }),
  );
