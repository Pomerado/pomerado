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
