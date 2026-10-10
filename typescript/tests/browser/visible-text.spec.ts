import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { visibleTextCode } from "../../src/browser/visible-text.js";
import { normalizeText } from "../../src/runtime/text.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's text readers, run as a Kernel call body runs them (`page` in scope) on
// local pages. Chromium must render them: what counts is the text a person sees.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${visibleTextCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

// A call whose failure comes back as its name, reason and details instead of a message.
const failureOf = (page: Page, read: string) =>
  call(
    page,
    `try { return { value: await ${read} }; } catch (error) {
      return { ...error, name: error.name, message: error.message };
    }`,
  );

const srOnly = `position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;`;

test("a hidden copy holding script and style is never read; the rendered copy is", async ({
  page,
}) => {
  await page.setContent(`
    <div class="summary" id="hidden-summary" style="display: none">
      <script>window.cartTotal = { amount: 1 };</script>
      <style>.summary { color: red; }</style>
      Order total 99.00
    </div>
    <div class="summary" id="shown-summary">Order total 12.00</div>`);

  const { result } = await call(
    page,
    `return {
      shown: await visibleText(page.locator("#shown-summary")),
      either: await visibleText(page.locator(".summary")),
    };`,
  );
  expect(result).toEqual({ shown: "Order total 12.00", either: "Order total 12.00" });

  const { result: hidden } = await failureOf(page, `visibleText(page.locator("#hidden-summary"))`);
  expect(hidden).toEqual({
    name: "VisibleTextFailure",
    reason: "hidden_only",
    message: "hidden_only: 1 matched, 0 rendered",
    matched: 1,
    rendered: 0,
  });

  const { result: missing } = await failureOf(page, `visibleText(page.locator("#absent"))`);
  expect(missing).toMatchObject({ name: "VisibleTextFailure", reason: "not_found", matched: 0 });
});

test("two rendered matches are ambiguous, with counts and no page text", async ({ page }) => {
  await page.setContent(`<p class="note">First note</p><p class="note">Second note</p>`);
  const { result } = await failureOf(page, `visibleText(page.locator(".note"))`);
  expect(result).toEqual({
    name: "VisibleTextFailure",
    reason: "ambiguous",
    message: "ambiguous: 2 matched, 2 rendered",
    matched: 2,
    rendered: 2,
  });
});

test("inline script and style inside a rendered element never appear in its text", async ({
  page,
}) => {
  await page.setContent(`
    <section id="card">
      <h2>Garden room</h2>
      <script>document.title = "x"; var rate = "secret-rate";</script>
      <style>#card h2 { font-weight: bold; }</style>
      <noscript>Enable scripts</noscript>
      <p>Sleeps <b>2</b> guests</p>
      <svg><title>Room icon</title><text x="0" y="10">Icon label</text></svg>
    </section>`);
  const { result } = await call(page, `return await visibleText(page.locator("#card"));`);
  expect(result).toBe("Garden room Sleeps 2 guests Icon label");
});

test("a value shown twice reads one copy in each mode", async ({ page }) => {
  await page.setContent(`
    <style>.sr-only { ${srOnly} }</style>
    <div id="offer">
      <span aria-hidden="true">$12.99</span>
      <span class="sr-only">Price: $12.99</span>
    </div>
    <div id="moved"><span style="position: absolute; left: -10000px">Sale price 9.99</span>Now 9.99<span style="position: absolute; clip-path: inset(50%)">Was 14.99</span></div>`);
  const { result } = await call(
    page,
    `return {
      visible: await visibleText(page.locator("#offer")),
      accessible: await visibleText(page.locator("#offer"), { as: "accessible" }),
      visibleSpan: await visibleText(page.locator("#offer span")),
      accessibleSpan: await visibleText(page.locator("#offer span"), { as: "accessible" }),
      moved: await visibleText(page.locator("#moved")),
    };`,
  );
  expect(result).toEqual({
    visible: "$12.99",
    accessible: "Price: $12.99",
    visibleSpan: "$12.99",
    accessibleSpan: "Price: $12.99",
    moved: "Now 9.99",
  });
});

test("zero-width characters and no-break spaces are normalized, and blocks become lines", async ({
  page,
}) => {
  const first = "Total:\u00A0$\u200B12.99";
  const second = "Due\u2060  in \uFEFF3\u200C days";
  await page.setContent(`
    <div id="box"><div>${first}</div><p>${second}</p>Tax<br>included<span> here</span></div>`);
  const { result } = await call(
    page,
    `return {
      joined: await visibleText(page.locator("#box")),
      lines: await visibleText(page.locator("#box"), { lines: true }),
    };`,
  );
  expect(result).toEqual({
    joined: "Total: $12.99 Due in 3 days Tax included here",
    lines: "Total: $12.99\nDue in 3 days\nTax\nincluded here",
  });
  // The page normalizes as normalizeText does for a value read over HTTP.
  const raw = `${first}\n${second}\nTax\nincluded here`;
  expect(result).toEqual({
    joined: normalizeText(raw),
    lines: normalizeText(raw, { lines: true }),
  });
});

test("readRows reads every rendered row in one call, skipping hidden rows", async ({ page }) => {
  const rows = Array.from({ length: 22 }, (_, index) => {
    const hidden = index === 3 || index === 10 ? ` style="display: none"` : "";
    const badge = index % 2 === 0 ? `<em class="badge">Popular</em>` : "";
    return `<li class="offer"${hidden}>
      <h3>Room ${index}</h3><span class="price">${100 + index}.00</span>${badge}
      <a href=" /rooms/${index} ">Details</a>
    </li>`;
  }).join("");
  await page.setContent(`<ul id="results">${rows}</ul>`);

  const { result } = await call(
    page,
    `return await readRows(page.locator("#results li.offer"), {
      name: { selector: "h3", required: true },
      price: ".price",
      badge: ".badge",
      link: { selector: "a", attribute: "href" },
    });`,
  );
  const shown = Array.from({ length: 22 }, (_, index) => index).filter(
    (index) => index !== 3 && index !== 10,
  );
  expect(result).toEqual(
    shown.map((index) => ({
      name: `Room ${index}`,
      price: `${100 + index}.00`,
      badge: index % 2 === 0 ? "Popular" : null,
      link: `/rooms/${index}`,
    })),
  );

  const { result: window } = await call(
    page,
    `return await readRows(page.locator("#results li.offer"), { name: "h3" }, { from: 5, limit: 2 });`,
  );
  expect(window).toEqual([{ name: "Room 6" }, { name: "Room 7" }]);

  const { result: required } = await failureOf(
    page,
    `readRows(page.locator("#results li.offer"), { name: "h3", badge: { selector: ".badge", required: true } })`,
  );
  expect(required).toEqual({
    name: "VisibleTextFailure",
    reason: "not_found",
    message: "not_found: required field badge has no rendered match in row 1",
    field: "badge",
    row: 1,
  });
});

test("readRows reads the row itself with :scope and skips a hidden field match", async ({
  page,
}) => {
  await page.setContent(`
    <table><tbody>
      <tr class="line"><td>Coffee</td><td><span class="qty" hidden>9</span><span class="qty">2</span></td></tr>
      <tr class="line"><td>Tea</td><td><span class="qty">1</span></td></tr>
    </tbody></table>`);
  const { result } = await call(
    page,
    `return await readRows(page.locator("tr.line"), { row: ":scope", qty: ".qty" });`,
  );
  expect(result).toEqual([
    { row: "Coffee 2", qty: "2" },
    { row: "Tea 1", qty: "1" },
  ]);
});

test("visibleTexts returns rendered matches in page order without hidden or empty ones", async ({
  page,
}) => {
  await page.setContent(`
    <ul>
      <li class="tag">Quiet</li>
      <li class="tag" style="visibility: hidden">Hidden tag</li>
      <li class="tag"><span style="opacity: 0">Faded</span></li>
      <li class="tag">Sea view</li>
      <li class="tag" style="display: none">Removed</li>
      <li class="tag">Breakfast</li>
    </ul>`);
  const { result } = await call(page, `return await visibleTexts(page.locator(".tag"));`);
  expect(result).toEqual(["Quiet", "Sea view", "Breakfast"]);
});

test("a value over maxLength fails as too_long without its text", async ({ page }) => {
  await page.setContent(`<p id="terms">These terms apply to every booking made here.</p>`);
  const { result } = await failureOf(page, `visibleText(page.locator("#terms"), { maxLength: 10 })`);
  expect(result).toEqual({
    name: "VisibleTextFailure",
    reason: "too_long",
    message: "too_long: 45 characters, over the 10 limit",
    length: 45,
    maxLength: 10,
  });
});
