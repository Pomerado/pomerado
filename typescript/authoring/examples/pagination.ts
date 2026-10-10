import { Schema } from "effect";
import {
  defineOperation,
  finishList,
  listCallBounds,
  listInputFields,
  listOutputFields,
  selectRows,
  startList,
  visibleTextCode,
  waitCode,
} from "../../src/browser/index.js";
import type { ListPosition } from "../../src/browser/index.js";

// A search whose site pages with numbered pages and a Next link. Page one runs the search through
// the site's own form; a later page opens the site's own link to its page from the cursor and
// reads the query back. Each read waits for the list's answer, then only for the rows this call
// can return, and reads their visible text. The selectors and the read are site logic: replace
// them with what the build observed on the site.

const Listing = Schema.Struct({
  id: Schema.NonEmptyString.annotations({ description: "The site's listing ID" }),
  title: Schema.String.annotations({ description: "The listing's title as the site shows it" }),
  sponsored: Schema.Boolean.annotations({
    description: "True for a listing the site marks as sponsored",
  }),
});
type Listing = typeof Listing.Type;

/** One site page as the read returns it: `more` says it holds rows past the ones read. */
const SitePage = Schema.Struct({
  url: Schema.String,
  query: Schema.String,
  rows: Schema.Array(Listing),
  more: Schema.Boolean,
  next: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Number),
  empty: Schema.Boolean,
});
type SitePage = typeof SitePage.Type;

/**
 * Page code, after waitCode and visibleTextCode with `site` and `action` declared: waits for the
 * list's answer, the site's empty message or its results, then for the first `count` rows to
 * have their ID and title filled in and holding, and reads the query the page shows, its count
 * and its Next link. A page that shows no answer throws outcome_unknown or outcome_timeout, and
 * rows still loading when the page stops progressing throw values_loading: the host retries a
 * read once after either, so they are never caught here.
 */
const readPageCode = (count: number) => `
const results = page.locator("#results");
const shown = await waitForOutcome({ empty: page.locator("#no-results"), results }, { ...site, action });
const query = (await page.locator("#q").inputValue({ timeout: waitLimits.action })).trim();
if (shown === "empty")
  return { url: page.url(), query, rows: [], more: false, next: null, total: null, empty: true };
const { rows, more } = await waitForRows(page.locator("#results > li"), {
  title: ".title",
  // The badge's presence is the mark, so read its class rather than text it may not have.
  sponsored: { selector: ".sponsored", attribute: "class", optional: true },
}, { count: ${count}, key: { attribute: "data-id" }, region: results, ...site });
const counted = /of (\\d+)/.exec((await visibleTexts(page.locator("#count")))[0] ?? "");
const next = page.locator("a[rel=next]");
const nextHref = (await next.count()) === 1 ? await next.getAttribute("href", { timeout: waitLimits.action }) : null;
return {
  url: page.url(),
  query,
  rows: rows.map((row) => ({ id: row.key, title: row.title, sponsored: row.sponsored !== null })),
  more,
  next: nextHref === null ? null : new URL(nextHref, page.url()).href,
  total: counted === null ? null : Number(counted[1]),
  empty: false,
};`;

/** A promoted copy keeps its own key, so the organic row and the copy both stay. */
const keyOf = (row: Listing) => (row.sponsored ? `sponsored:${row.id}` : row.id);

/**
 * Reading on to another site page needs at least this much of the run's time left. With less, the
 * call returns the rows it read and a position that continues.
 */
const readOnMs = 5_000;

export default defineOperation(
  {
    name: "search_listings",
    input: Schema.Struct({
      query: Schema.NonEmptyString.annotations({ description: "What to search the listings for" }),
      ...listInputFields,
    }),
    output: Schema.Struct({
      results: Schema.Array(Listing).annotations({
        description: "Listings in the site's order, sponsored ones in place",
      }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, remainingMs, errors }) => {
    // Before any browser work: the limit, and on a later page the position the cursor holds.
    const list = startList(input, { mechanism: "pages" });
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    // One Kernel call per site page: `steps` brings the page and `action` is the step that brings
    // its answer, run once by the wait. Each call stays inside the run's own deadline.
    const run = async (steps: string, action: string, count: number): Promise<SitePage> => {
      const timeoutSec = Math.min(60, Math.floor(remainingMs() / 1_000) - 1);
      if (timeoutSec < 1) throw new errors.OperationFailure("No time left to read the list");
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: timeoutSec,
        code: `
${waitCode}
${visibleTextCode}
// The site's own requests, on every host of its domain, count as progress.
const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
${steps}
const action = ${action};
${readPageCode(count)}`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return Schema.decodeUnknownSync(SitePage)(answer.result);
    };
    const navigate = (url: string) =>
      `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });`;
    const search = (count: number) =>
      run(
        `${navigate(siteOrigin)}
await page.locator("#q").fill(${JSON.stringify(input.query)}, { timeout: waitLimits.action });`,
        `() => page.locator("#go").click({ timeout: waitLimits.action })`,
        count,
      );
    const open = (href: string, count: number) => run(navigate(href), "undefined", count);

    // Wait only for the rows this call can return: on its first page, those before the cursor's
    // offset and a window after them; on a later page, what the window still lacks.
    const href = list.position?.href;
    const firstCount = (list.position?.offset ?? 0) + list.limit;
    const pages = [href === undefined ? await search(firstCount) : await open(href, firstCount)];
    // The page shows the query it ran: a later page opened from a link reads it back too.
    if (pages[0]?.query !== input.query.trim())
      throw new errors.OperationFailure("The results page does not show the requested query");
    // Read on until the window is full, the site has no more, or this call's bound is reached.
    const rowsRead = () => pages.flatMap((sitePage) => sitePage.rows);
    const lacking = () => list.limit - selectRows(list, rowsRead(), keyOf).rows.length;
    while (lacking() > 0 && pages.length < listCallBounds.sitePages && remainingMs() > readOnMs) {
      const lastPage = pages.at(-1);
      // Rows still unread on this page come before its Next link: the next call reads them.
      if (lastPage === undefined || lastPage.more || lastPage.next === null) break;
      pages.push(await open(lastPage.next, lacking()));
    }

    const selected = selectRows(list, rowsRead(), keyOf);
    const results = selected.rows.slice(0, list.limit);
    // Where the rows after these start: the site page that holds the last returned row, so the
    // next call finds that row again and reads on from it. Naming the page after it instead would
    // skip a row that moves back across the boundary when a row above it goes away.
    const last = results.at(-1);
    const lastIndex =
      last === undefined
        ? pages.length - 1
        : pages.findLastIndex((sitePage) =>
            sitePage.rows.some((row) => keyOf(row) === keyOf(last)),
          );
    const sitePage = pages[lastIndex];
    const pageNumber = (list.position?.page ?? 1) + lastIndex;
    const offset =
      sitePage === undefined
        ? 0
        : last === undefined
          ? sitePage.rows.length
          : sitePage.rows.findIndex((row) => keyOf(row) === keyOf(last)) + 1;
    const next: ListPosition | null =
      sitePage === undefined ||
      (offset >= sitePage.rows.length && !sitePage.more && sitePage.next === null)
        ? null
        : last === undefined && !sitePage.more && sitePage.next !== null
          ? // Nothing new on the pages read: start the next call at the page after them.
            { page: pageNumber + 1, offset: 0, href: sitePage.next }
          : { page: pageNumber, offset, href: sitePage.url };
    return {
      results,
      ...finishList(list, {
        rows: results,
        keyOf,
        next,
        hasMore: next !== null,
        totalResults: pages[0]?.total ?? null,
        listChanged: selected.listChanged,
      }),
    };
  },
);

const Room = Schema.Struct({
  id: Schema.NonEmptyString.annotations({ description: "The room's ID on the site" }),
  name: Schema.NonEmptyString.annotations({ description: "The room's name" }),
});
type Room = typeof Room.Type;

/** What one call's page code read: the rows in the site's order, its steps and why it stopped. */
const Listed = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ key: Schema.NonEmptyString, name: Schema.NonEmptyString })),
  steps: Schema.Int.pipe(Schema.nonNegative()),
  end: Schema.Literal("list_end", "window", "step_cap", "stalled"),
});

// Append pagination on an observed list: "Show more" adds the next rooms to the same list, each
// row named by its data-room-id. Each step waits for the rows it added. The control gone or
// disabled after a step's rows arrived is the end of the list. A step that adds no identified row
// is not proof of the end: one more read without a click decides, and the end is only the rows
// still not grown with the control still gone or disabled. A list that stops growing while the
// control is still offered has more: it returns a position that continues, never a null cursor.
// A later call that still stalls there returns no rows at the same position, and finishList ends
// the list with has_more true and next_cursor_unavailable "no_progress".
// A later page replays the steps its position holds, then reads on after the last row the
// previous page returned.
// Adapt every role, name and attribute from your own session's evidence.
export const readRooms = defineOperation(
  {
    name: "list_rooms",
    input: Schema.Struct({ ...listInputFields }),
    output: Schema.Struct({
      rooms: Schema.Array(Room).annotations({ description: "Rooms in the site's order" }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteDomain, input, errors }) => {
    // Before any browser work: the limit, and on a later page the steps the cursor holds.
    const list = startList(input, { mechanism: "append" });
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${waitCode}
        // The rows earlier pages returned, then this call's window. A later page replays the
        // steps its position holds, then takes at most this call's own steps.
        const wanted = ${list.returned + list.limit};
        const stepCap = ${(list.position?.steps ?? 0) + listCallBounds.steps};
        // The site's own requests, on every host of its domain, count as progress.
        const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
        const list = page.getByRole("list", { name: "Rooms", exact: true });
        const rows = list.getByRole("listitem");
        const more = page.getByRole("button", { name: "Show more", exact: true });
        const offered = async () => (await more.count()) === 1 && (await more.isEnabled());
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
        if (shown === "empty") return { rows: [], steps: 0, end: "list_end" };
        {
          // The first page's size comes from its rows once they have all arrived: a list can show
          // before its rows finish streaming in, so a count taken now could be one row. Asking for
          // the rows wanted returns fewer once their count held with no loading sign or request in
          // flight. Each step then adds about a page of rows: wait for that many more, up to the
          // rows wanted, and a shorter last page returns the same way.
          let found = await read(wanted);
          const pageSize = Math.max(1, found.rows.length);
          let steps = 0;
          while (found.rows.length < wanted) {
            if (steps === stepCap) return { rows: found.rows, steps, end: "step_cap" };
            if (!(await offered())) return { rows: found.rows, steps, end: "list_end" };
            const before = found.rows.length;
            const target = Math.min(wanted, before + pageSize);
            steps += 1;
            found = await read(target, () => more.click({ timeout: waitLimits.action }));
            if (found.rows.length > before) continue;
            // No rows added. Many sites hide or disable the control while a step loads, and a load
            // the wait cannot see (another domain's API, a timer) can outlast it, so a control gone
            // now is not yet the end. Read once more without a click: the end is only rows that
            // still did not grow with the control still gone or disabled. A control still offered
            // after a step that added nothing is a stalled list, which still has more.
            found = await read(target);
            if (found.rows.length > before) continue;
            return { rows: found.rows, steps, end: (await offered()) ? "stalled" : "list_end" };
          }
          // The window is full: the list has more while rows past it show or the control is offered.
          return { rows: found.rows, steps, end: found.more || (await offered()) ? "window" : "list_end" };
        }
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Listed)(answer.result);
    const read: Room[] = result.rows.map(({ key, name }) => ({ id: key, name }));
    const keyOf = (room: Room) => room.id;
    const selected = selectRows(list, read, keyOf);
    const rooms = selected.rows.slice(0, list.limit);
    // A step bound reached, a stalled list or rows past this window all have more: the next call
    // replays this call's steps, which loaded the last returned row, and reads on after it.
    const hasMore = result.end !== "list_end" || selected.rows.length > rooms.length;
    const last = rooms.at(-1);
    const next: ListPosition | null = hasMore
      ? {
          steps: result.steps,
          offset: last === undefined ? read.length : read.findIndex((room) => room.id === last.id) + 1,
        }
      : null;
    return {
      rooms,
      ...finishList(list, {
        rows: rooms,
        keyOf,
        next,
        hasMore,
        totalResults: null,
        listChanged: selected.listChanged,
      }),
    };
  },
);
