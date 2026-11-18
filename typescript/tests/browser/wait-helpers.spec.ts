import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { chromium as patchright } from "patchright";
import { Either, Schema } from "effect";
import { outcomeWaitCode } from "../../src/browser/outcome-wait.js";
import { confirmCommitCode, waitCode } from "../../src/browser/wait.js";
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
  readonly report?: readonly { readonly summary: string; readonly looks: number }[];
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

test("an answer already on the page returns at the first look, with no second look to confirm it", async ({
  page,
}) => {
  await page.setContent(`<section id="answer">${rooms}</section>`);
  const answer = await outcome(page, "timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.looks).toBe(1);
  expect(answer.report?.[0]?.summary).toMatch(/^waitForOutcome: "results" showed after \d+ ms \(1 look\); /u);
});

// A cancel whose page shows the site's in-between banner after `workingMs`, then its final one
// after `doneMs` (never when null).
const cancelPage = (page: Page, workingMs: number, doneMs: number | null) =>
  page.setContent(`
    <button type="button" id="cancel">Cancel order</button><div id="answer"></div>
    <script>
      const show = (html) => { document.querySelector("#answer").innerHTML = html; };
      document.querySelector("#cancel").onclick = () => {
        setTimeout(() => show('<div role="alert" class="info">Attempting to cancel</div>'), ${workingMs});
        ${doneMs === null ? "" : `setTimeout(() => show('<div class="success">Cancelled</div>'), ${doneMs});`}
      };
    </script>`);

const cancelWait = `waitForOutcomeResult({ cancelled: page.locator(".success"), attempting: page.locator(".info") }, {
    action: () => page.locator("#cancel").click(), pending: "attempting", noProgressMs: 400, timeout: 600,
  })`;

test("an in-between answer named pending holds the wait past the no-progress window and the timeout for the final one", async ({
  page,
}) => {
  await cancelPage(page, 100, 1500);
  const answer = await call(page, `const started = Date.now();
    const { outcome } = await ${cancelWait};
    return { outcome, ms: Date.now() - started };`);
  expect(answer.result).toMatchObject({ outcome: "cancelled" });
  expect((answer.result as { ms: number }).ms).toBeGreaterThanOrEqual(1400);
});

test("a pending outcome counts only once the action brought it, and only as something the page shows", async ({
  page,
}) => {
  await page.setContent(`<button type="button" id="cancel">Cancel order</button><div class="info">Attempting to cancel</div>`);
  const answer = await call(page, `try {
      return (await waitForOutcomeResult({ cancelled: page.locator(".success"), attempting: page.locator(".info") }, {
        action: () => page.locator("#cancel").click(), pending: "attempting", noProgressMs: 400, timeout: 1000, unchangedMs: 200,
      })).outcome;
    } catch (error) {
      return error.reason;
    }`);
  // The banner from before the click never holds the wait, which ends at its cap as before.
  expect(answer.result).toBe("outcome_timeout");
  const refused = await call(page, `await waitForOutcome({ sent: { response: { method: "POST" } }, done: page.locator(".success") }, {
      action: () => page.locator("#cancel").click(), pending: "sent",
    });`);
  expect(refused.error).toContain('waitForOutcome pending "sent" names a response outcome; pending takes outcomes the page shows');
  // A locator passed as pending fails naming the fix, before the action runs.
  const locator = await call(page, `await waitForOutcome({ cancelled: page.locator(".success") }, {
      action: () => page.locator("#cancel").click(), pending: page.locator(".info"),
    });`);
  expect(locator.error).toContain(
    "waitForOutcome pending takes outcome keys, not locators: add the locator to the outcomes and name its key in pending",
  );
});

test("an in-between answer still showing as the call nears its end is the answer, which confirmCommit reports pending", async ({
  page,
}) => {
  await cancelPage(page, 100, null);
  const tool = defineOperation({ input: Schema.Struct({}), output: Schema.Unknown }, async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 8,
      code: `${waitCode}
        ${confirmCommitCode}
        const started = Date.now();
        const answer = await ${cancelWait};
        return { outcome: answer.outcome, pending: answer.pending, ms: Date.now() - started, confirmed: await confirmCommit(answer, page) };`,
    });
    if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    return answer.result;
  });
  const run = await runExample(page, tool, {});
  const result = Either.getOrUndefined(run.result) as { ms: number };
  expect(result).toMatchObject({
    outcome: "attempting",
    pending: true,
    confirmed: {
      state: "done",
      status: "pending",
      status_label: "Attempting to cancel",
      reason: '"attempting" was still pending when the wait ended, with no error on the page',
    },
  });
  // The hold ends 5 s before the call's own end, a second before its 8 s timeout.
  expect(result.ms).toBeGreaterThanOrEqual(1500);
  expect(result.ms).toBeLessThan(3500);
});

test("a page showing a loading sign keeps the wait alive past the no-progress window", async ({
  page,
}) => {
  // A generic sign counts until it has held for the no-progress window, and the window then runs.
  await page.setContent(`
    <section id="answer"><div aria-busy="true">Searching</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`);
  const answer = await outcome(page, "noProgressMs: 700, timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/^waitForOutcome: "results" showed after \d+ ms .*progress seen: loading sign /u);
});

test("the site's own loading sign counts once it is named, and a page without it fails fast", async ({
  page,
}) => {
  const html = `
    <section id="answer"><div class="wheel">Please hold</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 1500);
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
  // The site's own sign, named, counts for as long as it shows.
  const answer = await outcome(page, `noProgressMs: 300, timeout: 800, loading: page.locator('[aria-busy="true"]')`);
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

test("a review step that counts down, then sends on its own behind a spinner, keeps the wait until the site answers", async ({
  page,
}) => {
  // The click opens a review dialog whose button counts down. At zero the page sends the order
  // itself, shows a spinner while it sends, then shows its error. Neither the countdown nor the
  // spinner is named, and nothing else on the page changes.
  await page.setContent(`
    <button type="button" id="place">Place order</button>
    <section id="answer"></section>
    <script>
      document.querySelector("#place").onclick = () => {
        document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><button type="button" id="confirm">Confirm (0:05)</button></div>');
        let left = 5;
        const timer = setInterval(() => {
          left -= 1;
          document.querySelector("#confirm").textContent = "Confirm (0:" + String(left).padStart(2, "0") + ")";
          if (left > 0) return;
          clearInterval(timer);
          document.querySelector("#confirm").textContent = "Sending order";
          document.body.insertAdjacentHTML("beforeend", '<span class="spinner">.</span>');
          setTimeout(() => {
            document.querySelector(".spinner").remove();
            document.querySelector("#answer").innerHTML = '<div role="alert">The order could not be placed</div>';
          }, 1200);
        }, 150);
      };
    </script>`);
  const answer = await outcome(
    page,
    `noProgressMs: 400, timeout: 4000, action: () => page.locator("#place").click()`,
  );
  expect(answer.shown).toBe("failed");
  expect(answer.report?.[0]?.summary).toMatch(/progress seen: .*countdown/u);
});

// A checkout like a hosted ordering page's: Place order shows a spinner, then a countdown, then
// sends the order to the site's API on another registrable domain, which declines it, and the page
// shows its error dialog. The tool's wait names only a new page and fields marked invalid.
const declinePage = (page: Page) =>
  Promise.all([
    page.route("https://orders.example-api.test/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: "declined" }),
      });
    }),
    site(
      page,
      `<form id="checkout" aria-label="Checkout" novalidate>
        <input aria-label="Phone" value="555-0100">
        <button type="button" id="place">Place order</button>
      </form>
      <div id="status" aria-live="polite"></div>
      <script>
        document.querySelector("#place").onclick = () => {
          document.querySelector("#status").textContent = "Placing order...";
          document.body.insertAdjacentHTML("beforeend", '<span class="spinner">.</span>');
          setTimeout(() => {
            document.querySelector(".spinner").remove();
            document.body.insertAdjacentHTML("beforeend", '<p id="hold">Sending in 0:05</p>');
            let left = 5;
            const timer = setInterval(async () => {
              left -= 1;
              document.querySelector("#hold").textContent = "Sending in 0:0" + left;
              if (left > 0) return;
              clearInterval(timer);
              document.querySelector("#hold").remove();
              await fetch("https://orders.example-api.test/graphql", { method: "POST", body: "{}" });
              document.body.insertAdjacentHTML("beforeend",
                '<div role="alertdialog" aria-modal="true"><h2>We could not place your order.</h2>' +
                '<p>Please try again.</p></div>');
            }, 150);
          }, 300);
        };
      </script>`,
    ),
  ]);

// The place step's wait, with the reason, message and evidence of how it failed.
const placeWait = `
  try {
    return { shown: await waitForOutcome({
      changed: { url: (url) => url.pathname === "/confirmation" },
      invalid: { invalid: page.locator("#checkout") },
    }, { action: () => page.locator("#place").click(), noProgressMs: 600, timeout: 5000 }) };
  } catch (error) {
    return { reason: error.reason, message: error.message, evidence: error.evidence };
  }`;

// What the runtime declares ahead of a commit's own call, the first after `enteringCommit`.
const commitCall = "const __pomeradoCommitting = true;";

test("a commit whose site shows its error dialog after a spinner, a countdown and an order call to another host fails as the site's refusal", async ({
  page,
}) => {
  await declinePage(page);
  const refused = await call(page, placeWait, `${commitCall}${waitCode}`);
  expect(refused.result).toMatchObject({
    reason: "outcome_refused",
    evidence: {
      messages: [
        "We could not place your order. Please try again.",
      ],
    },
  });
  expect((refused.result as { message: string }).message).toMatch(
    /^outcome_refused after \d+ ms, no outcome showing, the page shows the site's refusal "We could not place your order\. Please try again\.": changed URL not matched, invalid 0 invalid fields; progress seen: .*countdown/u,
  );
  // Any other call's wait, a read's or one before the commit, still ends outcome_unknown.
  await declinePage(page);
  expect(await call(page, placeWait)).toMatchObject({ result: { reason: "outcome_unknown" } });
});

test("after a commit's click, only a new message confirmCommit judges not done ends the wait as the site's refusal", async ({
  page,
}) => {
  const cases = [
    { name: "an error-styled message that says the payment failed", before: "", after: '<p class="error">Payment failed</p>', reason: "outcome_refused" },
    { name: "an alert that says neither error nor success", before: "", after: '<div role="alert">Your order is being reviewed</div>', reason: "outcome_unknown" },
    { name: "a message that only says declined", before: "", after: '<div role="alert">Your card was declined</div>', reason: "outcome_unknown" },
    { name: "an error beside a success", before: "", after: '<div role="alert">Order submitted. We could not send the receipt, please try again later</div>', reason: "outcome_unknown" },
    { name: "an error banner shown before the click", before: '<div role="alert">Payment failed</div>', after: "", reason: "outcome_unknown" },
    { name: "a form's own check of a field", before: "", after: '<p class="error">Please select a tip. This field is required.</p>', reason: "outcome_unknown" },
    { name: "a decline that asks for another choice", before: "", after: '<p class="error">Your payment was declined. Please choose another payment method.</p>', reason: "outcome_refused" },
  ];
  for (const each of cases) {
    await page.setContent(`
      <form id="checkout" novalidate><button type="button" id="place">Place order</button></form>
      ${each.before}
      <section id="answer"></section>
      <script>
        document.querySelector("#place").onclick = () =>
          setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(each.after)}; }, 100);
      </script>`);
    const answer = await call(
      page,
      `try {
        return await waitForOutcome({ placed: page.locator(".placed") }, {
          action: () => page.locator("#place").click(), noProgressMs: 300, timeout: 2000,
        });
      } catch (error) {
        return error.reason;
      }`,
      `${commitCall}${waitCode}`,
    );
    expect(answer.result, each.name).toBe(each.reason);
  }
});

test("a commit's wait takes several new matches of its winning outcome that read differently, unless another outcome shows or one is from before the click", async ({
  page,
}) => {
  const placed = '<p class="placed">Order placed.</p>';
  const sent = '<p class="placed">Receipt sent to your email.</p>';
  const failed = '<p class="failed">Payment failed.</p>';
  const cases = [
    { name: "two new success messages", before: "", after: placed + sent, commit: "success", read: "outcome_ambiguous" },
    { name: "two new success messages beside a new failure", before: "", after: placed + sent + failed, commit: "outcome_ambiguous" },
    { name: "a success message from before the click beside a new failure", before: placed, after: failed, commit: "failed" },
    { name: "a success message from before the click alone", before: placed, after: "", commit: "success" },
    { name: "two success messages from before the click alone", before: placed + sent, after: "", commit: "outcome_ambiguous" },
    { name: "a success message from before the click beside a new one", before: placed, after: sent, commit: "outcome_ambiguous" },
  ];
  for (const each of cases) {
    for (const [prefix, expected] of [[`${commitCall}${waitCode}`, each.commit], [waitCode, each.read]] as const) {
      if (expected === undefined) continue;
      await page.setContent(`
        <button type="button" id="buy">Buy now</button>
        <section id="answer">${each.before}</section>
        <script>
          document.querySelector("#buy").onclick = () => setTimeout(() =>
            document.querySelector("#answer").insertAdjacentHTML("beforeend", ${JSON.stringify(each.after)}), 50);
        </script>`);
      const answer = await call(
        page,
        `try {
          return await waitForOutcome({
            success: page.locator(".placed"),
            checkpoint: page.locator(".checkpoint"),
            failed: page.locator(".failed"),
          }, { action: () => page.locator("#buy").click(), unchangedMs: 800, noProgressMs: 2000, timeout: 4000 });
        } catch (error) {
          return error.reason;
        }`,
        prefix,
      );
      expect(answer.result, `${each.name}, ${prefix === waitCode ? "a read" : "a commit"}`).toBe(expected);
    }
  }
});

test("after a commit's click, a native dialog no outcome names that says the order failed is the site's refusal", async ({
  page,
}) => {
  // With a status, the order first goes to another host, which answers so.
  for (const [said, commit, reason, status] of [
    ["Placing your order failed", true, "outcome_refused", undefined],
    ["Your order is being prepared", true, "outcome_unknown", undefined],
    ["Placing your order failed", false, "outcome_unknown", undefined],
    ["Placing your order failed", true, "outcome_unknown", 503],
    ["Placing your order failed", true, "outcome_refused", 402],
  ] as const) {
    await page.unrouteAll();
    await page.route("https://orders.example-api.test/**", (route) =>
      route.fulfill({ status: status ?? 200, headers: { "access-control-allow-origin": "*" }, body: "{}" }),
    );
    await site(
      page,
      `<button type="button" id="place">Place order</button>
      <script>document.querySelector("#place").onclick = async () => {
        ${status === undefined ? "" : 'await fetch("https://orders.example-api.test/orders", { method: "POST" });'}
        setTimeout(() => alert(${JSON.stringify(said)}), 50);
      };</script>`,
    );
    const answer = await call(
      page,
      `try {
        await waitForOutcome({ placed: page.locator(".placed"), notice: { dialog: "confirm" } }, {
          action: () => page.locator("#place").click(), noProgressMs: 300, timeout: 2000,
        });
      } catch (error) {
        await error.dialog?.dismiss();
        return { reason: error.reason, evidence: error.evidence };
      }`,
      commit ? `${commitCall}${waitCode}` : waitCode,
    );
    expect(answer.result, `${said}, ${commit ? "a commit" : "no commit"}, ${status ?? "no order call"}`).toEqual({
      reason,
      ...(reason === "outcome_refused" ? { evidence: { type: "alert", message: said } } : {}),
    });
  }
});

// The commit's answer came with the call's first wait, whether its click was the wait's action or
// came before it. A later wait's click, such as one that opens the receipt, shows errors of its own,
// never the commit's.
test("in a commit's call, a wait after the first never reads the site's refusal", async ({ page }) => {
  for (const placing of [
    `await waitForOutcome({ placed: page.locator(".placed") }, {
      action: () => page.locator("#place").click(), noProgressMs: 300, timeout: 2000,
    })`,
    `await page.locator("#place").click(),
    await waitForOutcome({ placed: page.locator(".placed") }, { noProgressMs: 300, timeout: 2000 })`,
  ]) {
    await page.setContent(`
      <button type="button" id="place">Place order</button>
      <button type="button" id="receipt">View receipt</button>
      <section id="answer"></section>
      <script>
        document.querySelector("#place").onclick = () =>
          setTimeout(() => { document.querySelector("#answer").innerHTML = '<p class="placed">Order placed</p>'; }, 100);
        document.querySelector("#receipt").onclick = () =>
          setTimeout(() => { document.querySelector("#answer").insertAdjacentHTML("beforeend", '<p class="error">Loading the receipt failed</p>'); }, 100);
      </script>`);
    const answer = await call(
      page,
      `const placed = (${placing});
      try {
        return [placed, await waitForOutcome({ receipt: page.locator(".receipt") }, {
          action: () => page.locator("#receipt").click(), noProgressMs: 300, timeout: 2000,
        })];
      } catch (error) {
        return [placed, error.reason];
      }`,
      `${commitCall}${waitCode}`,
    );
    expect(answer.result, placing).toEqual(["placed", "outcome_unknown"]);
  }
});

// A server error may come after the order saved, as confirmCommit reads one: the site's error then
// leaves the commit unclear. Only a request that may write counts, from any host.
test("in a commit's call, a server error to a request that may write keeps the site's error unclear", async ({ page }) => {
  for (const [method, status, reason] of [
    ["POST", 503, "outcome_unknown"],
    ["GET", 503, "outcome_refused"],
    ["POST", 402, "outcome_refused"],
  ] as const) {
    await page.unrouteAll();
    await page.route("https://orders.example-api.test/**", (route) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }),
    );
    await site(
      page,
      `<button type="button" id="place">Place order</button>
      <section id="answer"></section>
      <script>
        document.querySelector("#place").onclick = async () => {
          await fetch("https://orders.example-api.test/orders", { method: ${JSON.stringify(method)} });
          document.querySelector("#answer").innerHTML = '<div role="alert">Payment failed. Please try again.</div>';
        };
      </script>`,
    );
    const answer = await call(
      page,
      `try {
        return await waitForOutcome({ placed: page.locator(".placed") }, {
          action: () => page.locator("#place").click(), noProgressMs: 300, timeout: 2000,
        });
      } catch (error) {
        return error.reason;
      }`,
      `${commitCall}${waitCode}`,
    );
    expect(answer.result, `${method} ${status}`).toBe(reason);
  }
});

// The order may still go through while a request that may write, sent to any host since the click,
// has no answer: the site's error, shown on a timer of the page's own, then leaves the commit
// unclear. One answered with a failure, a read, or a request sent before the click doesn't.
test("in a commit's call, a request that may write still unanswered keeps the site's error unclear", async ({ page }) => {
  for (const [method, order, shows, reason] of [
    ["POST", "unanswered", "message", "outcome_unknown"],
    ["POST", "unanswered", "dialog", "outcome_unknown"],
    ["POST", "no answer, failed", "message", "outcome_unknown"],
    ["POST", 402, "message", "outcome_refused"],
    ["POST", 402, "dialog", "outcome_refused"],
    ["POST", "none", "message", "outcome_refused"],
    ["GET", "unanswered", "message", "outcome_refused"],
    ["POST", "unanswered, sent before the click", "message", "outcome_refused"],
  ] as const) {
    await page.unrouteAll();
    await page.route("https://orders.example-api.test/**", (route) =>
      order === 402
        ? route.fulfill({ status: 402, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" })
        : order === "no answer, failed" ? route.abort() : undefined,
    );
    const send = `fetch("https://orders.example-api.test/orders", { method: ${JSON.stringify(method)} }).catch(() => undefined)`;
    await site(
      page,
      `<button type="button" id="place">Place order</button>
      <section id="answer"></section>
      <script>
        ${order === "unanswered, sent before the click" ? send + ";" : ""}
        document.querySelector("#place").onclick = async () => {
          const sent = ${order === "none" || order === "unanswered, sent before the click" ? "undefined" : send};
          await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, 200))]);
          ${shows === "dialog" ? 'alert("Placing your order failed");' : `document.querySelector("#answer").innerHTML = '<div role="alert">Payment failed. Please try again.</div>';`}
        };
      </script>`,
    );
    const answer = await call(
      page,
      `try {
        return await waitForOutcome({ placed: page.locator(".placed"), notice: { dialog: "confirm" } }, {
          action: () => page.locator("#place").click(), noProgressMs: 300, timeout: 2000,
        });
      } catch (error) {
        await error.dialog?.dismiss();
        return error.reason;
      }`,
      `${commitCall}${waitCode}`,
    );
    expect(answer.result, `${method} ${order}, ${shows}`).toBe(reason);
  }
});

// A paying step names the site's alert or dialog as an outcome beside the order's response. Its
// error, shown on a timer of the page's own while a request that may write has no answer, waits
// for that answer: once it comes, the outcomes decide as before. With none in time, or after a
// server error, the commit is unclear, even once the error left. A success its words say, even in an
// alert, a control in a dialog, or any wait outside a commit's call, decides at once.
test("in a commit's call, the site's alert, dialog or field errors named as an outcome wait for an unanswered request that may write", async ({
  page,
}) => {
  for (const [path, answer, shows, commit, expected] of [
    ["/orders", "none", "alert", true, "outcome_unknown"],
    ["/orders", "none", "dialog", true, "outcome_unknown"],
    ["/orders", "none", "field errors", true, "outcome_unknown"],
    ["/orders", "none", "a modal", true, "outcome_unknown"],
    ["/orders", "none", "an alert that leaves once read", true, "outcome_unknown"],
    ["/orders", "none", "an alert still faded out", true, "outcome_unknown"],
    ["/orders", "none", "an alert that negates a success", true, "outcome_unknown"],
    ["/orders", "none", "an error in a success-styled alert", true, "outcome_unknown"],
    ["/orders", 503, "alert", true, "outcome_unknown"],
    ["/orders", 402, "alert", true, "declined"],
    ["", "none", "alert", true, "declined"],
    ["/orders", "200 after 300 ms", "alert", true, "order"],
    ["/collect", "204 after 300 ms", "alert", true, "declined"],
    ["/orders", "none", "a success", true, "placed"],
    ["/orders", "none", "a success in an alert", true, "placed"],
    ["/orders", "none", "a button in a dialog", true, "upsell"],
    ["/orders", "none", "alert", false, "declined"],
  ] as const) {
    await page.unrouteAll();
    await page.route("https://orders.example-api.test/**", async (route) => {
      if (answer === "none") return;
      const [status, after] = typeof answer === "number" ? [answer, 0] : [Number(answer.slice(0, 3)), 300];
      await new Promise((resolve) => setTimeout(resolve, after));
      // A page the next case opens may have cancelled the request by now.
      await route.fulfill({ status, headers: { "access-control-allow-origin": "*" }, body: status === 204 ? "" : "{}" }).catch(() => undefined);
    });
    const show = {
      alert: `document.querySelector("#answer").innerHTML = '<div role="alert">Payment failed. Please try again.</div>';`,
      dialog: 'alert("Placing your order failed");',
      "field errors": 'document.querySelector("#card").setAttribute("aria-invalid", "true");',
      "a modal": `document.querySelector("#answer").innerHTML = '<div role="dialog" aria-modal="true"><h2>Your card was declined.</h2></div>';`,
      // The alert goes as soon as the wait has read it, before anything else looks at it.
      "an alert that leaves once read": `const alert = document.createElement("div");
        alert.setAttribute("role", "alert");
        alert.textContent = "Payment failed. Please try again.";
        Object.defineProperty(alert, "innerText", { get() { setTimeout(() => alert.remove()); return "Payment failed. Please try again."; } });
        document.querySelector("#answer").append(alert);`,
      "a success": `document.querySelector("#answer").innerHTML = '<p class="placed">Order placed</p>';`,
      "an alert still faded out": `document.querySelector("#answer").innerHTML = '<div role="alert" style="opacity: 0">Payment failed. Please try again.</div>';`,
      "an alert that negates a success": `document.querySelector("#answer").innerHTML = '<div role="alert">Your payment was not successful.</div>';`,
      "an error in a success-styled alert": `document.querySelector("#answer").innerHTML = '<div role="alert" class="alert alert-success">Something went wrong</div>';`,
      "a success in an alert": `document.querySelector("#answer").innerHTML = '<div role="alert" class="placed alert alert-success">Order confirmed. Thank you!</div>';`,
      "a button in a dialog": `document.querySelector("#answer").innerHTML = '<div role="dialog" aria-modal="true"><button type="button" class="upsell">No thanks</button></div>';`,
    }[shows];
    await site(
      page,
      `<form id="checkout" novalidate><input id="card" aria-label="Card number" value="4242"></form>
      <button type="button" id="place">Place order</button>
      <section id="answer"></section>
      <script>
        document.querySelector("#place").onclick = async () => {
          const sent = ${path === "" ? "undefined" : `fetch("https://orders.example-api.test${path}", { method: "POST" }).catch(() => undefined)`};
          await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, 100))]);
          ${show}
        };
      </script>`,
    );
    const result = await call(
      page,
      `try {
        const result = await waitForOutcomeResult({
          order: { response: (response) => response.url().endsWith("/orders") && response.status() < 400 },
          placed: page.locator(".placed"),
          upsell: page.locator(".upsell"),
          declined: page.getByRole("alert"),
          modal: page.getByRole("dialog"),
          notice: { dialog: true },
          invalid: { invalid: page.locator("#checkout") },
        }, { action: () => page.locator("#place").click(), noProgressMs: 1000, timeout: 3000 });
        await result.dialog?.dismiss();
        return result.outcome;
      } catch (error) {
        await error.dialog?.dismiss();
        return error.reason;
      }`,
      commit ? `${commitCall}${waitCode}` : waitCode,
    );
    expect.soft(result.result, `${path || "no request"} ${answer}, ${shows}, ${commit ? "a commit" : "no commit"}`).toBe(expected);
  }
});

test("a write whose commit the site declined behind its own dialog reports the step unsent, with the site's words", async ({
  page,
}) => {
  await declinePage(page);
  const tool = defineOperation(
    { input: Schema.Struct({}), output: Schema.Unknown, write: { confirmation: "readback", commits: ["place-order"] } },
    async ({ kernel, sessionId, errors, enteringCommit }) => {
      enteringCommit("place-order");
      const answer = await kernel.browsers.playwright.execute(sessionId, { timeout_sec: 8, code: `${waitCode}
        await waitForOutcome({
          changed: { url: (url) => url.pathname === "/confirmation" },
          invalid: { invalid: page.locator("#checkout") },
        }, { action: () => page.locator("#place").click(), noProgressMs: 600, timeout: 5000 });` });
      if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return answer.result;
    },
  );
  const run = await runExample(page, tool, {});
  expect((failure(run.result) as { message: string }).message).toMatch(
    /outcome_refused after \d+ ms, no outcome showing, the page shows the site's refusal "We could not place your order\./u,
  );
  expect(run.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
});

test("after an action, a timer already counting down before it is not progress, however long the look before it takes", async ({
  page,
}) => {
  // Until the click, each price's box takes 2 ms to measure, as a large page's first layout does,
  // so with 300 prices the look before the action outlasts a look's budget.
  for (const prices of [300, 0]) {
    await page.setContent(`
      <script>
        window.clicked = false;
        const box = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (!window.clicked && this.classList.contains("price")) for (const until = performance.now() + 2; performance.now() < until;);
          return box.call(this);
        };
      </script>
      ${'<p class="price">$12</p>'.repeat(prices)}
      <p>Held for <span id="hold">9:59</span></p>
      <button type="button" onclick="window.clicked = true">Search</button>
      <section id="answer"></section>
      <script>
        let left = 599;
        setInterval(() => {
          left -= 1;
          document.querySelector("#hold").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
        }, 100);
      </script>`);
    const answer = await outcome(
      page,
      `noProgressMs: 300, timeout: 2000, action: () => page.getByRole("button", { name: "Search" }).click()`,
    );
    expect(answer.reason, `${prices} prices`).toBe("outcome_unknown");
  }
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

test("a needed field a row lacks once the page stops changing fails as a page mismatch that names it", async ({
  page,
}) => {
  await page.setContent(`
    <ol id="results">
      <li data-id="room-1"><h3>Room 1</h3><span class="price">$101</span></li>
      <li data-id="room-2"><h3>Room 2</h3></li>
    </ol>`);
  const run = await runExample(page, searchTool(2), {});
  const failed = failure(run.result) as { _tag: string; message: string };
  expect(failed._tag).toBe("BrowserActionTimeout");
  expect(failed.message).toMatch(
    /^page_mismatch after \d+ ms, 400 ms without progress: 2 identified rows of 2, needed 2; price missing in row 2; /u,
  );
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
  expect(answer.error).toMatch(/^page_mismatch after \d+ ms, 300 ms without progress: price missing; no progress seen$/u);
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
  // Whether the page still showed its loading sign when the wait returned.
  const spinnerShowing = await page.locator("#spinner").isVisible();
  return { ...read, spinnerShowing, ms: Date.now() - started };`;

test("after a choice, the dependent total is the new one, never the stale one", async ({ page }) => {
  await quotePage(page, "$360", 600);
  const answer = (await call(page, changeBody)).result as { values: unknown; changed: boolean };
  expect(answer).toMatchObject({ values: { total: "$360" }, changed: true });
});

test("a total that stays the same counts only after the loading sign went", async ({ page }) => {
  await quotePage(page, "$240", 500);
  // It returns only once the sign went, never while the total was still being worked out.
  expect((await call(page, changeBody)).result).toMatchObject({
    values: { total: "$240" },
    changed: false,
    spinnerShowing: false,
  });
  // With no loading sign at all, the same total counts once the page was quiet for the unchanged
  // window.
  await quotePage(page, "$240", null);
  const quiet = (await call(page, changeBody)).result as { changed: boolean; ms: number };
  expect(quiet.changed).toBe(false);
  expect(quiet.ms).toBeLessThan(2000);
});

test("a hold timer the choice starts is no progress for a value wait, so an unchanged total still returns", async ({
  page,
}) => {
  await page.setContent(`
    <label>Guests <select id="guests"><option>2</option><option>3</option></select></label>
    <p id="total">$240</p>
    <p id="hold" hidden>Reserved for <span id="left">9:59</span></p>
    <script>
      document.querySelector("#guests").onchange = () => {
        document.querySelector("#hold").hidden = false;
        let left = 599;
        setInterval(() => {
          left -= 1;
          document.querySelector("#left").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
        }, 100);
      };
    </script>`);
  const answer = (await call(
    page,
    `const started = Date.now();
    const read = await waitForChange({ total: page.locator("#total") }, {
      action: () => page.locator("#guests").selectOption("3", { timeout: 1000 }),
      noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 3000,
    });
    return { ...read, ms: Date.now() - started };`,
  )).result as { values: unknown; changed: boolean; ms: number };
  expect(answer).toMatchObject({ values: { total: "$240" }, changed: false });
  expect(answer.ms).toBeLessThan(2000);
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

test("a before that is not the values object of the same fields is refused at once", async ({
  page,
}) => {
  await quotePage(page, "$240", null);
  const answer = await call(
    page,
    `await waitForChange({ total: page.locator("#total") }, { before: ["$240"], noProgressMs: 300 });`,
  );
  expect(answer.error).toMatch(/^waitForChange's before must be the values object/u);
});

// Decorative signs: a rating bar (a determinate progress bar), a quantity input whose class names
// a spinner, and a layout element whose class names one. None of them is the page loading.
const decorations = `<div role="progressbar" aria-valuenow="80" aria-valuemin="0" aria-valuemax="100" aria-label="Rating"></div><input type="number" class="qty-spinner" aria-label="Quantity" value="1"><span class="spinner-frame">&#9733;</span>`;

test("rows whose cards carry rating bars and spinner-named controls return promptly when fewer than asked", async ({
  page,
}) => {
  await page.setContent(`
    <ol id="results"></ol>
    <script>
      setTimeout(() => {
        for (let i = 1; i <= 3; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend",
            '<li data-id="room-' + i + '"><h3>Room ' + i + '</h3><span class="price">$' + (100 + i) + '</span>' + ${JSON.stringify(decorations)} + '</li>');
      }, 50);
    </script>`);
  const answer = await call(
    page,
    `const started = Date.now();
    const { rows } = await waitForRows(page.locator("#results > li"), { price: ".price" }, {
      count: 5, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });
    return { keys: rows.map((row) => row.key), ms: Date.now() - started };`,
  );
  expect(answer.error).toBeUndefined();
  const result = answer.result as { keys: string[]; ms: number };
  expect(result.keys).toEqual(["room-1", "room-2", "room-3"]);
  expect(result.ms).toBeLessThan(1500);
});

test("a page whose only signs are decorative fails as outcome_unknown at the no-progress limit", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><h1>Something else entirely</h1>${decorations}</section>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 2000");
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.ms).toBeLessThan(1500);
});

test("a dependent value confirmed unchanged beside a decorative sign returns without waiting out the cap", async ({
  page,
}) => {
  await quotePage(page, "$240", null);
  await page.locator("body").evaluate((body, html) => body.insertAdjacentHTML("beforeend", html), decorations);
  const answer = await call(
    page,
    `await page.locator("#guests").selectOption("3", { timeout: 1000 });
    return await waitForChange({ total: page.locator("#total") }, {
      before: { total: "$240" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });`,
  );
  expect(answer.result).toEqual({ values: { total: "$240" }, changed: false });
});

test("a loading sign that appears after the action keeps the wait alive past the no-progress window", async ({
  page,
}) => {
  await page.setContent(`
    <button type="button">Search</button><section id="answer"></section>
    <script>
      document.querySelector("button").onclick = () => {
        document.querySelector("#answer").innerHTML = '<div class="results-skeleton" style="height: 40px"></div>';
        setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 600);
      };
    </script>`);
  const answer = await outcome(
    page,
    `noProgressMs: 500, timeout: 3000, action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer, JSON.stringify(answer)).toMatchObject({ shown: "results" });
});

test("code pasting outcomeWaitCode beside its own wait helpers still runs", async ({ page }) => {
  await page.setContent(rooms.replace("<ul", `<section id="answer"><ul`) + "</section>");
  const answer = await call(
    page,
    `const waitSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForRows = async () => "mine";
    const waitLimits = {};
    await waitSleep(1);
    return [await waitForOutcome({ results: page.getByRole("list", { name: "Rooms" }) }), await waitForRows()];`,
    outcomeWaitCode,
  );
  expect(answer).toEqual({ result: ["results", "mine"] });
});

test("a search sent to the same API path as earlier requests is still the site's request in flight", async ({
  page,
}) => {
  await site(
    page,
    `<button type="button">Search</button><section id="answer"></section>
    <script>
      const ask = (operation) => fetch("/graphql", { method: "POST", body: JSON.stringify({ operation }) });
      document.querySelector("button").onclick = async () => {
        await Promise.all([ask("Session"), ask("Flags")]);
        const response = await ask("SearchRooms");
        document.querySelector("#answer").innerHTML = (await response.json()).html;
      };
    </script>`,
    async (path) => {
      if (path !== "/graphql") return { body: "{}" };
      return { body: JSON.stringify({ html: rooms }) };
    },
  );
  // Only the search is slow.
  await page.route(`${origin}/graphql`, async (route) => {
    const slow = String(route.request().postData()).includes("SearchRooms");
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ html: rooms }) });
  });
  const answer = await outcome(
    page,
    `noProgressMs: 500, timeout: 3000, siteDomain: "example.test", action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.shown).toBe("results");
});

test("a request that stays open does not hold a short list back", async ({ page }) => {
  await site(
    page,
    `<ol id="results"><li data-id="room-1"><h3>Room 1</h3></li></ol>
    <script>setTimeout(() => fetch("/events/wait"), 20);</script>`,
    async (path) => {
      if (path === "/events/wait") await new Promise((resolve) => setTimeout(resolve, 5000));
      return { body: "{}" };
    },
  );
  const answer = await call(
    page,
    `const started = Date.now();
    const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 5, key: { attribute: "data-id" }, siteDomain: "example.test", noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });
    return { keys: rows.map((row) => row.key), ms: Date.now() - started };`,
  );
  expect(answer.error).toBeUndefined();
  expect((answer.result as { ms: number }).ms).toBeLessThan(1500);
});

test("without siteDomain, a host under a shared suffix such as co.uk is not taken for the site", async ({
  page,
}) => {
  const shop = "https://shop.example.co.uk";
  await page.route("https://*.co.uk/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === shop && url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: `<section id="answer"><p>Welcome</p></section>` });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ body: "" }).catch(() => undefined);
  });
  await page.goto(`${shop}/`);
  const signs = async (host: string) => {
    const answer = await call(
      page,
      `try {
        await waitForOutcome({ results: page.getByRole("list") }, {
          noProgressMs: 300, timeout: 3000,
          action: () => page.evaluate(() => { fetch("https://${host}/slow", { mode: "no-cors" }); }),
        });
      } catch (error) {
        return { reason: error.reason, signs: Object.keys(error.progress.signs) };
      }`,
    );
    return answer.result as { reason: string; signs: string[] };
  };
  // Another site under the same public suffix is not the site's own request.
  expect(await signs("tracker.co.uk")).toEqual({ reason: "outcome_unknown", signs: [] });
  // The site's own API host is.
  expect(await signs("api.example.co.uk")).toEqual({ reason: "outcome_unknown", signs: ["site request"] });
});

test("a row's field is read from its visible match, and a field only hidden is said to be hidden", async ({
  page,
}) => {
  await page.setContent(`
    <ol id="results">
      <li data-id="room-1"><h3>Room 1</h3><span class="price" style="display:none">$1</span><span class="price">$101</span><span class="badge" hidden>New</span></li>
    </ol>`);
  const found = await call(
    page,
    `const { rows } = await waitForRows(page.locator("#results > li"), { price: ".price" }, {
      count: 1, key: { attribute: "data-id" }, noProgressMs: 300, stableMs: 100,
    });
    return rows;`,
  );
  expect(found.result).toEqual([{ key: "room-1", price: "$101" }]);
  const hidden = await call(
    page,
    `await waitForRows(page.locator("#results > li"), { badge: ".badge" }, {
      count: 1, key: { attribute: "data-id" }, noProgressMs: 300, stableMs: 100,
    });`,
  );
  expect(hidden.error).toMatch(/: 1 identified rows of 1, needed 1; badge hidden in row 1; /u);
});

// A list of ten rows whose "Show more" loads ten more after `delayMs`: through the site's API when
// `request`, else in the page. While it loads, a spinner shows beside the list, or the list is
// aria-busy, or nothing shows but the request.
const growingList = (page: Page, sign: "spinner" | "busy" | "none", request: boolean, delayMs = 1500) =>
  site(
    page,
    `<main>
      <ol id="results"></ol><div id="loading-more"></div><button type="button">Show more</button>
    </main>
    <script>
      const list = document.querySelector("#results");
      const add = (from) => {
        for (let i = from; i < from + 10; i += 1)
          list.insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
      };
      add(1);
      document.querySelector("button").onclick = async () => {
        if (${JSON.stringify(sign)} === "spinner")
          document.querySelector("#loading-more").innerHTML = '<div class="load-spinner" style="height: 20px"></div>';
        if (${JSON.stringify(sign)} === "busy") list.setAttribute("aria-busy", "true");
        if (${request}) await fetch("/api/more");
        else await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
        add(11);
        document.querySelector("#loading-more").innerHTML = "";
        list.removeAttribute("aria-busy");
      };
    </script>`,
    async (path) => {
      if (path === "/api/more") await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { body: "{}" };
    },
  );

// A sign alone holds a list for the no-progress window, so those cases get a window longer than the
// load; a request the click started holds it until it ends, whatever the window.
const growBody = (noProgressMs: number) => `
  const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
    count: 20, key: { attribute: "data-id" }, noProgressMs: ${noProgressMs}, stableMs: 100, unchangedMs: 300, timeout: 4000,
    action: () => page.getByRole("button", { name: "Show more" }).click({ timeout: 1000 }),
  });
  return rows.length;`;

for (const [sign, request] of [
  ["spinner", true],
  ["none", true],
  ["spinner", false],
  ["busy", false],
] as const)
  test(`a "Show more" that loads for longer than the holds returns the grown list: ${sign} sign, ${request ? "site request" : "no request"}`, async ({
    page,
  }) => {
    await growingList(page, sign, request);
    expect(await call(page, growBody(request ? 400 : 2000))).toEqual({ result: 20 });
  });

test("a list still loading at the first look, with its spinner below the rows, returns every row", async ({
  page,
}) => {
  await page.setContent(`
    <main>
      <ol id="results"><li data-id="r1"><h3>Row 1</h3></li><li data-id="r2"><h3>Row 2</h3></li></ol>
      <div class="results-loader" style="height: 20px"></div>
    </main>
    <script>
      setTimeout(() => {
        for (let i = 3; i <= 10; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
        document.querySelector(".results-loader").remove();
      }, 1500);
    </script>`);
  const answer = await call(
    page,
    `const { rows, more } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 10, key: { attribute: "data-id" }, noProgressMs: 2000, stableMs: 100, unchangedMs: 300, timeout: 4000,
    });
    return { count: rows.length, more };`,
  );
  expect(answer).toEqual({ result: { count: 10, more: false } });
});

test("a row whose key is only hidden is said to have its key hidden", async ({ page }) => {
  await page.setContent(`<ol id="results"><li><h3>Room 1</h3><span class="id" hidden>room-1</span></li></ol>`);
  const answer = await call(
    page,
    `await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 1, key: ".id", noProgressMs: 300, stableMs: 100,
    });`,
  );
  expect(answer.error).toMatch(/: 0 identified rows of 1, needed 1; key hidden in row 1; /u);
});

// Seven rows beside an element that only looks like a loader: kept in layout but invisible, a
// visible wrapper or sentinel the page never removes, or a busy region that never clears. With
// `more`, a "Show more" adds five rows.
const besideRows = (page: Page, sign: string, more = false) =>
  page.setContent(`
    <main${sign === "busy-main" ? ' aria-busy="true"' : ""}>
      <ol id="results"></ol>
      ${
        {
          hidden: '<div class="infinite-loader" style="height: 30px; visibility: hidden"></div>',
          transparent: '<div class="infinite-loader" style="height: 30px; opacity: 0"></div>',
          sentinel: '<div class="infinite-loader" style="height: 30px"></div>',
          wrapper: '<div class="loader-wrapper" style="padding: 10px"><button type="button">Show more</button></div>',
          "busy-main": "",
        }[sign]
      }
      ${more && sign !== "wrapper" ? '<button type="button">Show more</button>' : ""}
    </main>
    <script>
      const add = (from, to) => {
        for (let i = from; i <= to; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
      };
      add(1, 7);
      for (const button of document.querySelectorAll("button")) button.onclick = () => setTimeout(() => add(8, 12), 100);
    </script>`);

const shortRead = (count: number, action = false, noProgressMs = 400) => `
  const started = Date.now();
  const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
    count: ${count}, key: { attribute: "data-id" }, noProgressMs: ${noProgressMs}, stableMs: 100, unchangedMs: 300, timeout: 8000,
    ${action ? 'action: () => page.getByRole("button", { name: "Show more" }).click({ timeout: 1000 }),' : ""}
  });
  return { count: rows.length, ms: Date.now() - started };`;

for (const sign of ["hidden", "transparent", "sentinel", "wrapper", "busy-main"])
  test(`a short list beside a loader that never leaves (${sign}) returns its rows within the no-progress window`, async ({
    page,
  }) => {
    await besideRows(page, sign);
    const answer = await call(page, shortRead(10));
    expect(answer.error).toBeUndefined();
    const result = answer.result as { count: number; ms: number };
    expect(result.count).toBe(7);
    expect(result.ms).toBeLessThan(2000);
  });

for (const sign of ["sentinel", "wrapper"])
  test(`a "Show more" beside a loader the page always shows (${sign}) returns the rows it added at once`, async ({
    page,
  }) => {
    await besideRows(page, sign, true);
    // A 4 s no-progress window: a sign held as new would keep the short list at least that long.
    const answer = await call(page, shortRead(20, true, 4000));
    expect(answer.error).toBeUndefined();
    const result = answer.result as { count: number; ms: number };
    expect(result.count).toBe(12);
    // The sign was there before the click, so it is the page's own: no hold.
    expect(result.ms).toBeLessThan(3000);
  });

// A long results page: `cards` cards whose image wrapper's class names a loader, as many sites mark
// an image still loading, after a Search button. A click runs `onSearch`, then shows the rooms after
// `answerMs`. `skipped` puts each card in content the browser skips rendering while off screen.
const hintedCards = (cards: number, { onSearch = "", answerMs = 300, skipped = false } = {}) => `
  <button type="button" id="search">Search</button><section id="answer"></section>
  <main>${`<div class="card"${skipped ? ' style="content-visibility: auto; contain-intrinsic-size: auto 40px"' : ""}><div class="card-image-loader" style="height: 4px"></div><span>Room</span></div>`.repeat(cards)}</main>
  <script>
    document.querySelector("#search").onclick = () => {
      ${onSearch}
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, ${answerMs});
    };
  </script>`;

// One wait for the rooms after a click on Search. Its locators are plain CSS, which cost little on
// a long page, so the time it takes is the wait's own.
const searchWait = async (page: Page, noProgressMs: number): Promise<OutcomeAnswer> => {
  const answer = await call(
    page,
    `const started = Date.now();
    try {
      const shown = await waitForOutcome({ results: page.locator("#answer ul") }, {
        noProgressMs: ${noProgressMs}, timeout: 8000, action: () => page.locator("#search").click(),
      });
      return { shown, ms: Date.now() - started, report: waitReport() };
    } catch (error) {
      return { reason: error.reason, message: error.message, ms: Date.now() - started };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as OutcomeAnswer;
};

/** Runs `use` on a page of a Patchright browser, whose locators evaluate in its isolated world. */
const onPatchright = async (use: (page: Page) => Promise<void>) => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    await use((await browser.newPage()) as unknown as Page);
  } finally {
    await browser.close();
  }
};

// A Patchright locator's count costs time for each element it matches: counting every element whose
// class names a loader took seconds a look here, before the action and at each look after it.
test("on Patchright, a page full of elements whose classes name a loader costs each look one page call", async () => {
  await onPatchright(async (page) => {
    await page.setContent(hintedCards(400));
    const answer = await searchWait(page, 3000);
    expect(answer.shown).toBe("results");
    expect(answer.ms).toBeLessThan(3000);
  });
});

// Among hundreds of decorations from before the action, a skeleton that comes with it is still the
// page loading: it holds the wait past the no-progress window, and without it the wait ends sooner.
test("on Patchright, a skeleton that comes with the action holds the wait beside hundreds of decorations", async () => {
  await onPatchright(async (page) => {
    const skeleton = `document.querySelector("#answer").innerHTML = '<div class="results-skeleton" style="height: 40px"></div>';`;
    await page.setContent(hintedCards(400, { onSearch: skeleton, answerMs: 1300 }));
    const held = await searchWait(page, 800);
    expect(held, JSON.stringify(held)).toMatchObject({ shown: "results" });
    expect(held.report?.[0]?.summary).toMatch(/progress seen: loading sign /u);
    await page.setContent(hintedCards(400, { answerMs: 1300 }));
    expect((await searchWait(page, 800)).reason).toBe("outcome_unknown");
  });
});

// The look's one page call counts what a visible locator match counts: rendered, not hidden, with a
// box, or with display: contents a child element or text that shows, through open shadow roots. A
// sign in content the browser skips rendering does not show, and its box is never read: reading it
// would lay that content out, one element at a time, which took seconds with thousands of them.
test("a look counts the generic signs as visible matches, never in content the browser skips rendering", async ({
  page,
}) => {
  await page.setContent(`
    <div class="spinner" style="height: 10px"></div>
    <div class="results-skeleton" style="height: 10px; visibility: hidden"></div>
    <div class="loader" style="display: none"></div>
    <div class="loader-row" style="display: contents"><span style="display: inline-block; width: 10px; height: 10px"></span></div>
    <div class="loading-spinner" style="display: contents">Loading</div>
    <div class="spinner" style="height: 0"></div>
    <x-card></x-card>
    <div aria-busy="true" style="height: 10px"></div>
    <div style="content-visibility: auto; contain-intrinsic-size: auto 40px; margin-top: 4000px">
      <div class="loader" style="height: 10px"></div><div aria-busy="true" style="height: 10px"></div>
    </div>
    <script>
      customElements.define("x-card", class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<div class="shimmer" style="height: 10px"></div>'; }
      });
    </script>`);
  expect(await call(page, `return await page.evaluate(waitSignsInPage, waitSignsSpec);`)).toEqual({
    result: { signs: 1, classes: 4 },
  });
  // Within a region, only what its elements hold, their own shadow roots included.
  expect(await call(page, `return await page.locator("x-card").evaluateAll(waitSignsInPage, waitSignsSpec);`)).toEqual({
    result: { signs: 0, classes: 1 },
  });
});

// A page whose loaders each take 8 ms to measure: counting all 400 would hold every look for over
// three seconds, and the page runs one call at a time. A look stops counting class hints after its
// budget and takes them as unchanged, so the wait still answers at its own pace.
test("a look that runs out of time counting class hints takes them as unchanged", async ({ page }) => {
  const slowBoxes = `<script>
    const box = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (String(this.className).includes("loader")) for (const until = performance.now() + 8; performance.now() < until;);
      return box.call(this);
    };
  </script>`;
  await page.setContent(slowBoxes + hintedCards(400));
  const answer = await searchWait(page, 3000);
  expect(answer.shown).toBe("results");
  expect(answer.ms).toBeLessThan(3000);
  expect(answer.report?.[0]?.summary).not.toMatch(/loading sign/u);
});
