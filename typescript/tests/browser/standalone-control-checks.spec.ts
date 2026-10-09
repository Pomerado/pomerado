import { test, expect } from "@playwright/test";
import {
  call,
  currentOf,
  execution,
  executionIdOf,
  html,
  patch,
  recordingGuardian,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";
import { executions, historyOf, mint } from "./standalone-mint-fixture.js";

// Control checks through the local host: at finish_build the host builds inputs from the read's
// input schema and runs each one in the build's browser, and publication waits on the verdicts.

/** A catalog search whose sort radios sit in a collapsed panel that a button opens. */
const catalogSite = () =>
  startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const sort = url.searchParams.get("sort");
    const catalog = [
      { name: "Trail tent", price: 120 },
      { name: "Dome tent", price: 80 },
      { name: "Ultralight tent", price: 200 },
    ];
    const found = catalog
      .filter((item) => query !== "" && item.name.toLowerCase().includes(query))
      .sort((left, right) =>
        sort === "price_asc"
          ? left.price - right.price
          : sort === "price_desc"
            ? right.price - left.price
            : 0,
      );
    const radio = (value: string) =>
      `<label><input type="radio" name="sort" value="${value}"${sort === value ? " checked" : ""} onchange="go(this.value)">${value}</label>`;
    html(
      response,
      `<title>Catalog</title>
<form action="/search"><input name="q" value="${query}"></form>
<button id="filters" onclick="document.getElementById('sorts').hidden=false">Sort</button>
<div id="sorts" hidden>${["relevance", "price_asc", "price_desc"].map(radio).join("")}</div>
<ul id="results">${found.map((item) => `<li data-price="${item.price}">${item.name}</li>`).join("")}</ul>
${found.length === 0 ? "<p>No results</p>" : ""}
<script>function go(value){const next=new URL(location.href);next.searchParams.set("sort",value);location.href=next.href;}</script>`,
    );
  });

/** The search tool; `sortHelper` is imported from src/sort.mjs and `readCode` reads the results. */
const searchTool = (onEmpty = "") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
import { applySort } from "./sort.mjs";
export default defineOperation({name:"search_catalog",input:Schema.Struct({query:Schema.String.annotations({examples:["tent"]}),sort:Schema.optional(Schema.Literal("relevance","price_asc","price_desc"))}),output:Schema.Struct({items:Schema.Array(Schema.Struct({name:Schema.String,price:Schema.Number}))})},
async ({kernel,sessionId,input}) => {
  const open = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/search?q=' + encodeURIComponent(" + JSON.stringify(input.query) + "), page.url()).href); return true;",timeout_sec:10});
  if(!open.success) throw new Error(String(open.error));
  if(input.sort !== undefined) await applySort(kernel, sessionId, input.sort);
  const read = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.$$eval('#results li', (items) => items.map((item) => ({name: item.textContent.trim(), price: Number(item.dataset.price)})));",timeout_sec:10});
  if(!read.success) throw new Error(String(read.error));
  ${onEmpty}
  return {items: read.result};
});`;
/** Clicks the sort radio without opening the panel it sits in. */
const hiddenSortLine = `const code = (sort) => "await page.locator('input[name=sort][value=" + sort + "]').click({timeout:1000}); await page.waitForURL((url) => url.searchParams.get('sort') === '" + sort + "'); return true;";`;
/** Opens the panel first. */
const openSortLine = `const code = (sort) => "await page.locator('#filters').click(); await page.locator('input[name=sort][value=" + sort + "]').click({timeout:1000}); await page.waitForURL((url) => url.searchParams.get('sort') === '" + sort + "'); return true;";`;
const sortHelper = (line: string) => `${line}
export const applySort = async (kernel, sessionId, sort) => {
  const result = await kernel.browsers.playwright.execute(sessionId,{code:code(sort),timeout_sec:10});
  if(!result.success) throw new Error(String(result.error));
};`;
const finish = (request: Parameters<typeof executionIdOf>[0], callId: string) => [
  call(
    "finish_build",
    {
      intent: "Publish the catalog search",
      entrypoint: "src/tool.mjs",
      executionId: executionIdOf(request, "example"),
      metadata: { name: "search_catalog", description: "Search the catalog, optionally sorted" },
      coverage: "One live example",
    },
    callId,
  ),
];
const options = {
  effect: "read" as const,
  intent: "Search the catalog for tents",
  input: { query: "tent" },
  controlChecks: { now: () => new Date("2026-10-09T12:00:00Z") },
  // Each check case is a live run in its own process, so a build with two check runs takes longer.
  timeoutMs: 180_000,
};

test("refuses a sort control hidden in a collapsed panel, naming the case and frame, then publishes the fix", async () => {
  test.setTimeout(240_000);
  const site = await catalogSite();
  const guardian = recordingGuardian();
  try {
    const { built, requests } = await mint({
      ...options,
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": searchTool(), "src/sort.mjs": sortHelper(hiddenSortLine) }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1"),
        () => [
          {
            type: "apply_patch_call",
            callId: "open_panel",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/sort.mjs",
              diff: `@@\n-${hiddenSortLine}\n+${openSortLine}\n`,
            },
          },
        ],
        (request) => finish(request, "finish_2"),
      ],
    });
    const refusal = toolResult(requests.at(-1), "finish_1");
    expect(refusal).toMatchObject({
      status: "not_published",
      reason: "control_broken",
      controlChecks: {
        findings: expect.arrayContaining([
          expect.objectContaining({
            reason: "control_broken",
            key: '{"sort":"price_asc"}',
            verdict: "fail",
            failingFrame: expect.stringMatching(/^src\/sort\.mjs:\d+$/u),
          }),
        ]),
      },
    });
    expect(String(refusal?.["instruction"])).toContain('{"sort":"price_asc"}');
    expect(built.build, JSON.stringify(built)).toBe("published");
    // The fixed source ran each sort on the site before it published.
    expect(site.requests).toContain("GET /search?q=tent&sort=price_desc");
    // Guardian reviewed each check run once, as host-generated inputs.
    const checks = executions(guardian.reviews).filter(
      (review) => currentOf(review)?.["input"] === "schema_generated",
    );
    expect(checks).toHaveLength(2);
  } finally {
    await site.close();
  }
});

test("fails the empty probe when a search throws where it should return no results", async () => {
  test.setTimeout(240_000);
  const site = await catalogSite();
  try {
    const { built, requests } = await mint({
      ...options,
      url: site.url,
      guardian: recordingGuardian(),
      turns: [
        () =>
          patch({
            "src/tool.mjs": searchTool(
              'if(read.result.length === 0) throw new Error("No results found");',
            ),
            "src/sort.mjs": sortHelper(openSortLine),
          }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1"),
      ],
    });
    expect(toolResult(requests.at(-1), "finish_1")).toMatchObject({
      status: "not_published",
      reason: "control_broken",
      controlChecks: {
        findings: [
          expect.objectContaining({
            key: '{"query":"$empty_probe"}',
            verdict: "fail",
            failingFrame: expect.stringMatching(/^src\/tool\.mjs:\d+$/u),
          }),
        ],
      },
    });
    expect(built.build).not.toBe("published");
  } finally {
    await site.close();
  }
});

test("host check cases never use the minter's own live tests", async () => {
  test.setTimeout(240_000);
  const site = await catalogSite();
  const guardian = recordingGuardian();
  try {
    const { requests } = await mint({
      ...options,
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": searchTool(), "src/sort.mjs": sortHelper(hiddenSortLine) }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1"),
        () => [
          call(
            "execute",
            execution("test", "src/tool.mjs", { testInput: JSON.stringify({ query: "dome" }) }),
            "test_1",
          ),
        ],
      ],
    });
    // The host ran more cases than the minter's allowance before its first own test: the
    // base case, three sorts and the empty probe, besides the example.
    expect(toolResult(requests.at(-1), "finish_1")).toMatchObject({ reason: "control_broken" });
    expect(
      site.requests.filter((line) => /^GET \/search\?q=(?:tent|zq-)/u.test(line)).length,
    ).toBeGreaterThanOrEqual(6);
    // The minter's own test still ran, and Guardian saw the host's run marked apart from it.
    expect(toolResult(requests.at(-1), "test_1")).toMatchObject({ status: "completed" });
    expect(site.requests).toContain("GET /search?q=dome");
    const ownTest = executions(guardian.reviews).find(
      (review) => currentOf(review)?.["input"] === "agent_chosen",
    );
    expect(historyOf(ownTest).map((entry) => entry["input"])).toContain("schema_generated");
  } finally {
    await site.close();
  }
});
