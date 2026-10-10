import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Either, Schema } from "effect";
import { waitCode } from "../../src/browser/wait.js";
import { probeCallCode } from "../../src/runtime/host-execute.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { failure, runExample } from "./authoring-fixture.js";

// The runtime's page waits, run as a Kernel call body runs them (`page` in scope) on local pages.
// Chromium must render them: visibility, DOM changes and the page's requests are what they watch.
// Every budget is injected, so each test ends in well under 3 s.
const call = async (page: Page, body: string, prefix = waitCode) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${prefix}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://rooms.example.test";

/** Serves `html` at the origin's root, every other path through `api`, and opens the root. */
const site = async (
  page: Page,
  html: string,
  api: (path: string) => Promise<{ status?: number; body: string; contentType?: string }> = async () => ({
    body: "",
  }),
) => {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    const answer = await api(url.pathname);
    await route.fulfill({
      status: answer.status ?? 200,
      contentType: answer.contentType ?? "application/json",
      body: answer.body,
    });
  });
  await page.goto(`${origin}/`);
};

const rooms = `<ul aria-label="Rooms"><li>Garden room</li><li>Courtyard room</li></ul>`;

// Refusal and error first, then the empty state, then results, with injected budgets.
const outcomeBody = (options: string) => `
  const answer = page.locator("#answer");
  const started = Date.now();
  try {
    const shown = await waitForOutcome({
      failed: answer.getByRole("alert"),
      empty: answer.getByText("No rooms match your dates", { exact: true }),
      results: answer.getByRole("list", { name: "Rooms", exact: true }),
    }, { ${options} });
    return { shown, ms: Date.now() - started, report: waitReport() };
  } catch (error) {
    return { reason: error.reason, message: error.message, ms: Date.now() - started, progress: error.progress };
  }
`;

interface OutcomeAnswer {
  readonly shown?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly ms: number;
  readonly report?: readonly { readonly summary: string }[];
}

const outcome = async (page: Page, options: string): Promise<OutcomeAnswer> => {
  const answer = await call(page, outcomeBody(options));
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as OutcomeAnswer;
};

test("a quiet page that shows none of the answers fails as outcome_unknown long before its cap", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><h1>Something else entirely</h1></section>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 2000");
  // Its 2 s cap would have made it an outcome_timeout.
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.message).toMatch(
    /^outcome_unknown after \d+ ms, 300 ms without progress, no outcome showing: failed 0 visible of 0, empty 0 visible of 0, results 0 visible of 0; no progress seen$/u,
  );
});

test("a page showing a loading sign keeps the wait alive past the no-progress window", async ({
  page,
}) => {
  await page.setContent(`
    <section id="answer"><div aria-busy="true">Searching</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/^waitForOutcome: "results" showed after \d+ ms .*progress seen: loading sign /u);
});

test("the site's own loading sign counts once it is named, and a page without it fails fast", async ({
  page,
}) => {
  const html = `
    <section id="answer"><div class="wheel">Please hold</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`;
  await page.setContent(html);
  expect((await outcome(page, `noProgressMs: 300, timeout: 3000, loading: page.locator(".wheel")`)).shown).toBe(
    "results",
  );
  await page.setContent(html);
  expect((await outcome(page, "noProgressMs: 300, timeout: 3000")).reason).toBe("outcome_unknown");
});

test("beacons and a repeating poll are not progress", async ({ page }) => {
  await site(
    page,
    `<section id="answer"><p>Welcome</p></section>
    <script>
      let n = 0;
      setInterval(() => {
        n += 1;
        new Image().src = "/pixel.gif?n=" + n;
        navigator.sendBeacon("/collect", String(n));
        fetch("/poll?n=" + n);
      }, 100);
    </script>`,
  );
  const answer = await outcome(page, "noProgressMs: 400, timeout: 3000");
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.message).toMatch(/ignored \d+ repeating requests$/u);
});

test("the site's own request in flight keeps the wait alive until its answer renders", async ({
  page,
}) => {
  await site(
    page,
    `<button type="button">Search</button><section id="answer"></section>
    <script>
      document.querySelector("button").onclick = async () => {
        const response = await fetch("/api/rooms");
        document.querySelector("#answer").innerHTML = (await response.json()).html;
      };
    </script>`,
    async (path) => {
      if (path !== "/api/rooms") return { body: "{}" };
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { body: JSON.stringify({ html: rooms }) };
    },
  );
  const answer = await outcome(
    page,
    `noProgressMs: 300, timeout: 3000, siteDomain: "example.test", action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/site request/u);
});

test("changes inside the named region are progress, and the same changes elsewhere are not", async ({
  page,
}) => {
  const html = `
    <section id="answer"><p id="status">Checking source 0</p></section>
    <script>
    {
      let n = 0;
      const ticker = setInterval(() => { document.querySelector("#status").textContent = "Checking source " + (n += 1); }, 100);
      setTimeout(() => { clearInterval(ticker); document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    }
    </script>`;
  await page.setContent(html);
  expect(
    await outcome(page, `noProgressMs: 300, timeout: 3000, region: page.locator("#answer")`),
  ).toMatchObject({ shown: "results" });
  await page.setContent(html);
  expect((await outcome(page, "noProgressMs: 300, timeout: 3000")).reason).toBe("outcome_unknown");
});

test("a URL that keeps changing is progress", async ({ page }) => {
  await site(
    page,
    `<section id="answer"><p>Loading step</p></section>
    <script>
      let step = 0;
      const steps = setInterval(() => history.replaceState(null, "", "/?step=" + (step += 1)), 150);
      setTimeout(() => { clearInterval(steps); document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`,
  );
  const answer = await outcome(page, "noProgressMs: 300, timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/URL change/u);
});

test("a page still progressing at the cap fails as outcome_timeout and says what it saw", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><div aria-busy="true">Searching</div></section>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 800");
  expect(answer.reason).toBe("outcome_timeout");
  expect(answer.message).toMatch(
    /^outcome_timeout after 800 ms: failed 0 visible of 0, empty 0 visible of 0, results 0 visible of 0; progress seen: loading sign \d\.\d s–\d\.\d s/u,
  );
});

test("after an action, a decorative loading sign from before it is not progress", async ({ page }) => {
  await page.setContent(`
    <div role="progressbar" aria-label="Step 2 of 3"></div>
    <button type="button">Search</button>
    <section id="answer"></section>`);
  const answer = await outcome(
    page,
    `noProgressMs: 300, timeout: 2000, action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.reason).toBe("outcome_unknown");
});

// A results page: `identified` rows with an ID fill at `rowsMs`; their prices show a skeleton
// until `priceMs` (never when null); `slots` unidentified slots fill at `slotsMs`.
const resultsPage = (
  page: Page,
  options: { identified: number; rowsMs: number; priceMs: number | null; slots?: number; slotsMs?: number },
) =>
  page.setContent(`
    <ol id="results"></ol>
    <script>
      const list = document.querySelector("#results");
      setTimeout(() => {
        for (let i = 1; i <= ${options.identified}; i += 1)
          list.insertAdjacentHTML("beforeend",
            '<li data-id="room-' + i + '"><h3>Room ' + i + '</h3><span class="price skeleton"></span></li>');
      }, ${options.rowsMs});
      ${
        options.priceMs === null
          ? ""
          : `setTimeout(() => {
        for (const price of document.querySelectorAll(".price")) {
          price.classList.remove("skeleton");
          price.textContent = "$" + (100 + Number(price.parentElement.dataset.id.slice(5)));
        }
      }, ${options.priceMs});`
      }
      setTimeout(() => {
        for (let i = 0; i < ${options.slots ?? 0}; i += 1)
          list.insertAdjacentHTML("beforeend", '<li class="sponsored"><h3>Sponsored</h3></li>');
      }, ${options.slotsMs ?? 0});
    </script>`);

// A search tool that waits for the rows it returns, run through the runtime as a hosted run is.
const searchTool = (count: number, options = "") =>
  defineOperation(
    {
      input: Schema.Struct({}),
      output: Schema.Struct({
        rooms: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, price: Schema.String })),
      }),
    },
    async ({ kernel, sessionId, errors }) => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 10,
        code: `${waitCode}
          const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3", price: ".price" }, {
            count: ${count}, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, ${options}
          });
          return rows.map((row) => ({ id: row.key, name: row.name, price: row.price }));`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return { rooms: answer.result as { id: string; name: string; price: string }[] };
    },
  );

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `room-${index + 1}`,
    name: `Room ${index + 1}`,
    price: `$${101 + index}`,
  }));

test("a search returns its first rows once they fill, without waiting for slots filled later", async ({
  page,
}) => {
  await resultsPage(page, { identified: 5, rowsMs: 100, priceMs: 200, slots: 20, slotsMs: 2500 });
  const started = Date.now();
  const run = await runExample(page, searchTool(5), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(5) });
  // A wait for the whole list would have ended only after the late slots filled.
  expect(Date.now() - started).toBeLessThan(2500);
});

test("a price the page fills late is returned filled, never empty", async ({ page }) => {
  await resultsPage(page, { identified: 3, rowsMs: 50, priceMs: 400 });
  const run = await runExample(page, searchTool(3), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(3) });
});

test("fewer rows than asked are returned once their count holds", async ({ page }) => {
  await resultsPage(page, { identified: 3, rowsMs: 50, priceMs: 100 });
  const run = await runExample(page, searchTool(5), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(3) });
});

test("a needed value still loading when progress stops fails the run as a browser action timeout", async ({
  page,
}) => {
  await resultsPage(page, { identified: 2, rowsMs: 50, priceMs: null });
  const run = await runExample(page, searchTool(2), {});
  const failed = failure(run.result) as { _tag: string; message: string };
  expect(failed._tag).toBe("BrowserActionTimeout");
  expect(failed.message).toMatch(
    /^values_loading after \d+ ms, 400 ms without progress: 2 identified rows of 2, needed 2; price still loading in rows 1, 2; /u,
  );
});

test("an infinite list stops at the rows asked for, or where the list ends", async ({ page }) => {
  const list = (total: number) =>
    page.setContent(`
      <ol id="results"></ol><button type="button">More</button>
      <script>
      {
        let shown = 0;
        const more = () => setTimeout(() => {
          const until = Math.min(shown + 10, ${total});
          for (; shown < until; ) {
            shown += 1;
            document.querySelector("#results").insertAdjacentHTML("beforeend",
              '<li data-id="r' + shown + '"><h3>Row ' + shown + '</h3></li>');
          }
        }, 100);
        more();
        document.querySelector("button").onclick = more;
      }
      </script>`);
  const body = (count: number) => `
    const rows = page.locator("#results > li");
    let read = await waitForRows(rows, { name: "h3" }, { count: Math.min(${count}, 10), key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 50, unchangedMs: 300 });
    while (read.rows.length < ${count}) {
      const before = read.rows.length;
      read = await waitForRows(rows, { name: "h3" }, {
        count: ${count}, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 50, unchangedMs: 300,
        action: () => page.getByRole("button", { name: "More" }).click({ timeout: 1000 }),
      });
      if (read.rows.length === before) break;
    }
    return read.rows.map((row) => row.key);`;
  await list(40);
  const asked = await call(page, body(25));
  expect(asked.result).toEqual(Array.from({ length: 25 }, (_, index) => `r${index + 1}`));
  await list(18);
  const ended = await call(page, body(25));
  expect(ended.result).toEqual(Array.from({ length: 18 }, (_, index) => `r${index + 1}`));
});

test("a record's values are waited for until filled and holding, and an optional one may be absent", async ({
  page,
}) => {
  await page.setContent(`
    <main><h1>Garden room</h1><p id="price">Loading…</p></main>
    <script>
      setTimeout(() => { document.querySelector("#price").textContent = "$120"; }, 200);
      setTimeout(() => { document.querySelector("#price").textContent = "$125"; }, 350);
    </script>`);
  const answer = await call(
    page,
    `const { values } = await waitForValues({
      title: page.getByRole("heading", { level: 1 }),
      price: page.locator("#price"),
      rating: { locator: page.locator("#rating"), optional: true },
    }, { noProgressMs: 400, stableMs: 300 });
    return values;`,
  );
  expect(answer.result).toEqual({ title: "Garden room", price: "$125", rating: null });
});

test("a needed value that never shows fails and names it", async ({ page }) => {
  await page.setContent(`<main><h1>Garden room</h1></main>`);
  const answer = await call(
    page,
    `await waitForValues({ title: page.getByRole("heading", { level: 1 }), price: page.locator("#price") }, { noProgressMs: 300 });`,
  );
  expect(answer.error).toMatch(/^values_loading after \d+ ms, 300 ms without progress: price missing; no progress seen$/u);
});

// A booking quote: choosing guests shows a spinner for `spinnerMs`, then the total becomes `total`.
const quotePage = (page: Page, total: string, spinnerMs: number | null) =>
  page.setContent(`
    <label>Guests <select id="guests"><option>2</option><option>3</option></select></label>
    <div id="spinner" hidden>Updating price</div>
    <p id="total">$240</p>
    <script>
      document.querySelector("#guests").onchange = () => {
        ${spinnerMs === null ? "" : `document.querySelector("#spinner").hidden = false;`}
        setTimeout(() => {
          document.querySelector("#spinner").hidden = true;
          document.querySelector("#total").textContent = ${JSON.stringify(total)};
        }, ${spinnerMs ?? 0});
      };
    </script>`);

const changeBody = `
  const started = Date.now();
  const read = await waitForChange({ total: page.locator("#total") }, {
    action: () => page.locator("#guests").selectOption("3", { timeout: 1000 }),
    loading: page.locator("#spinner"),
    noProgressMs: 400,
    stableMs: 100,
    unchangedMs: 300,
  });
  return { ...read, ms: Date.now() - started };`;

test("after a choice, the dependent total is the new one, never the stale one", async ({ page }) => {
  await quotePage(page, "$360", 600);
  const answer = (await call(page, changeBody)).result as { values: unknown; changed: boolean };
  expect(answer).toMatchObject({ values: { total: "$360" }, changed: true });
});

test("a total that stays the same counts only after the loading sign went", async ({ page }) => {
  await quotePage(page, "$240", 500);
  const answer = (await call(page, changeBody)).result as { values: unknown; changed: boolean; ms: number };
  expect(answer).toMatchObject({ values: { total: "$240" }, changed: false });
  expect(answer.ms).toBeGreaterThanOrEqual(800);
  // With no loading sign at all, the same total counts after the unchanged window.
  await quotePage(page, "$240", null);
  const quiet = (await call(page, changeBody)).result as { changed: boolean; ms: number };
  expect(quiet.changed).toBe(false);
  expect(quiet.ms).toBeLessThan(800);
});

test("a probe call acts with a short default timeout, and later calls get Playwright's back", async ({
  page,
}) => {
  await page.setContent(`
    <p>Nothing to click</p>
    <script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<p id="late">Late</p>'), 900);</script>`);
  const failed = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: probeCallCode(`await page.getByRole("button", { name: "Apply" }).click();`, 200),
  });
  expect(failed.success).toBe(false);
  expect(String(failed.error)).toMatch(/Timeout 200ms exceeded/u);
  const later = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `await page.locator("#late").waitFor(); return "seen";`,
  });
  expect(later).toEqual({ success: true, result: "seen" });
});
