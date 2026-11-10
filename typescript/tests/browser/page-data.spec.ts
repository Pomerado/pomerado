import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { pageDataCode } from "../../src/browser/page-data.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `readPageData`, run as a Kernel call body runs it (`page` in scope) on local pages. Chromium
// must hold the data: the read happens inside the page, and only the selection comes back.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${pageDataCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const failureOf = (page: Page, read: string) =>
  call(
    page,
    `try { return { value: await ${read} }; } catch (error) {
      return { ...error, name: error.name, message: error.message };
    }`,
  );

// A store page whose embedded state is a few megabytes: 2,000 items, each with a long text.
const state = {
  queries: [
    { key: "user", data: { id: "u-1" } },
    {
      key: "store",
      data: {
        title: "Corner Market",
        sections: Array.from({ length: 20 }, (_, s) => ({
          items: Array.from({ length: 100 }, (_, i) => ({
            id: `item-${s}-${i}`,
            title: `Item ${s}-${i}`,
            price: { amount: 100 + i },
            description: "x".repeat(1_000),
          })),
        })),
      },
    },
  ],
};
const stateText = JSON.stringify(state);

test("reads only the selected fields of a script's embedded state, and its outline", async ({ page }) => {
  await page.setContent(
    `<main>Store</main><script type="application/json" id="__STATE__">${stateText}</script>`,
  );
  const { result } = await call(
    page,
    `const fields = await readPageData("script#__STATE__", {
      title: { path: "queries.*.data.title", limit: 1 },
      items: { path: "queries.*.data.sections.*.items.*", fields: { id: "id", price: "price.amount" }, limit: 3 },
    });
    const outline = await readPageData("script#__STATE__", { count: { path: "queries.1.data.sections", outline: 0 } });
    const own = selectJson('{"a":[1,2]}', { a: "a.1" });
    return { fields, outline, own };`,
  );
  expect(result).toEqual({
    fields: {
      title: ["Corner Market"],
      items: [
        { id: "item-0-0", price: 100 },
        { id: "item-0-1", price: 101 },
        { id: "item-0-2", price: 102 },
      ],
    },
    own: { a: [2] },
    outline: {
      count: [{ type: "array", chars: JSON.stringify(state.queries[1]?.data.sections).length, length: 20 }],
    },
  });
});

test("reads a global the page's code set, an encoded one and one held as text", async ({ page }) => {
  await page.setContent(`<script>
    window.__APP__ = { cache: { "Product:1": { name: "Lamp" }, "Product:2": { name: "Desk" } } };
    window.__TEXT__ = ${JSON.stringify(JSON.stringify({ a: { b: 7 } }))};
    window.__ENCODED__ = ${JSON.stringify(encodeURIComponent(JSON.stringify({ c: [1, 2] })))};
  </script>`);
  const { result } = await call(
    page,
    `return {
      names: (await readPageData({ global: "__APP__.cache" }, { names: "*.name" })).names,
      text: (await readPageData({ global: "__TEXT__" }, { b: "a.b" })).b,
      encoded: (await readPageData({ global: "__ENCODED__" }, { c: "c.1" }, { decode: "uri" })).c,
    };`,
  );
  expect(result).toEqual({ names: ["Lamp", "Desk"], text: [7], encoded: [2] });
});

test("fails with the reason and counts, never the page's text", async ({ page }) => {
  await page.setContent(
    `<script type="application/json" id="__STATE__">${stateText}</script><script id="broken">{"a":"private</script>`,
  );
  const { result: missing } = await failureOf(page, `readPageData({ global: "__NONE__" }, { a: "a" })`);
  expect(missing).toMatchObject({ name: "PageDataFailure", reason: "not_found" });
  const { result: large } = await failureOf(
    page,
    `readPageData("script#__STATE__", { items: "queries.*.data.sections.*.items.*" }, { maxChars: 50000 })`,
  );
  expect(large).toMatchObject({ name: "PageDataFailure", reason: "too_large", maxChars: 50000, field: "items" });
  const { result: broken } = await failureOf(page, `readPageData("script#broken", { a: "a" })`);
  const { result: two } = await failureOf(page, `readPageData("script", { a: "a" })`);
  expect(two).toMatchObject({ name: "PageDataFailure", reason: "ambiguous", matched: 2 });
  expect(broken).toMatchObject({ name: "PageDataFailure", reason: "not_json", at: 5 });
  expect(JSON.stringify([missing, large, broken])).not.toMatch(/private|Item 0-0/);
});
