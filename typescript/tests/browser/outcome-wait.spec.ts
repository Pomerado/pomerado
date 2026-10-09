import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { outcomeWaitCode } from "../../src/browser/outcome-wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's outcome wait, run as a Kernel call body runs it (`page` in scope) on
// local search pages. Chromium must render them: an outcome counts only when it is visible.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${outcomeWaitCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/**
 * A search page whose answer shows `delayMs` after the search: `html` replaces the busy
 * placeholder. Every outcome the waits below name sits in `#answer`.
 */
const searchPage = (page: Page, html: string, delayMs = 150) =>
  page.setContent(`
    <section id="answer"><p>Searching</p></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(html)}; }, ${delayMs});
    </script>`);

// Refusal and error first, then the empty state, then results.
const waitBody = (timeout: number) => `
  const answer = page.locator("#answer");
  return await waitForOutcome({
    failed: answer.getByRole("alert"),
    empty: answer.getByText("No rooms match your dates", { exact: true }),
    results: answer.getByRole("list", { name: "Rooms", exact: true }),
  }, { timeout: ${timeout} });
`;

const rooms = `<ul aria-label="Rooms"><li>Garden room</li><li>Courtyard room</li></ul>`;

test("a search that shows its empty state returns the empty outcome, not a timeout", async ({
  page,
}) => {
  await searchPage(page, `<p>No rooms match your dates</p>`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a delayed result appears after the busy state", async ({ page }) => {
  await searchPage(page, rooms, 400);
  expect(await call(page, waitBody(5000))).toEqual({ result: "results" });
});

test("the site's error wins over results shown beside it", async ({ page }) => {
  await searchPage(page, `<div role="alert">Search is unavailable</div>${rooms}`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "failed" });
});

test("a hidden copy makes the winning outcome ambiguous until its locator is scoped to visible elements", async ({
  page,
}) => {
  const empty = `No rooms match your dates`;
  await searchPage(page, `<p hidden>${empty}</p><p>${empty}</p>`);
  const ambiguous = await call(page, waitBody(5000));
  expect(ambiguous.error).toBe(
    "outcome_ambiguous: failed 0 visible of 0, empty 1 visible of 2, results 0 visible of 0",
  );
  const scoped = await call(
    page,
    `return await waitForOutcome({
      empty: page.getByText(${JSON.stringify(empty)}, { exact: true }).filter({ visible: true }),
      results: page.getByRole("list", { name: "Rooms", exact: true }),
    }, { timeout: 5000 });`,
  );
  expect(scoped).toEqual({ result: "empty" });
});

test("two visible matches of the winning outcome fail as ambiguous without picking one", async ({
  page,
}) => {
  await searchPage(page, `${rooms}${rooms}`);
  expect(
    await call(
      page,
      `try { ${waitBody(5000)} } catch (error) {
        return { name: error.name, reason: error.reason, outcome: error.outcome, observations: error.observations };
      }`,
    ),
  ).toEqual({
    result: {
      name: "OutcomeWaitFailure",
      reason: "outcome_ambiguous",
      outcome: "results",
      observations: {
        failed: { count: 0, visible: 0 },
        empty: { count: 0, visible: 0 },
        results: { count: 2, visible: 2 },
      },
    },
  });
});

test("an ambiguous outcome below the winner does not block it", async ({ page }) => {
  await searchPage(page, `<p>No rooms match your dates</p>${rooms}${rooms}`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a timeout says what each outcome matched", async ({ page }) => {
  // The empty state is on the page but hidden, and the answer never comes.
  await searchPage(page, `<p hidden>No rooms match your dates</p><p>Still searching</p>`, 50);
  const { error } = await call(page, waitBody(300));
  expect(error).toBe(
    "outcome_timeout after 300 ms: failed 0 visible of 0, empty 0 visible of 1, results 0 visible of 0",
  );
});

test("a no-results page for the query is the empty outcome", async ({ page }) => {
  await searchPage(page, `<h1>Search</h1><p>No rooms match your dates</p><a href="#">Clear dates</a>`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a greyed-out choice is its own outcome, recognized at once", async ({ page }) => {
  await page.setContent(`
    <div role="grid" aria-label="March">
      <div role="row">
        <button role="gridcell" aria-disabled="true">14</button>
        <button role="gridcell">15</button>
      </div>
    </div>`);
  // A short timeout: had the wait looked only for an enabled day, it would time out.
  const day = (disabled: boolean) =>
    `page.getByRole("grid", { name: "March" }).getByRole("gridcell", { name: "14", exact: true, disabled: ${disabled} })`;
  expect(
    await call(
      page,
      `return await waitForOutcome({ unavailable: ${day(true)}, available: ${day(false)} }, { timeout: 1000 });`,
    ),
  ).toEqual({ result: "unavailable" });
});

/**
 * Results that a filter changes: clicking "Pets allowed" re-renders the list `delayMs` later,
 * after the click returns. `rendering` says how: `replace` swaps in a new list element, `inPlace`
 * rewrites the same list's rows, `same` leaves the list as it was, and `empty` replaces it with the
 * empty state.
 */
const filteredResults = (
  page: Page,
  rendering: "replace" | "inPlace" | "same" | "empty",
  delayMs = 300,
) =>
  page.setContent(`
    <button type="button">Pets allowed</button>
    <section id="answer">${rooms.replace("</ul>", "<li>Loft room</li></ul>")}</section>
    <script>
      document.querySelector("button").onclick = () => setTimeout(() => {
        const answer = document.querySelector("#answer");
        const rendering = ${JSON.stringify(rendering)};
        if (rendering === "replace") answer.innerHTML = ${JSON.stringify(rooms)};
        if (rendering === "inPlace") answer.querySelector("ul").innerHTML = "<li>Garden room</li>";
        if (rendering === "empty") answer.innerHTML = "<p>No rooms match your dates</p>";
      }, ${delayMs});
    </script>`);

/** Applies the filter as the wait's action, then reads the rooms the answer lists. */
const filterBody = (options: string) => `
  const answer = page.locator("#answer");
  const shown = await waitForOutcome({
    failed: answer.getByRole("alert"),
    empty: answer.getByText("No rooms match your dates", { exact: true }),
    results: answer.getByRole("list", { name: "Rooms", exact: true }),
  }, { action: () => page.getByRole("button", { name: "Pets allowed" }).click(), ${options} });
  return { shown, rooms: shown === "results" ? await answer.getByRole("listitem").allInnerTexts() : [] };
`;

test("after an action, the results from before it are not the answer", async ({ page }) => {
  // A long unchanged window: only the re-render, not the window, can end this wait in time.
  for (const rendering of ["replace", "inPlace"] as const) {
    await filteredResults(page, rendering);
    expect(await call(page, filterBody("timeout: 3000, unchangedMs: 5000"))).toEqual({
      result: { shown: "results", rooms: rendering === "replace" ? ["Garden room", "Courtyard room"] : ["Garden room"] },
    });
  }
  await filteredResults(page, "empty");
  expect(await call(page, filterBody("timeout: 3000, unchangedMs: 5000"))).toEqual({
    result: { shown: "empty", rooms: [] },
  });
});

test("after an action that leaves the results as they were, the wait ends after its unchanged window", async ({
  page,
}) => {
  await filteredResults(page, "same");
  expect(await call(page, filterBody("timeout: 3000, unchangedMs: 300"))).toEqual({
    result: { shown: "results", rooms: ["Garden room", "Courtyard room", "Loft room"] },
  });
  // Within a timeout shorter than the window, the unchanged results are no answer.
  await filteredResults(page, "same");
  const { error } = await call(page, filterBody("timeout: 300, unchangedMs: 5000"));
  expect(error).toBe(
    "outcome_timeout after 300 ms: failed 0 visible of 0, empty 0 visible of 0, results 1 visible of 1, unchanged",
  );
});

test("an action that loads a new page waits for that page's answer", async ({ page }) => {
  const origin = "https://rooms.example.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    // The old page lists rooms too: only the new page's answer counts.
    await route.fulfill({
      contentType: "text/html",
      body:
        url.pathname === "/search"
          ? `<section id="answer"><p>No rooms match your dates</p></section>`
          : `<form action="/search"><button>Search</button></form><section id="answer">${rooms}</section>`,
    });
  });
  await page.goto(`${origin}/`);
  expect(
    await call(
      page,
      `const answer = page.locator("#answer");
      return await waitForOutcome({
        empty: answer.getByText("No rooms match your dates", { exact: true }),
        results: answer.getByRole("list", { name: "Rooms", exact: true }),
      }, { action: () => page.getByRole("button", { name: "Search" }).click(), timeout: 3000, unchangedMs: 5000 });`,
    ),
  ).toEqual({ result: "empty" });
});
