import { Data, Effect, Schema } from "effect";
import { defineOperation, waitCode } from "../../src/browser/index.js";

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

const Listed = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ key: Schema.NonEmptyString, name: Schema.NonEmptyString })),
  end: Schema.Literal("list_end", "limit", "step_cap"),
});

// Append pagination on an observed list: "Show more" adds the next rooms to the same list, each
// row named by its data-room-id. Each step waits for the rows it added; a step that adds no
// identified row while no loading sign shows is the end of the list, as is the control going.
// Adapt every role, name and attribute from your own session's evidence.
export const readRooms = defineOperation(
  {
    name: "list_rooms",
    input: Schema.Struct({
      limit: Schema.Int.pipe(Schema.between(1, 200)).annotations({
        description: "Most rooms to return, in the site's order",
      }),
    }),
    output: Schema.Struct({
      rooms: Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyString.annotations({ description: "The room's ID on the site" }),
          name: Schema.NonEmptyString.annotations({ description: "The room's name" }),
        }),
      ),
      coverage: Schema.Literal("complete", "partial").annotations({
        description: "complete when every room up to the limit was read",
      }),
      limitation: Schema.optional(Schema.String),
    }),
  },
  async ({ kernel, sessionId, siteDomain, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${waitCode}
        const limit = ${input.limit};
        // The site's own requests, on every host of its domain, count as progress.
        const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
        const list = page.getByRole("list", { name: "Rooms", exact: true });
        const rows = list.getByRole("listitem");
        const more = page.getByRole("button", { name: "Show more", exact: true });
        const read = (count, action) =>
          waitForRows(rows, { name: ".name" }, {
            count,
            key: { attribute: "data-room-id" },
            region: list,
            ...site,
            ...(action === undefined ? {} : { action }),
          });
        // An empty list is an answer only the site's own words give, never a list without rows.
        // A page that shows neither throws outcome_unknown or outcome_timeout, which the host
        // retries once, as it does a row still loading when the page stops progressing.
        const shown = await waitForOutcome({
          empty: page.getByRole("status").filter({ hasText: /^No rooms$/ }),
          list,
        }, site);
        if (shown === "empty") return { rows: [], end: "list_end" };
        {
          // The first page's size comes from its rows once they have all arrived: a list can show
          // before its rows finish streaming in, so a count taken now could be one row. Asking for
          // the limit returns fewer rows once their count held with no loading sign or request in
          // flight. Each step then adds about a page of rows: wait for that many more, up to the
          // limit, and a shorter last page returns the same way.
          let found = await read(limit);
          const pageSize = Math.max(1, found.rows.length);
          for (let step = 0; found.rows.length < limit; step++) {
            if (step === 20) return { rows: found.rows, end: "step_cap" };
            if ((await more.count()) !== 1 || !(await more.isEnabled())) return { rows: found.rows, end: "list_end" };
            const before = found.rows.length;
            found = await read(Math.min(limit, before + pageSize), () => more.click({ timeout: waitLimits.action }));
            if (found.rows.length === before) return { rows: found.rows, end: "list_end" };
          }
          return { rows: found.rows, end: "limit" };
        }
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Listed)(answer.result);
    const rooms = result.rows.map(({ key, name }) => ({ id: key, name }));
    // A bound reached before the list ended is said, with no pretend continuation.
    return result.end === "step_cap"
      ? { rooms, coverage: "partial" as const, limitation: "Stopped after 20 Show more steps" }
      : { rooms, coverage: "complete" as const };
  },
);
