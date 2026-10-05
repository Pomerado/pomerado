import { Data, Effect } from "effect";

export interface InvoiceCursor {
  readonly scope: string;
  readonly query: string;
  readonly afterId: string;
}
export interface InvoicePage {
  readonly ids: readonly string[];
  readonly next?: InvoiceCursor;
  readonly coverage: "complete" | "partial";
  readonly limitation?: string;
}
export class CursorMismatch extends Data.TaggedError("CursorMismatch")<{}> {}

/** Site-authored hooks receive a host-resolved cursor; reconstruct never performs a write. */
export const continueInvoices = <E>(
  query: string,
  scope: string,
  cursor: InvoiceCursor,
  site: {
    readonly inspectWarmState: Effect.Effect<"usable" | "expired" | "unavailable", E>;
    readonly reconstructRead: Effect.Effect<"ready" | "unsupported", E>;
    readonly readAfter: (id: string) => Effect.Effect<InvoicePage, E>;
  },
): Effect.Effect<InvoicePage, E | CursorMismatch> =>
  Effect.gen(function* () {
    if (cursor.scope !== scope || cursor.query !== query) return yield* new CursorMismatch();
    const warm = yield* site.inspectWarmState;
    if (warm !== "usable" && (yield* site.reconstructRead) === "unsupported")
      return {
        ids: [],
        coverage: "partial",
        limitation: "This read cannot reconstruct its continuation.",
      };
    return yield* site.readAfter(cursor.afterId);
  });
