import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { test, expect } from "@playwright/test";
import type { ModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { createPomerado } from "../../src/standalone/pomerado.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { listCursorTtlMs } from "../../src/runtime/list-page.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";

// A list tool paged through the local host: each call is a fresh run, the host signs the cursor
// each page returns and checks it before the next run touches the site. The tool is the
// pagination skill's own reference, run against a fixture site whose list changes between calls.

const unreachableModel: ModelProvider = {
  getModel: () => {
    throw new Error("A run makes no model request");
  },
};

/** The reference tool as a saved artifact's module, importing the seeded runtime. */
const referenceTool = async () =>
  stripTypeScriptTypes(
    await readFile("typescript/authoring/examples/pagination.ts", "utf8"),
  ).replace('"../../src/browser/index.js"', '"../runtime/index.js"');

/** A listing site that pages three rows at a time behind a search form, with a Next link. */
const startListings = async () => {
  const listings = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const query = url.searchParams.get("q") ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const rows = url.pathname === "/search" ? listings.slice((page - 1) * 3, page * 3) : [];
    const more = url.pathname === "/search" && page * 3 < listings.length;
    response.setHeader("Content-Type", "text/html");
    response.end(`<form action="/search"><input id="q" name="q" value="${query}">
<button id="go">Search</button></form>
${
  url.pathname !== "/search"
    ? ""
    : rows.length === 0
      ? `<p id="no-results">No listings</p>`
      : `<p id="count">${(page - 1) * 3 + 1}-${(page - 1) * 3 + rows.length} of ${listings.length}</p>
<ol id="results">${rows.map((id) => `<li data-id="${id}"><span class="title">Lamp ${id}</span></li>`).join("")}</ol>
${more ? `<a rel="next" href="/search?q=${encodeURIComponent(query)}&page=${page + 1}">Next</a>` : ""}`
}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    listings,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

interface Page {
  readonly results: readonly { readonly id: string }[];
  readonly next_cursor: string | null;
  readonly next_cursor_expires_at: string | null;
  readonly has_more: boolean;
  readonly total_results: number | null;
  readonly list_changed: boolean;
}

test("a list pages by signed cursors across changes and refuses a stale cursor before the site", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Six runs of a paged tool on a fixture site, each in a fresh run",
  });
  test.setTimeout(60_000);
  const site = await startListings();
  let now = Date.UTC(2026, 0, 5, 12);
  const source = await referenceTool();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createPomerado({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel,
            guardianProvider: unreachableModel,
            timeoutMs: 20_000,
            listCursors: { now: () => now },
          });
          const run = (input: Record<string, unknown>) =>
            service
              .run(
                {
                  entrypoint: "src/tool.mjs",
                  files: [{ path: "src/tool.mjs", content: source }],
                  inputSchema: {},
                  outputSchema: {},
                },
                { url: site.url, intent: "Search the listings", effect: "read", input },
              )
              .pipe(Effect.map((output) => output as Page));
          const ids = (page: Page) => page.results.map((row) => row.id);

          const first = yield* run({ query: "lamps", limit: 2 });
          expect(first).toMatchObject({
            has_more: true,
            total_results: 7,
            list_changed: false,
            next_cursor: expect.stringMatching(/^pc1\./u),
            next_cursor_expires_at: new Date(now + listCursorTtlMs).toISOString(),
          });
          expect(ids(first)).toEqual(["L1", "L2"]);

          // Page two finishes site page one and reads into site page two.
          const second = yield* run({ query: "lamps", limit: 2, cursor: first.next_cursor });
          expect(ids(second)).toEqual(["L3", "L4"]);
          expect(second.list_changed).toBe(false);

          // A listing added above the last returned row repeats nothing and skips nothing.
          site.listings.unshift("N0");
          const third = yield* run({ query: "lamps", limit: 2, cursor: second.next_cursor });
          expect(ids(third)).toEqual(["L5", "L6"]);
          expect(third.list_changed).toBe(false);

          // The last returned row is gone: the list says it changed, and the last page has no cursor.
          site.listings.splice(site.listings.indexOf("L6"), 1);
          const last = yield* run({ query: "lamps", limit: 2, cursor: third.next_cursor });
          expect(last).toMatchObject({ list_changed: true, next_cursor: null, has_more: false });
          expect(ids(last)).toEqual(["L7"]);

          // A cursor an hour old, or one sent with other inputs, ends the run before the site.
          const before = site.requests();
          now += listCursorTtlMs;
          const expired = yield* Effect.flip(
            run({ query: "lamps", limit: 2, cursor: second.next_cursor }),
          );
          now -= listCursorTtlMs;
          const otherInputs = yield* Effect.flip(
            run({ query: "desks", limit: 2, cursor: second.next_cursor }),
          );
          for (const [failure, kind] of [
            [expired, "expired"],
            [otherInputs, "inputs_changed"],
          ] as const) {
            expect(failure).toBeInstanceOf(RunOutcomeFailure);
            expect(failure).toMatchObject({
              outcome: {
                code: "input_rejected",
                details: { field: "cursor", kind },
              },
            });
          }
          expect(site.requests()).toBe(before);
        }),
      ),
    );
  } finally {
    await site.close();
  }
});
