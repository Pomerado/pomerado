import { test, expect } from "@playwright/test";
import {
  call,
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

    // One Guardian review covered the whole batch, with every case's input.
    const batch = executions(guardian.reviews).filter(
      (review) => currentOf(review)?.["input"] === "agent_chosen_batch",
    );
    expect(batch).toHaveLength(1);
    const submitted = batch[0]?.input["submitted_call"] as { readonly input: string };
    expect(JSON.parse(submitted.input)).toEqual({
      cases: cases.cases.map((entry) => entry.input),
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
