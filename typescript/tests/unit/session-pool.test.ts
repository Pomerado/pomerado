import { describe, expect, it } from "vitest";
import { sessionPoolCode, sessionPoolDefaults } from "../../src/browser/index.js";
import { sessionPool } from "../../src/runtime/session-pool.js";
import type { SessionAnswer, SessionPoolSettings } from "../../src/runtime/session-pool.js";

// The session pool against modeled sites on a virtual clock: every wait is a timer, and time
// jumps to the next timer only once nothing else can run.

const virtualClock = () => {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push({ at: now + Math.max(0, ms), resolve });
    });
  const idle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const run = async <T>(work: Promise<T>): Promise<T> => {
    let settled: { value: T } | undefined;
    let failed: { error: unknown } | undefined;
    work.then(
      (value) => {
        settled = { value };
      },
      (error: unknown) => {
        failed = { error };
      },
    );
    for (;;) {
      await idle();
      if (settled !== undefined) return settled.value;
      if (failed !== undefined) throw failed.error;
      timers.sort((left, right) => left.at - right.at);
      const next = timers.shift();
      if (next === undefined) throw new Error("Nothing left to wait for");
      now = Math.max(now, next.at);
      next.resolve();
    }
  };
  return { now: () => now, sleep, run };
};

type Clock = ReturnType<typeof virtualClock>;

interface ModeledSession {
  readonly number: number;
  readonly openedAt: number;
  readonly reads: number[];
  closed: boolean;
}

/**
 * A site whose rate limit follows the cookie session (`perSessionPerMinute` reads a minute) or
 * the address (`perAddressPerMinute` across every session), each read taking `readMs`.
 */
const modeledSite = (
  clock: Clock,
  limits: {
    readonly perSessionPerMinute?: number;
    readonly perAddressPerMinute?: number;
    readonly blockAt?: number;
  },
  readMs = 3_000,
) => {
  const sessions: ModeledSession[] = [];
  const addressReads: number[] = [];
  let reading = 0;
  let mostReading = 0;
  const startsAfterStop: number[] = [];
  let stoppedAt: number | undefined;
  const recent = (times: readonly number[], at: number) =>
    times.filter((time) => time > at - 60_000).length;
  return {
    sessions,
    mostReading: () => mostReading,
    startsAfterStop,
    driver: {
      open: async () => {
        await clock.sleep(500);
        const session: ModeledSession = {
          number: sessions.length + 1,
          openedAt: clock.now(),
          reads: [],
          closed: false,
        };
        sessions.push(session);
        return session;
      },
      read: async (session: ModeledSession, index: number): Promise<SessionAnswer<string>> => {
        const at = clock.now();
        if (stoppedAt !== undefined) startsAfterStop.push(index);
        session.reads.push(at);
        addressReads.push(at);
        reading += 1;
        mostReading = Math.max(mostReading, reading);
        await clock.sleep(readMs);
        reading -= 1;
        if (limits.blockAt === index) {
          stoppedAt = at;
          return { kind: "blocked", value: `blocked ${index}` };
        }
        const sessionHot =
          limits.perSessionPerMinute !== undefined &&
          recent(session.reads, at) > limits.perSessionPerMinute;
        const addressHot =
          limits.perAddressPerMinute !== undefined &&
          recent(addressReads, at) > limits.perAddressPerMinute;
        if (sessionHot || addressHot) {
          return { kind: "walled", value: `walled ${index}` };
        }
        return { kind: "answered", value: `item ${index}` };
      },
      close: async (session: ModeledSession) => {
        await clock.sleep(100);
        session.closed = true;
      },
    },
  };
};

const settings = (clock: Clock, overrides: Partial<SessionPoolSettings> = {}): SessionPoolSettings => ({
  start: 2,
  max: 8,
  staggerMs: sessionPoolDefaults.staggerMs,
  sessionIntervalMs: sessionPoolDefaults.sessionIntervalMs,
  maxPerMinute: sessionPoolDefaults.maxPerMinute,
  maxAttempts: sessionPoolDefaults.maxAttempts,
  maxFreshSessions: sessionPoolDefaults.maxFreshSessions,
  now: clock.now,
  sleep: clock.sleep,
  ...overrides,
});

describe("sessionPool", () => {
  it("reads every item over staggered sessions, each within its pace, ramping up to the most", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, { perSessionPerMinute: 40 });
    const run = await clock.run(sessionPool(60, site.driver, settings(clock)));

    expect(run.outcomes.map((outcome) => outcome.state === "answered" && outcome.value)).toEqual(
      Array.from({ length: 60 }, (_, index) => `item ${index}`),
    );
    expect(run.stopped).toBeUndefined();
    expect(run.limitScope).toBe("none_seen");
    expect(run.sessions.walls).toBe(0);
    expect(run.sessions.opened).toBe(8);
    expect(site.mostReading()).toBe(8);
    const opens = site.sessions.map((session) => session.openedAt);
    for (let index = 1; index < opens.length; index += 1)
      expect((opens[index] ?? 0) - (opens[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        sessionPoolDefaults.staggerMs,
      );
    for (const session of site.sessions) {
      for (let index = 1; index < session.reads.length; index += 1)
        expect((session.reads[index] ?? 0) - (session.reads[index - 1] ?? 0)).toBeGreaterThanOrEqual(
          sessionPoolDefaults.sessionIntervalMs,
        );
      expect(session.closed).toBe(true);
    }
  });

  it("starts no more than the address's cap in any minute, however many sessions read", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, {}, 200);
    const run = await clock.run(
      sessionPool(150, site.driver, settings(clock, { staggerMs: 0, sessionIntervalMs: 0, maxPerMinute: 50 })),
    );

    expect(run.outcomes.every((outcome) => outcome.state === "answered")).toBe(true);
    const starts = site.sessions.flatMap((session) => session.reads).sort((left, right) => left - right);
    for (const at of starts)
      expect(starts.filter((time) => time >= at && time < at + 60_000).length).toBeLessThanOrEqual(50);
  });

  it("replaces a walled session with a fresh one, reads its item again and finds the limit per session", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, { perSessionPerMinute: 6 });
    const run = await clock.run(sessionPool(30, site.driver, settings(clock, { sessionIntervalMs: 1_000 })));

    expect(run.outcomes.every((outcome) => outcome.state === "answered")).toBe(true);
    expect(run.sessions.walls).toBeGreaterThan(0);
    expect(run.limitScope).toBe("per_session");
    expect(run.outcomes.some((outcome) => outcome.attempts === 2)).toBe(true);
    // A walled session reads nothing more.
    for (const session of site.sessions.filter((each) => each.reads.length > 7))
      expect(session.reads.length).toBeLessThanOrEqual(7);
  });

  it("stops as ip_limited when a fresh session walls at once, reading nothing more", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, { perAddressPerMinute: 10 });
    const run = await clock.run(sessionPool(40, site.driver, settings(clock, { sessionIntervalMs: 500 })));

    expect(run.stopped).toMatchObject({ reason: "ip_limited" });
    expect(run.limitScope).toBe("per_ip");
    const notRead = run.outcomes.filter((outcome) => outcome.state === "not_read");
    expect(notRead.length).toBeGreaterThan(0);
    expect(notRead.every((outcome) => outcome.state === "not_read" && outcome.reason === "ip_limited")).toBe(
      true,
    );
    const readCount = site.sessions.reduce((sum, session) => sum + session.reads.length, 0);
    expect(readCount).toBeLessThan(40);
    expect(site.sessions.every((session) => session.closed)).toBe(true);
  });

  it("stops at a block, starting nothing after it", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, { blockAt: 3 });
    const run = await clock.run(sessionPool(20, site.driver, settings(clock)));

    expect(run.stopped).toEqual({ reason: "blocked", index: 3 });
    expect(run.outcomes[3]).toMatchObject({ state: "blocked", value: "blocked 3" });
    expect(site.startsAfterStop).toEqual([]);
    expect(run.outcomes.filter((outcome) => outcome.state === "not_read").length).toBeGreaterThan(0);
  });

  it("stops after its fresh sessions run out, when every session keeps walling", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, { perSessionPerMinute: 1 });
    const run = await clock.run(
      sessionPool(30, site.driver, settings(clock, { sessionIntervalMs: 0, maxFreshSessions: 3 })),
    );

    expect(run.stopped).toEqual({ reason: "walled" });
    expect(run.sessions.opened).toBeLessThanOrEqual(2 + 3);
  });

  it("starts no read past its budget, leaving the rest not read", async () => {
    const clock = virtualClock();
    const site = modeledSite(clock, {});
    const run = await clock.run(sessionPool(100, site.driver, settings(clock, { budgetMs: 30_000 })));

    expect(run.stopped).toEqual({ reason: "budget" });
    const starts = site.sessions.flatMap((session) => session.reads);
    expect(Math.max(...starts)).toBeLessThan(30_000);
    expect(run.outcomes.filter((outcome) => outcome.state === "not_read").length).toBeGreaterThan(0);
  });

  it("reports a read that threw as that item's failure and keeps its session", async () => {
    const clock = virtualClock();
    const opened: number[] = [];
    const run = await clock.run(
      sessionPool(
        4,
        {
          open: async () => {
            opened.push(clock.now());
            return {};
          },
          read: async (_session, index) => {
            await clock.sleep(100);
            if (index === 1) throw new Error("No such item");
            return { kind: "answered" as const, value: index };
          },
          close: async () => undefined,
        },
        settings(clock, { start: 1 }),
      ),
    );

    expect(run.outcomes[1]).toMatchObject({ state: "failed", error: "No such item", attempts: 1 });
    expect(run.outcomes.filter((outcome) => outcome.state === "answered").length).toBe(3);
    expect(run.sessions.walls).toBe(0);
  });
});

/**
 * A browser for the page code: each context's tab answers a navigation with the site's script for
 * that URL, firing the document's and its data calls' responses as Playwright would.
 */
const fakeBrowser = (
  script: (url: string, context: number) => { readonly document: number; readonly calls: readonly number[]; readonly ready: boolean },
) => {
  const contexts: { number: number; closed: boolean; pages: number }[] = [];
  const browser = {
    newContext: async () => {
      const state = { number: contexts.length + 1, closed: false, pages: 0 };
      contexts.push(state);
      let ready = false;
      const listeners: ((response: unknown) => void)[] = [];
      const mainFrame = {};
      const response = (url: string, status: number, navigation: boolean) => ({
        url: () => url,
        status: () => status,
        request: () => ({
          isNavigationRequest: () => navigation,
          frame: () => (navigation ? mainFrame : {}),
          resourceType: () => (navigation ? "document" : "fetch"),
        }),
      });
      const page = {
        on: (event: string, listener: (response: unknown) => void) => {
          if (event === "response") listeners.push(listener);
        },
        mainFrame: () => mainFrame,
        goto: async (url: string) => {
          if (state.closed) throw new Error("Target closed");
          const answer = script(url, state.number);
          for (const listener of listeners) listener(response(url, answer.document, true));
          for (const status of answer.calls)
            for (const listener of listeners)
              listener(response(new URL("/api/data", url).toString(), status, false));
          ready = answer.ready;
        },
        locator: () => ({
          waitFor: async () => {
            if (!ready) throw new Error("Timeout waiting for locator");
          },
        }),
      };
      return {
        newPage: async () => {
          state.pages += 1;
          return page;
        },
        close: async () => {
          state.closed = true;
        },
      };
    },
  };
  return { browser, contexts };
};

type PageResult = {
  readonly results: readonly Record<string, unknown>[];
  readonly stopped: Record<string, unknown> | null;
  readonly limitScope: string;
  readonly sessions: Record<string, number>;
};

/** Runs `sessionPoolCode` as a Kernel call body would, reading each item's page in its session. */
const readInPage = (
  browser: unknown,
  items: readonly string[],
  options: Record<string, unknown>,
): Promise<PageResult> => {
  const body = new Function(
    "browser",
    "items",
    "options",
    `${sessionPoolCode}
return readWithSessions(items, async ({ page, item, expect, blocked }) => {
  await page.goto("https://www.example.test/item/" + item);
  if (item === "blocked") blocked("The site showed a challenge");
  await expect(page.locator("#ready"), 50);
  return { item };
}, options);`,
  ) as (browser: unknown, items: unknown, options: unknown) => Promise<PageResult>;
  return body(browser, items, options);
};

const quick = { siteDomain: "example.test", staggerMs: 0, sessionIntervalMs: 0 };

describe("readWithSessions in a Kernel call", () => {
  it("reads a walled item again in a fresh context and closes every context it opened", async () => {
    // The first context walls on its third read: its data call answers 429 and the page never shows.
    const reads = new Map<number, number>();
    const { browser, contexts } = fakeBrowser((_url, context) => {
      const count = (reads.get(context) ?? 0) + 1;
      reads.set(context, count);
      const walled = context === 1 && count >= 3;
      return { document: 200, calls: walled ? [429] : [200], ready: !walled };
    });
    const run = await readInPage(browser, ["a", "b", "c", "d", "e", "f"], { ...quick, start: 1, max: 1 });

    expect(run.results.map((result) => result.ok && result.value)).toEqual(
      ["a", "b", "c", "d", "e", "f"].map((item) => ({ item })),
    );
    expect(run.results[2]).toMatchObject({ attempts: 2, session: 2 });
    expect(run.limitScope).toBe("per_session");
    expect(run.sessions).toMatchObject({ opened: 2, walls: 1 });
    expect(contexts.every((context) => context.closed)).toBe(true);
  });

  it("counts only the site's own throttled calls: another host's 429 leaves a missing page an item failure", async () => {
    const { browser } = fakeBrowser((url) => ({
      document: 200,
      calls: [],
      ready: !url.endsWith("/missing"),
    }));
    const run = await readInPage(browser, ["one", "missing"], { ...quick, siteDomain: "other.test", start: 1 });

    expect(run.results[1]).toMatchObject({ ok: false, error: "failed", attempts: 1 });
    expect(run.sessions).toMatchObject({ opened: 1, walls: 0 });
  });

  it("stops the pool when the script reports a block or the document is refused with a 403", async () => {
    const { browser, contexts } = fakeBrowser((url) => ({
      document: url.endsWith("/refused") ? 403 : 200,
      calls: [],
      ready: !url.endsWith("/refused"),
    }));
    const blocked = await readInPage(browser, ["blocked", "x", "y"], { ...quick, start: 1, max: 1 });
    expect(blocked.stopped).toEqual({ reason: "blocked", index: 0 });
    expect(blocked.results.slice(1).map((result) => result.error)).toEqual(["not_read", "not_read"]);

    const refused = await readInPage(browser, ["refused", "z"], { ...quick, start: 1, max: 1 });
    expect(refused.stopped).toEqual({ reason: "blocked", index: 0 });
    expect(contexts.every((context) => context.closed)).toBe(true);
  });

  it("refuses to start without the site's domain", async () => {
    const { browser, contexts } = fakeBrowser(() => ({ document: 200, calls: [], ready: true }));
    await expect(readInPage(browser, ["a"], { staggerMs: 0 })).rejects.toThrow(/siteDomain/);
    expect(contexts).toEqual([]);
  });
});
