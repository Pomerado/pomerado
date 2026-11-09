import { selectJson } from "../runtime/select-json.js";

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then read a page's embedded data with `readPageData`. It runs `selectJson` inside the
 * page, so the page's data never crosses into the call: only the values selected come back. A
 * call that reads the whole data into its own code, with `textContent`, `innerText`,
 * `page.content()` or an `evaluate` that returns it, copies all of it into the script runner,
 * whose memory is limited and much smaller than the page's.
 *
 * - `readPageData(source, select, options?)` returns what `selectJson` returns: each result name
 *   with an array of its matches. `source` is a CSS selector for the one element that holds the
 *   data as JSON text, such as `"script#__NEXT_DATA__"`; or `{ global: "name" }`, a global the
 *   page's code set, read from `window`, with dots for a path into it, such as
 *   `{ global: "__APOLLO_STATE__" }`. A global that holds a string is read as JSON text. It finds
 *   the element inside the page: Playwright's locators and element handles describe the element
 *   they find by its text, which takes seconds on an element holding megabytes.
 *
 *   ```js
 *   const { items } = await readPageData("script#__NEXT_DATA__", {
 *     items: {
 *       path: "props.pageProps.results.*",
 *       fields: { id: "id", name: "title", price: "price.amount" },
 *       limit: 50,
 *     },
 *   });
 *   ```
 *
 * Options: those of `selectJson` (`after`, `maxChars`, `maxKeys`), and `decode: "uri"` for data
 * the page percent-encodes, which it decodes in the page first. It reads the page as it is now and
 * never waits: wait for the page first.
 *
 * It also declares `selectJson` for the call's own code, such as for a data response's text.
 *
 * It throws an `Error` named `PageDataFailure` with the `reason`s of `selectJson`, `not_found`
 * also when no element matches the selector (`matched` 0) or the global is missing, and
 * `ambiguous` when several elements match (`matched`). The message carries counts, never page
 * text.
 */
export const pageDataCode = String.raw`
const selectJson = ${selectJson.toString()};
const readPageData = async (source, select, options = {}) => {
  if (typeof source !== "string" && typeof source?.global !== "string")
    throw new TypeError('source is a CSS selector or { global: "name" }');
  const arg = {
    select,
    options: { after: options.after, maxChars: options.maxChars, maxKeys: options.maxKeys },
    decode: options.decode,
  };
  // Runs in the page. It reads the data where the page keeps it and returns only the selection.
  const pageRead = (arg) => {
    const selectJson = ${selectJson.toString()};
    const failure = (reason, message, detail) =>
      Object.assign(new Error(reason + ": " + message), { name: "PageDataFailure", reason, ...detail });
    try {
      let input;
      if (arg.global !== undefined) {
        input = window;
        for (const key of arg.global.split(".")) input = input === null || input === undefined ? undefined : input[key];
        if (input === undefined) throw failure("not_found", "the page has no global " + arg.global, {});
      } else {
        const elements = document.querySelectorAll(arg.selector);
        if (elements.length !== 1)
          throw failure(
            elements.length === 0 ? "not_found" : "ambiguous",
            elements.length + " elements matched the selector",
            { matched: elements.length },
          );
        input = elements[0].textContent ?? "";
      }
      if (typeof input === "string" && arg.decode === "uri")
        try {
          input = decodeURIComponent(input);
        } catch {
          throw failure("not_json", "the data is not percent-encoded", {});
        }
      return { values: selectJson(input, arg.select, arg.options) };
    } catch (error) {
      if (error?.name !== "PageDataFailure") throw error;
      return { failure: { ...error, name: error.name, message: error.message } };
    }
  };
  const answer = await page.evaluate(
    pageRead,
    typeof source === "string" ? { ...arg, selector: source } : { ...arg, global: source.global },
  );
  if (answer.failure !== undefined) throw Object.assign(new Error(answer.failure.message), answer.failure);
  return answer.values;
};
`;
