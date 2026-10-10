import { test, expect } from "@playwright/test";
import {
  call,
  message,
  currentOf,
  execution,
  executionIdOf,
  html,
  patch,
  publicationOf,
  readOf,
  recordingGuardian,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";
import { executions, mint } from "./standalone-mint-fixture.js";

// The local host runs a read's planned live tests one at a time on its one browser, after one
// Guardian review of the batch: each case starts on a page reset like the example's, a failure
// names the line that threw, and the publication review reads the host's record of the cases.

/**
 * A search whose page reports the cookie a previous run left, then sets one; a query of
 * "broken" throws from the tool's own source.
 */
const searchTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"search_fixture",input:Schema.Struct({query:Schema.String}),output:Schema.Struct({results:Schema.Array(Schema.String),cookie:Schema.String})},
async ({kernel,sessionId,input}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.evaluate(() => { const before = document.cookie; document.cookie = 'seen=1; path=/'; return before; });",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  if(input.query === "broken") throw new Error("The results list never appeared");
  return {results: input.query === "zzqx" ? [] : [input.query + " result"], cookie: String(response.result)};
});`;
const brokenLine = searchTool.split("\n").findIndex((line) => line.includes("never appeared")) + 1;

const cases = {
  cases: [
    { id: "first", covers: ["repeat_example"], input: { query: "lamp" }, expect: "result" },
    { id: "second", covers: ["repeat_example"], input: { query: "lamp" }, expect: "result" },
    { id: "nothing", covers: ["input:query"], input: { query: "zzqx" }, expect: "empty" },
    { id: "broken", covers: ["input:query"], input: { query: "broken" }, expect: "result" },
  ],
};

test("runs a read's planned cases on reset pages after one review, and hands publication the record", async () => {
  // Chromium must run the cases: the reset between them is the page's own cookies. Four cases
  // run one after another, each in its own child process, then an example and a publication
  // review, so this takes about a minute, like the other standalone mint specs plus the cases.
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Search</title><h1>Search</h1>"),
  );
  try {
    const guardian = recordingGuardian();
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "Search the fixture catalog",
      // A batch needs time for its cases before the attempt's own margin.
      timeoutMs: 600_000,
      turns: [
        () => patch({ "src/tool.mjs": searchTool, "test/cases.json": JSON.stringify(cases) }),
        () => [
          call("live_tests", {
            intent: "Run every planned case",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 3,
          }),
        ],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { exampleInput: '{"query":"lamp"}' }),
            "example",
          ),
        ],
        (request) => [
          call("finish_build", {
            intent: "Publish the search",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example"),
            metadata: { name: "search_fixture", description: "Search the fixture catalog" },
            coverage: "One live example and the planned cases.",
          }),
        ],
      ],
    });

    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly lanes: number;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    // The local host has one browser.
    expect(ran.lanes).toBe(1);
    const byId = new Map(ran.cases.map((entry) => [entry["id"], entry]));
    // Each case starts with the cookies the previous one set cleared, like the example.
    expect(byId.get("first")).toMatchObject({ status: "pass" });
    expect(byId.get("second")).toMatchObject({ status: "pass" });
    expect(String(byId.get("second")?.["excerpt"])).toContain('"cookie":""');
    expect(byId.get("nothing")).toMatchObject({ status: "pass", got: "empty" });
    expect(byId.get("broken")).toMatchObject({
      status: "fail",
      frame: `src/tool.mjs:${brokenLine}`,
    });

    // One Guardian review covered the whole batch, with every case's id and input.
    const batch = executions(guardian.reviews).filter(
      (review) => currentOf(review)?.["input"] === "agent_chosen_batch",
    );
    expect(batch).toHaveLength(1);
    const submitted = batch[0]?.input["submitted_call"] as { readonly input: string };
    expect(JSON.parse(submitted.input)).toEqual({
      cases: cases.cases.map((entry) => ({ id: entry.id, input: entry.input })),
    });

    // A failing case does not refuse publication by itself; the review reads the host's record.
    expect(built.build).toBe("published");
    const review = guardian.reviews.find((entry) => entry.kind === "publication");
    expect(publicationOf(review ?? guardian.reviews[0]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "publication/tests.json", owner: "host", published: false }),
      ]),
    );
    expect(readOf(review, "publication/tests.json")).toContain('"id": "broken"');
  } finally {
    await site.close();
  }
});

/** A list tool on the runtime's cursor contract: five rows on one page, read in windows. */
const listTool = `import { Schema } from "effect";
import { defineOperation, finishList, listInputFields, listOutputFields, selectRows, startList } from "../runtime/index.js";
const Row = Schema.Struct({ id: Schema.String });
export default defineOperation({name:"list_fixture",input:Schema.Struct({query:Schema.String,...listInputFields}),output:Schema.Struct({results:Schema.Array(Row),...listOutputFields})},
async ({kernel,sessionId,input}) => {
  const list = startList(input, { mechanism: "offset" });
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return ['a','b','c','d','e']",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const keyOf = (row) => row.id;
  const read = response.result.map((id) => ({ id }));
  const selected = selectRows(list, read, keyOf);
  const results = selected.rows.slice(0, list.limit);
  const last = results.at(-1);
  const more = selected.rows.length > results.length;
  const next = more && last !== undefined ? { offset: read.findIndex((row) => row.id === last.id) + 1 } : null;
  return { results, ...finishList(list, { rows: results, keyOf, next, hasMore: more, totalResults: read.length, listChanged: selected.listChanged }) };
});`;

test("runs a list case's page two from the cursor its page one returned, checked and signed by the host", async () => {
  // Chromium runs the case's two pages in their own child processes after one batch review.
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>List</title><h1>List</h1>"),
  );
  try {
    const guardian = recordingGuardian();
    const { requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "List the fixture rows",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": listTool,
            "test/cases.json": JSON.stringify({
              cases: [
                {
                  id: "page-2",
                  covers: ["next_page"],
                  input: { query: "rows", limit: 2 },
                  expect: "result",
                  next_page: true,
                },
              ],
            }),
          }),
        () => [
          call("live_tests", {
            intent: "Run the next-page case",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 1,
          }),
        ],
      ],
    });
    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    // Page two continues after page one's last row: without the host's cursor, page one has no
    // next cursor and the case cannot run its next page.
    expect(ran.cases[0]).toMatchObject({ id: "page-2", status: "pass", got: "results (2)" });
    const excerpt = String(ran.cases[0]?.["excerpt"]);
    expect(excerpt).toContain('{"id":"c"},{"id":"d"}');
    expect(excerpt).not.toContain('"id":"a"');
  } finally {
    await site.close();
  }
});

test("refuses a case whose cursor the host never signed before the case touches the site", async () => {
  // Chromium runs the batch's review and the build's first page; the refused case runs nothing.
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>List</title><h1>List</h1>"),
  );
  // Well formed, under a key this host does not hold: a hand-made or altered cursor.
  const forged = `pc1.unknownkey.${Buffer.from('{"v":1}').toString("base64url")}.${"A".repeat(43)}`;
  let before = 0;
  let after = 0;
  try {
    const guardian = recordingGuardian();
    const { requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "List the fixture rows",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": listTool,
            "test/cases.json": JSON.stringify({
              cases: [
                {
                  id: "forged",
                  covers: ["input:query"],
                  input: { query: "rows", cursor: forged },
                  expect: "result",
                },
              ],
            }),
          }),
        () => {
          before = site.requests.length;
          return [
            call("live_tests", {
              intent: "Run the case",
              action: "run",
              entrypoint: "src/tool.mjs",
              cases: null,
              maxWorkers: 1,
            }),
          ];
        },
        () => {
          after = site.requests.length;
          return [message("Done.")];
        },
      ],
    });
    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    expect(ran.cases[0]).toMatchObject({
      id: "forged",
      status: "fail",
      got: "InvalidInput",
      refusal: { field: "cursor" },
    });
    // Refused before the case's page reset: the site saw no request for it.
    expect(after).toBe(before);
  } finally {
    await site.close();
  }
});
