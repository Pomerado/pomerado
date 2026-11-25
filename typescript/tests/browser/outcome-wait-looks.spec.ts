import { runInThisContext } from "node:vm";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";

// The outcome wait as a script far from its browser runs it: every Playwright call that goes to the
// browser answers a round trip later, and calls in flight together share it, as they do on one
// connection. Each call is recorded, so a test counts the round trips a look costs.

/** One Playwright call the code made: when it was sent, and when its answer came back. */
interface PageCall {
  readonly sent: number;
  answered?: number;
}

const isLocator = (value: unknown): value is object =>
  typeof value === "object" && value !== null && /^_?Locator$/u.test(value.constructor.name);

/** `page`, with every call that returns a promise answered `roundTripMs` after the browser's own. */
const distant = (page: Page, roundTripMs: number) => {
  const calls: PageCall[] = [];
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, object, args);
          if (isLocator(result)) return wrap(result);
          if (!(result instanceof Promise)) return result;
          const call: PageCall = { sent: performance.now() };
          calls.push(call);
          const answer = async () => {
            await new Promise((resolve) => setTimeout(resolve, roundTripMs));
            call.answered = performance.now();
          };
          return result.then(
            async (resolved: unknown) => {
              await answer();
              return resolved;
            },
            async (error: unknown) => {
              await answer();
              throw error;
            },
          );
        };
      },
    });
  return { page: wrap(page), calls };
};

/**
 * The round trips answered calls cost in a row: the longest chain of calls each sent after the one
 * before it was answered. Calls in flight together are one round trip.
 */
const roundTrips = (calls: readonly PageCall[]) => {
  let chain = 0;
  let free = -Infinity;
  const answered = calls.flatMap((call) => (call.answered === undefined ? [] : [{ ...call, answered: call.answered }]));
  for (const call of answered.sort((a, b) => a.answered - b.answered))
    if (call.sent >= free) {
      chain += 1;
      free = call.answered;
    }
  return chain;
};

/** Runs `body` after `waitCode` as a Kernel call body runs, with `page` and `helpers` in scope. */
const runCode = async (page: object, body: string, helpers: Record<string, unknown> = {}) => {
  const run: unknown = runInThisContext(`(async (page, { ${Object.keys(helpers).join(", ")} }) => {\n${waitCode}\n${body}\n})`);
  if (typeof run !== "function") throw new Error("Call code unavailable");
  return (await Reflect.apply(run, undefined, [page, helpers])) as unknown;
};

/**
 * Runs `body` after `waitCode`, with `page` `roundTripMs` from its browser. The body may measure a
 * read with `look(read)`, which says how many calls it sent and the round trips they cost, and
 * read `trips()`, the round trips of every call answered so far.
 */
const runFar = async (page: Page, roundTripMs: number, body: string) => {
  const far = distant(page, roundTripMs);
  const look = async (read: () => Promise<unknown>) => {
    const from = far.calls.length;
    const value = await read();
    const calls = far.calls.slice(from);
    return { value, sent: calls.length, roundTrips: roundTrips(calls) };
  };
  const trips = () => roundTrips(far.calls);
  return runCode(far.page, body, { look, trips });
};

/** One look after an action at `outcomes` (names to page code), as the wait takes it. */
const oneLook = (outcomes: string) => `
  const outcomes = { ${outcomes} };
  const candidates = Object.entries(outcomes).map(([name, value]) => outcomeWaitCandidate(name, value));
  const key = "pomerado.outcomeWait.test";
  for (const candidate of candidates) if (candidate.kind === "locator") await outcomeWaitNote(candidate.locator, key);
  const state = { goneSeen: new Set(), goneSince: new Map(), invalidFields: new Map(), invalidBefore: new Map(),
    checked: new Map(), announcedText: new Map(), urlBefore: page.url(), actedAt: Date.now() };
  const events = outcomeWaitEvents(candidates);
  try {
    return await look(() => outcomeWaitObserve(candidates, key, state, events));
  } finally {
    events.stop();
  }
`;

const locators = (count: number) =>
  Array.from({ length: count }, (_, index) => `outcome${index}: page.locator("#answer .outcome${index}")`).join(", ");

interface Look {
  readonly value: Record<string, unknown>;
  readonly sent: number;
  readonly roundTrips: number;
}

const lookAt = async (page: Page, html: string, outcomes: string) => {
  await page.setContent(`<section id="answer">${html}</section>`);
  return (await runFar(page, 100, oneLook(outcomes))) as Look;
};

test.describe("the round trips of the outcome wait", () => {
  for (const count of [1, 3, 8])
    test(`a look at ${count} locator outcomes sends both counts of each at once: one round trip`, async ({ page }) => {
      const look = await lookAt(page, "", locators(count));
      expect(look).toMatchObject({ sent: 2 * count, roundTrips: 1 });
    });

  test("a locator that shows after an action is read for whether it changed, then those above it are counted again", async ({
    page,
  }) => {
    const look = await lookAt(page, `<p class="outcome5">Saved</p>`, locators(8));
    // The eight counted at once, outcome5's change, then outcome0 to outcome4 counted again.
    expect(look).toMatchObject({ sent: 16 + 1 + 10, roundTrips: 3 });
    expect(look.value["outcome5"]).toEqual({ count: 1, visible: 1, changed: 0 });
  });

  test("an outcome of another kind is read alone, in its place", async ({ page }) => {
    const look = await lookAt(page, "", `${locators(2)}, opened: { url: /records/ }, last: page.locator("#answer .last")`);
    expect(look).toMatchObject({ sent: 6, roundTrips: 2 });
  });

  test("before the action, what each outcome shows is noted at once", async ({ page }) => {
    await page.setContent(`<button id="save">Save</button><section id="answer"></section>
      <script>
        document.querySelector("#save").onclick = () => { document.querySelector("#answer").innerHTML = '<p class="outcome7">Saved</p>'; };
      </script>`);
    const answer = await runFar(
      page,
      100,
      `let before;
      const result = await waitForOutcomeResult({ ${locators(8)} }, {
        action: () => { before = trips(); return page.locator("#save").click(); }, unchangedMs: 0,
      });
      return { outcome: result.outcome, before };`,
    );
    // The eight notes at once, then the page's progress signs.
    expect(answer).toEqual({ outcome: "outcome7", before: 2 });
  });
});

const origin = "https://records.example.test";

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly contentType?: string;
  readonly delayMs?: number;
}

/** Serves `pages` by path (GET), answers everything else through `api`, and opens `/`. */
const site = async (page: Page, pages: Record<string, string>, api: (method: string, path: string) => Reply | undefined) => {
  await page.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const html = request.method() === "GET" ? pages[path] : undefined;
    const reply: Reply =
      html !== undefined ? { body: html, contentType: "text/html" } : (api(request.method(), path) ?? { status: 404, body: "" });
    if (reply.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    await route.fulfill({ status: reply.status ?? 200, contentType: reply.contentType ?? "application/json", body: reply.body ?? "" });
  });
  await page.goto(`${origin}/`);
};

/** A record form in a dialog, whose Save button runs `onSave` (page script). */
const recordForm = (onSave: string, extra = "") => `
  <div role="dialog" aria-label="Record" id="modal">
    <form id="record" aria-label="Edit record" novalidate>
      <label for="title">Title</label><input id="title" name="title" value="Quarterly report">
      <button type="button" id="save">Save</button>
    </form>
  </div>
  <section id="answer"></section>
  ${extra}
  <script>
    const later = (ms, html) => setTimeout(() => document.querySelector("#answer").insertAdjacentHTML("beforeend", html), ms);
    document.querySelector("#save").onclick = async () => { ${onSave} };
  </script>`;

const errorBanner = `'<div role="alert">Changes could not be saved</div>'`;
const savedToast = `'<div class="toast toast-success" role="status">Record saved</div>'`;

// The common outcomes of a save, highest priority first.
const saveOutcomes = `
  invalid: { invalid: form },
  failed: page.getByRole("alert"),
  saved: page.locator(".toast-success"),
`;

interface Scenario {
  readonly name: string;
  readonly pages: Record<string, string>;
  readonly api?: (method: string, path: string) => Reply | undefined;
  readonly outcomes: string;
  readonly options?: string;
  readonly expected: Record<string, unknown>;
}

const scenarios: readonly Scenario[] = [
  {
    name: "an error and a success drawn at once: the one listed first",
    pages: { "/": recordForm(`later(150, ${errorBanner} + ${savedToast});`) },
    outcomes: saveOutcomes,
    expected: { outcome: "failed", kind: "locator", evidence: { count: 1, visible: 1, text: "Changes could not be saved" } },
  },
  {
    name: "a success drawn first, an error later: the success",
    pages: { "/": recordForm(`later(100, ${savedToast}); later(900, ${errorBanner});`) },
    outcomes: saveOutcomes,
    expected: { outcome: "saved", kind: "locator", evidence: { count: 1, visible: 1, text: "Record saved" } },
  },
  {
    name: "an error drawn first, a success later: the error",
    pages: { "/": recordForm(`later(100, ${errorBanner}); later(900, ${savedToast});`) },
    outcomes: saveOutcomes,
    expected: { outcome: "failed", kind: "locator", evidence: { count: 1, visible: 1, text: "Changes could not be saved" } },
  },
  {
    name: "a dialog that flickers shut, then a validation error: the error",
    pages: {
      "/": recordForm(`
        const modal = document.querySelector("#modal");
        setTimeout(() => { modal.style.display = "none"; }, 100);
        setTimeout(() => { modal.style.display = ""; }, 160);
        setTimeout(() => {
          const title = document.querySelector("#title");
          title.setAttribute("aria-invalid", "true");
          title.setAttribute("aria-describedby", "title-error");
          title.insertAdjacentHTML("afterend", '<p id="title-error">Title is already taken</p>');
        }, 600);`),
    },
    outcomes: `invalid: { invalid: form }, closed: { gone: page.getByRole("dialog"), stableMs: 300 },`,
    expected: { outcome: "invalid", kind: "invalid", evidence: { fields: [{ field: "Title", message: "Title is already taken" }] } },
  },
  {
    name: "a native alert on the same URL: the dialog, not the URL",
    pages: { "/": recordForm(`setTimeout(() => alert("Record saved"), 100);`) },
    outcomes: `opened: { url: "/" }, failed: page.getByRole("alert"), notice: { dialog: "alert" },`,
    expected: { outcome: "notice", kind: "dialog", evidence: { type: "alert", message: "Record saved" } },
  },
  {
    name: "the save's response: the response, with its status",
    pages: { "/": recordForm(`await fetch("/api/records", { method: "POST", body: "{}" });`) },
    api: (method) => (method === "POST" ? { status: 201, body: "{}", delayMs: 150 } : undefined),
    outcomes: `failed: page.getByRole("alert"), committed: { response: { method: "POST", status: 201 } },`,
    expected: {
      outcome: "committed",
      kind: "response",
      evidence: { url: `${origin}/api/records`, method: "POST", status: 201 },
    },
  },
  {
    name: "a receipt opened in a new tab: the popup",
    pages: { "/": recordForm(`window.open("/receipts/5", "_blank");`), "/receipts/5": "<h1>Receipt</h1>" },
    outcomes: `${saveOutcomes} receipt: { popup: true },`,
    expected: { outcome: "receipt", kind: "popup", evidence: { url: `${origin}/receipts/5` } },
  },
  {
    name: "a dialog that closes: gone once it stayed gone",
    pages: { "/": recordForm(`setTimeout(() => { document.querySelector("#modal").hidden = true; }, 100);`) },
    outcomes: `failed: page.getByRole("alert"), closed: { gone: page.getByRole("dialog"), stableMs: 200 },`,
    expected: { outcome: "closed", kind: "gone", evidence: { goneForMs: "held" } },
  },
  {
    name: "a dialog that closes, held for a longer stableMs",
    pages: { "/": recordForm(`setTimeout(() => { document.querySelector("#modal").hidden = true; }, 100);`) },
    outcomes: `failed: page.getByRole("alert"), closed: { gone: page.getByRole("dialog"), stableMs: 700 },`,
    expected: { outcome: "closed", kind: "gone", evidence: { goneForMs: "held" }, held: true },
  },
  {
    name: "a choice the site greys out: the disabled control",
    pages: {
      "/": recordForm(`setTimeout(() => {
        const save = document.querySelector("#save");
        save.disabled = true;
        save.textContent = "Sold out";
      }, 100); later(900, ${savedToast});`),
    },
    outcomes: `unavailable: page.getByRole("button", { name: "Sold out", disabled: true }), saved: page.locator(".toast-success"),`,
    expected: { outcome: "unavailable", kind: "locator", evidence: { count: 1, visible: 1, text: "Sold out" } },
  },
  {
    name: "a bot challenge drawn over the page: the challenge",
    pages: {
      "/": recordForm(`setTimeout(() => document.body.insertAdjacentHTML("beforeend",
        '<iframe title="Widget containing a security challenge" srcdoc="<p>Verify you are human</p>"></iframe>'), 150);`),
    },
    outcomes: `challenge: page.locator('iframe[title*="security challenge" i]'), ${saveOutcomes}`,
    expected: { outcome: "challenge", kind: "locator", evidence: { count: 1, visible: 1, text: "" } },
  },
  {
    name: "a bot vendor answering the save with a challenge: the 403 response",
    pages: { "/": recordForm(`await fetch("/api/records", { method: "POST", body: "{}" });`) },
    api: (method) => (method === "POST" ? { status: 403, contentType: "text/html", body: "<h1>Access denied</h1>" } : undefined),
    outcomes: `challenged: { response: { status: 403 } }, ${saveOutcomes}`,
    expected: { outcome: "challenged", kind: "response", evidence: { url: `${origin}/api/records`, method: "POST", status: 403 } },
  },
  {
    name: "a redirect to the record between two locators: the URL",
    pages: { "/": recordForm(`setTimeout(() => { location.href = "/records/42"; }, 300);`), "/records/42": "<h1>Record 42</h1>" },
    outcomes: `failed: page.getByRole("alert"), opened: { url: /\\/records\\/\\d+$/ }, saved: page.locator(".toast-success"),`,
    expected: { outcome: "opened", kind: "url", evidence: { url: `${origin}/records/42` } },
  },
  {
    name: "an in-between answer named pending, then the final one",
    pages: {
      "/": recordForm(`later(100, '<p class="processing">Processing your order</p>');
        setTimeout(() => { document.querySelector("#answer").innerHTML = ${savedToast}; }, 700);`),
    },
    outcomes: `saved: page.locator(".toast-success"), processing: page.locator(".processing"),`,
    options: `pending: "processing",`,
    expected: { outcome: "saved", kind: "locator", evidence: { count: 1, visible: 1, text: "Record saved" } },
  },
  {
    name: "the app's own state by a check: its value",
    pages: { "/": recordForm(`window.store = { status: "saving" }; setTimeout(() => { window.store = { status: "saved", id: 12 }; }, 200);`) },
    outcomes: `${saveOutcomes} stored: { check: () => page.evaluate(() => window.store?.status === "saved" && window.store) },`,
    expected: { outcome: "stored", kind: "check", evidence: { value: { status: "saved", id: 12 } } },
  },
  {
    name: "a toast that comes and goes between two looks: announced",
    pages: {
      "/": recordForm(`setTimeout(() => {
        document.body.insertAdjacentHTML("beforeend", '<div id="toast" aria-live="polite">Record saved</div>');
        setTimeout(() => document.querySelector("#toast").remove(), 40);
      }, 80);`),
    },
    outcomes: `failed: page.getByRole("alert"), saved: { announced: /saved/i },`,
    expected: { outcome: "saved", kind: "announced", evidence: { text: "Record saved" } },
  },
  {
    name: "a toast left from before the action, unchanged: only after the unchanged window",
    pages: { "/": recordForm(`await fetch("/api/records", { method: "POST", body: "{}" });`, `<div class="toast toast-success">Record saved</div>`) },
    api: (method) => (method === "POST" ? { body: "{}" } : undefined),
    outcomes: saveOutcomes,
    options: `unchangedMs: 500,`,
    expected: { outcome: "saved", kind: "locator", evidence: { count: 1, visible: 1, text: "Record saved" } },
  },
  {
    name: "two visible matches that read differently: ambiguous",
    pages: { "/": recordForm(`later(100, ${savedToast} + '<div class="toast toast-success">Record archived</div>');`) },
    outcomes: saveOutcomes,
    expected: {
      reason: "outcome_ambiguous",
      message: "outcome_ambiguous: invalid # invalid fields, failed # visible of #, saved # visible of #",
    },
  },
  {
    name: "no answer before the deadline: a timeout naming what each saw",
    pages: { "/": recordForm("") },
    outcomes: `${saveOutcomes} opened: { url: /records/ }, committed: { response: { method: "POST" } },`,
    options: `deadline: Date.now() + 700, noProgressMs: 5000,`,
    expected: {
      reason: "outcome_timeout",
      message:
        "outcome_timeout after # ms: invalid # invalid fields, failed # visible of #, saved # visible of #, opened URL not matched, committed no matching response of # seen; no progress seen",
    },
  },
  {
    name: "a quiet page: outcome_unknown once nothing progressed",
    pages: { "/": recordForm("") },
    outcomes: `${saveOutcomes} opened: { url: /records/ },`,
    options: `noProgressMs: 400,`,
    expected: {
      reason: "outcome_unknown",
      message:
        "outcome_unknown after # ms, # ms without progress, no outcome showing: invalid # invalid fields, failed # visible of #, saved # visible of #, opened URL not matched; no progress seen",
    },
  },
];

/** The scenario's wait after a click on Save, with `page` near its browser or `roundTripMs` from it. */
const answerOf = async (page: Page, scenario: Scenario, roundTripMs: number) => {
  await site(page, scenario.pages, scenario.api ?? (() => undefined));
  const stableMs = /stableMs: (\d+)/u.exec(scenario.outcomes)?.[1] ?? "0";
  const body = `
    const form = page.getByRole("form", { name: "Edit record" });
    const save = page.locator("#save");
    try {
      const result = await waitForOutcomeResult({ ${scenario.outcomes} }, {
        action: () => save.click(), noProgressMs: 600, timeout: 4000, unchangedMs: 300, ${scenario.options ?? ""}
      });
      await result.dialog?.dismiss().catch(() => undefined);
      await result.page?.close().catch(() => undefined);
      const { goneForMs, ...evidence } = result.evidence;
      return {
        outcome: result.outcome, kind: result.kind, ...(result.pending ? { pending: true } : {}),
        evidence: goneForMs === undefined ? evidence : { ...evidence, goneForMs: goneForMs >= ${stableMs} ? "held" : goneForMs },
        ...(${stableMs} > 300 ? { held: result.afterMs >= ${stableMs} } : {}),
      };
    } catch (error) {
      await error.dialog?.dismiss().catch(() => undefined);
      if (error.reason === undefined) throw error;
      return { reason: error.reason, message: error.message.replace(/\\d+/g, "#") };
    }`;
  return roundTripMs === 0 ? runCode(page, body) : runFar(page, roundTripMs, body);
};

test.describe("the same answers near the browser and far from it", () => {
  for (const scenario of scenarios)
    test(scenario.name, async ({ page }) => {
      expect(await answerOf(page, scenario, 0), "near").toEqual(scenario.expected);
      expect(await answerOf(page, scenario, 60), "60 ms away").toEqual(scenario.expected);
    });
});
