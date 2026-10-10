import { Schema } from "effect";
import {
  defineOperation,
  finishList,
  listCallBounds,
  listInputFields,
  listOutputFields,
  selectRows,
  startList,
} from "../../src/browser/index.js";
import type { ListPosition } from "../../src/browser/index.js";

// A search whose site pages with numbered pages and a Next link. Page one runs the search through
// the site's own form; a later page opens the site's own link to its page from the cursor and
// reads the query back. The selectors and the read are site logic: replace them with what the
// build observed on the site.

const Listing = Schema.Struct({
  id: Schema.NonEmptyString.annotations({ description: "The site's listing ID" }),
  title: Schema.String.annotations({ description: "The listing's title as the site shows it" }),
  sponsored: Schema.Boolean.annotations({
    description: "True for a listing the site marks as sponsored",
  }),
});
type Listing = typeof Listing.Type;

/** One site page as the read returns it. */
const SitePage = Schema.Struct({
  url: Schema.String,
  query: Schema.String,
  rows: Schema.Array(Listing),
  next: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Number),
  empty: Schema.Boolean,
});
type SitePage = typeof SitePage.Type;

/** Waits for the list's answer, then reads the page's query, rows, Next link and count. */
const readPageCode = `
await page.locator("#results, #no-results").first().waitFor({ timeout: 10000 });
return await page.evaluate(() => {
  const count = /of (\\d+)/.exec(document.querySelector("#count")?.textContent ?? "");
  return {
    url: location.href,
    query: document.querySelector("#q")?.value ?? "",
    rows: [...document.querySelectorAll("#results > li[data-id]")].map((row) => ({
      id: row.dataset.id ?? "",
      title: row.querySelector(".title")?.innerText.trim() ?? "",
      sponsored: row.querySelector(".sponsored") !== null,
    })),
    next: document.querySelector("a[rel=next]")?.href ?? null,
    total: count === null ? null : Number(count[1]),
    empty: document.querySelector("#no-results") !== null,
  };
});`;

/** A promoted copy keeps its own key, so the organic row and the copy both stay. */
const keyOf = (row: Listing) => (row.sponsored ? `sponsored:${row.id}` : row.id);

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
  async ({ kernel, sessionId, siteOrigin, input, errors }) => {
    // Before any browser work: the limit, and on a later page the position the cursor holds.
    const list = startList(input, { mechanism: "pages" });
    const run = async (code: string): Promise<SitePage> => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        code,
        timeout_sec: 30,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return Schema.decodeUnknownSync(SitePage)(answer.result);
    };
    const search = () =>
      run(`await page.goto(${JSON.stringify(siteOrigin ?? "")});
await page.locator("#q").fill(${JSON.stringify(input.query)});
await page.locator("#go").click();
${readPageCode}`);
    const open = (href: string) =>
      run(`await page.goto(${JSON.stringify(href)});
${readPageCode}`);

    const href = list.position?.href;
    const pages = [href === undefined ? await search() : await open(href)];
    // The page shows the query it ran: a later page opened from a link reads it back too.
    if (pages[0]?.query !== input.query)
      throw new errors.OperationFailure("The results page does not show the requested query");
    // Read on until the window is full, the site has no more, or this call's bound is reached.
    const rowsRead = () => pages.flatMap((sitePage) => sitePage.rows);
    while (
      selectRows(list, rowsRead(), keyOf).rows.length < list.limit &&
      pages.length < listCallBounds.sitePages
    ) {
      const next = pages.at(-1)?.next;
      if (next === null || next === undefined) break;
      pages.push(await open(next));
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
      sitePage === undefined || (offset >= sitePage.rows.length && sitePage.next === null)
        ? null
        : last === undefined && sitePage.next !== null
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
