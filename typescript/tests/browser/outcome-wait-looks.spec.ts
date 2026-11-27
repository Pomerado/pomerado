import { runInThisContext } from "node:vm";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "playwright";
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

/**
 * Has `draw` (page code) run once, just after the code sends `locator`'s `nth` count (from 1): the
 * page changes between that count and the counts sent before it of a locator inside a frame, which
 * first finds its frame.
 */
const drawAfterCount = (page: Page, locator: Locator, nth: number, draw: () => void) => {
  const count = locator.count.bind(locator);
  let counted = 0;
  locator.count = () => {
    const counting = count();
    counted += 1;
    if (counted === nth) setTimeout(() => void page.evaluate(draw));
    return counting;
  };
  return locator;
};

test.describe("an outcome in a frame counted after the page's", () => {
  test("a success in the frame and a higher error on the page drawn at once: the error, with no action", async ({ page }) => {
    await page.setContent(`<section id="answer"></section><iframe id="pay" srcdoc="<main></main>"></iframe>`);
    await page.locator(".err").count();
    await page.frameLocator("#pay").locator(".ok").count();
    const failed = drawAfterCount(page, page.locator(".err"), 1, () => {
      document.querySelector("#answer")!.innerHTML = '<p class="err">Payment declined</p>';
      document.querySelector<HTMLIFrameElement>("#pay")!.contentDocument!.body.innerHTML = '<p class="ok">Paid</p>';
    });
    const outcome = await runCode(
      page,
      `return (await waitForOutcomeResult({ failed, saved: page.frameLocator("#pay").locator(".ok") }, { noProgressMs: 1000 })).outcome;`,
      { failed },
    );
    expect(outcome).toBe("failed");
  });

  test("a spinner gone from the frame as a higher error is drawn on the page: the error", async ({ page }) => {
    await page.setContent(`<section id="answer"></section><iframe id="pay" srcdoc="<p class='spinner'>Paying</p>"></iframe>`);
    await page.locator(".err").count();
    await page.frameLocator("#pay").locator(".spinner").count();
    // At the second look, once the first saw the spinner.
    const failed = drawAfterCount(page, page.locator(".err"), 2, () => {
      document.querySelector("#answer")!.innerHTML = '<p class="err">Payment declined</p>';
      document.querySelector<HTMLIFrameElement>("#pay")!.contentDocument!.querySelector(".spinner")!.remove();
    });
    const outcome = await runCode(
      page,
      `return (await waitForOutcomeResult({ failed, closed: { gone: page.frameLocator("#pay").locator(".spinner"), stableMs: 0 } }, { noProgressMs: 1000 })).outcome;`,
      { failed },
    );
    expect(outcome).toBe("failed");
  });
});
