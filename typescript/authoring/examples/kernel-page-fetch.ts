import { Schema } from "effect";
import { defineOperation, timeoutDefaults } from "../../src/browser/index.js";

const Results = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString.annotations({ description: "The site's record ID" }),
      name: Schema.String.annotations({ description: "Record name as the site lists it" }),
    }),
  ).annotations({ description: "Matching records, in the site's order" }),
  complete: Schema.Boolean.annotations({
    description: "True when the site returned every match",
  }),
});
const Response = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
});

// Replace the illustrative origin/route only with the site's observed request recipe.
export default defineOperation(
  {
    name: "search_records",
    input: Schema.Struct({
      query: Schema.NonEmptyString.annotations({ description: "Text to search records for" }),
    }),
    output: Results,
  },
  async ({ kernel, sessionId, siteOrigin, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const url = new URL("/api/search", siteOrigin);
    url.searchParams.set("q", input.query);
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 90,
      code: `
        await page.goto(${JSON.stringify(new URL("/", siteOrigin).href)}, { timeout: ${timeoutDefaults.navigation} });
        // Site HTTP runs inside the page, with its cookies, so the request boundary sees it.
        // Never use page.request or a Node-side fetch.
        return await page.evaluate(async (url) => {
          const response = await fetch(url, { headers: { Accept: "application/json" } });
          return {
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            body: await response.text(),
          };
        }, ${JSON.stringify(url.href)});
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const response = Schema.decodeUnknownSync(Response)(answer.result);
    if (response.status !== 200)
      throw new errors.OperationFailure(`The site answered ${response.status}`);
    if (!/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.contentType))
      throw new errors.OperationFailure("The site did not answer with JSON");
    return Schema.decodeUnknownSync(Schema.parseJson(Results))(response.body);
  },
);
