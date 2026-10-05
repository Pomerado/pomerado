import { Effect } from "effect";
import { ReviewFailure } from "./review.js";
import type { ReviewTurn } from "./review.js";

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
      return yield* new ReviewFailure({ code: "SourceUnavailable" });
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
      return yield* new ReviewFailure({ code: "SourceUnavailable" });
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
        return yield* new ReviewFailure({ code: "SourceUnavailable" });
      const bytes = yield* read(path);
      const text = yield* project(path, bytes);
      return yield* sourceChunk(path, text, offset);
    });
