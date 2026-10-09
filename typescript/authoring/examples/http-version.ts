import { Effect, Schema } from "effect";
import { defineHttpOperation, readJson } from "../../src/browser/index.js";

// An HTTP version, src/tool-http.mjs. In the workspace, import from "../../runtime/index.js" and
// reuse the Playwright version's contract: `import tool from "./tool.mjs"`, then
// `{ name: tool.name, input: tool.input, output: tool.output }`.
const contract = {
  name: "search_products",
  input: Schema.Struct({
    query: Schema.NonEmptyString.annotations({ description: "Text to search products for" }),
  }),
  output: Schema.Struct({
    products: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString.annotations({ description: "The site's product ID" }),
        title: Schema.String.annotations({ description: "Product name as the site lists it" }),
        price_minor: Schema.Int.annotations({
          description: "Price in the currency's minor unit, such as cents",
        }),
      }),
    ).annotations({ description: "Matching products, in the site's order" }),
  }),
};

// The shape of the captured response that held the example's product IDs. Replace the route,
// host and fields only with the site's observed ones.
const SearchResponse = Schema.Struct({
  data: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        product_id: Schema.NonEmptyString,
        name: Schema.String,
        price_cents: Schema.Int,
      }),
    ),
  }),
});

export default defineHttpOperation({
  ...contract,
  run: (input, http) =>
    Effect.gen(function* () {
      // The data comes from a sibling API host on the site's registrable domain
      // (www.shop.example serves the page, api.shop.example the JSON). Build it from the site
      // origin rather than a link or canonical tag.
      if (http.siteOrigin === undefined) return yield* Effect.die("No site origin");
      const api = new URL(http.siteOrigin);
      api.hostname = `api.${api.hostname.replace(/^www\./, "")}`;
      api.pathname = "/v1/search";
      api.searchParams.set("keyword", input.query);
      // readJson sends through Kernel browser curl, retries once over the page's fetch if curl got
      // a bot challenge page, then checks the status and decodes the JSON; each failure says what
      // came back.
      const found = yield* readJson(http, { url: api.href, method: "GET" }, SearchResponse);
      return {
        products: found.data.items.map((item) => ({
          id: item.product_id,
          title: item.name,
          price_minor: item.price_cents,
        })),
      };
    }),
});
