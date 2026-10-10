import { Effect, Schema } from "effect";
import { defineHttpOperation, operationErrors, readJson } from "../../src/browser/index.js";

// An HTTP version, src/tool-http.mjs. In the workspace, import from "../../runtime/index.js" and
// reuse the Playwright version's contract: `import tool from "./tool.mjs"`, then
// `{ name: tool.name, input: tool.input, output: tool.output }`.
const contract = {
  name: "search_products",
  input: Schema.Struct({
    query: Schema.NonEmptyString.annotations({ description: "Text to search products for" }),
    sort: Schema.optional(
      Schema.String.annotations({ description: "How the site orders results, as it names it" }),
    ),
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
// The site's own refusal of a value, as a captured answer showed it: its message and the choices
// it offers.
const SiteRefusal = Schema.Struct({
  error: Schema.Struct({
    param: Schema.String,
    message: Schema.String,
    allowed: Schema.optional(Schema.Array(Schema.String)),
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
      if (input.sort !== undefined) api.searchParams.set("order", input.sort);
      // readJson sends through Kernel browser curl, retries once over the page's fetch if curl got
      // a bot challenge page, then checks the status and decodes the JSON; each failure says what
      // came back.
      const found = yield* readJson(
        http,
        { url: api.href, method: "GET" },
        Schema.Union(SearchResponse, SiteRefusal),
      );
      // The site refused the caller's value: fail as invalid input with the site's words, the
      // tool's input field and every choice the site offers, so the caller can pick again.
      if ("error" in found)
        return yield* Effect.fail(
          new operationErrors.InvalidInput(found.error.message, {
            field: found.error.param === "order" ? "sort" : "query",
            available: found.error.allowed ?? [],
          }),
        );
      return {
        products: found.data.items.map((item) => ({
          id: item.product_id,
          title: item.name,
          price_minor: item.price_cents,
        })),
      };
    }),
});
