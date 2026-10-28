/**
 * A list of independent reads spread over several isolated cookie sessions in one browser, for a
 * site whose rate limit follows the cookie session rather than the network address: a session
 * that reads too fast starts getting 429 or 503 on the page's own data requests while its pages
 * still load, and a fresh session on the same address reads normally at once. `sessionPoolCode`
 * declares `readWithSessions`, page code for a Kernel call body where `browser` is in scope; it
 * runs `sessionPool`, the loop below, with each session a new browser context and one tab.
 *
 * - Sessions open one at a time, at least `staggerMs` (4 s) apart, so a burst of new sessions
 *   never reaches the site at once. At most `start` (2) sessions read at first. After as many
 *   clean reads in a row as sessions reading, one more may read (half as many again before any
 *   wall), up to `max` (8, which no option raises).
 * - Each session starts a read at most once every `sessionIntervalMs` (2 s, about 30 a minute),
 *   and the whole pool starts at most `maxPerMinute` (100) in any minute, since every session
 *   shares the browser's address.
 * - A walled session (a read that fails after the page's own data requests answered 429 or 503,
 *   or whose document did) halves the number reading, is closed, and its item goes back to the
 *   queue, at most `maxAttempts` (2) reads in all. The slot's next read opens a fresh session.
 *   After `maxFreshSessions` (8) fresh sessions the pool stops as `walled`.
 * - The first read of a session opened after a wall is the probe: when it reads cleanly, the
 *   limit follows the session (`limitScope: "per_session"`); when it walls at once too, the limit
 *   follows the address (`per_ip`), and the pool stops as `ip_limited`, since more sessions on the
 *   same address cannot help: fail the call, so a host may give the read another address.
 * - A block stops the pool at once: a read the script reports blocked, or a document the site
 *   refused with a 403. Nothing more starts; reads already running finish.
 * - Results come back in input order, one for every item: its value, or why it has none.
 */

/** How many sessions read at once: where it starts, the most it reaches and the least. */
export const sessionPoolConcurrency = { start: 2, max: 8, min: 1 } as const;

/** The loop's defaults: its pace, its tries and how long a read may wait for its page. */
export const sessionPoolDefaults = {
  staggerMs: 4_000,
  sessionIntervalMs: 2_000,
  maxPerMinute: 100,
  maxAttempts: 2,
  maxFreshSessions: 8,
  expectTimeoutMs: 12_000,
} as const;

/** How one read of one item ended, as the loop sorts it. */
export type SessionAnswerKind = "answered" | "walled" | "blocked";

export interface SessionAnswer<A> {
  readonly kind: SessionAnswerKind;
  readonly value: A;
}

/** What the loop needs from a session: open one, read one item in it, close it. */
export interface SessionDriver<S, A> {
  readonly open: () => Promise<S>;
  readonly read: (session: S, index: number) => Promise<SessionAnswer<A>>;
  readonly close: (session: S) => Promise<void>;
}

/** Each item's end: its last answer, the read's own failure, or not read. */
export type SessionOutcome<A> =
  | {
      readonly index: number;
      readonly state: SessionAnswerKind;
      readonly value: A;
      readonly attempts: number;
      /** The session that gave the last answer, counted from 1 in the order sessions opened. */
      readonly session: number;
    }
  | { readonly index: number; readonly state: "failed"; readonly error: string; readonly attempts: number }
  | {
      readonly index: number;
      readonly state: "not_read";
      readonly reason: "blocked" | "ip_limited" | "walled" | "budget";
      readonly attempts: number;
    };

/** Why the pool stopped early. */
export type SessionPoolStop =
  | { readonly reason: "blocked"; readonly index: number }
  | { readonly reason: "ip_limited"; readonly index: number }
  | { readonly reason: "walled" }
  | { readonly reason: "budget" };

/**
 * What the walls showed: `per_session` when a fresh session read cleanly right after a wall,
 * `per_ip` when it walled at once as well, `none_seen` with no wall, `unknown` when walls came
 * but no fresh session finished its first read.
 */
export type SessionLimitScope = "per_session" | "per_ip" | "none_seen" | "unknown";

export interface SessionPoolRun<A> {
  readonly outcomes: readonly SessionOutcome<A>[];
  readonly stopped: SessionPoolStop | undefined;
  readonly limitScope: SessionLimitScope;
  readonly sessions: {
    readonly opened: number;
    readonly walls: number;
    /** The most sessions reading at once. */
    readonly peak: number;
  };
}

export interface SessionClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface SessionPoolSettings extends SessionClock {
  readonly start: number;
  readonly max: number;
  readonly staggerMs: number;
  readonly sessionIntervalMs: number;
  readonly maxPerMinute: number;
  readonly maxAttempts: number;
  readonly maxFreshSessions: number;
  /** Start no read past this many milliseconds; none by default. */
  readonly budgetMs?: number | undefined;
}

/**
 * The loop. It refers to nothing outside its own body, because `sessionPoolCode` pastes its
 * source into the Kernel call.
 */
export async function sessionPool<S, A>(
  count: number,
  driver: SessionDriver<S, A>,
  settings: SessionPoolSettings,
): Promise<SessionPoolRun<A>> {
  const outcomes: (SessionOutcome<A> | undefined)[] = Array.from({ length: count }, () => undefined);
  const attempts: number[] = Array.from({ length: count }, () => 0);
  const queue: number[] = Array.from({ length: count }, (_, index) => index);
  const max = Math.max(1, settings.max);
  // A slot is one place a session reads; its session is replaced after a wall.
  const slots: {
    session: S | undefined;
    number: number;
    probe: boolean;
    reads: number;
    lastStart: number;
    busy: boolean;
    /** A walled item this slot's fresh session reads first: the probe. */
    pending: number | undefined;
  }[] = [];
  const running = new Set<Promise<void>>();
  const closing: Promise<void>[] = [];
  const starts: number[] = [];
  const begun = settings.now();
  let limit = Math.max(1, Math.min(settings.start, max));
  let walledBefore = false;
  let clean = 0;
  let opened = 0;
  let fresh = 0;
  let walls = 0;
  let peak = 0;
  let nextOpen = begun;
  let scope: SessionLimitScope = "none_seen";
  let stopped: SessionPoolStop | undefined;
  const reading = () => slots.filter((slot) => slot.busy).length;
  const waiting = () => queue.length + slots.filter((slot) => slot.pending !== undefined).length;
  /** Keeps `starts` in time order, since a read starts only once its session has opened. */
  const started = (at: number) => {
    let index = starts.length;
    while (index > 0 && (starts[index - 1] ?? 0) > at) index -= 1;
    starts.splice(index, 0, at);
  };
  const stop = (reason: SessionPoolStop) => {
    if (stopped === undefined) stopped = reason;
  };
  const closeQuietly = async (session: S) => {
    try {
      await driver.close(session);
    } catch {
      // A session that will not close is left to the browser's end.
    }
  };
  const settle = (
    slot: (typeof slots)[number],
    index: number,
    answer: SessionAnswer<A> | undefined,
    error: string,
  ) => {
    const tries = attempts[index] ?? 0;
    const probe = slot.probe && slot.reads === 1;
    if (answer === undefined) {
      outcomes[index] = { index, state: "failed", error, attempts: tries };
      return;
    }
    outcomes[index] = { index, state: answer.kind, value: answer.value, attempts: tries, session: slot.number };
    if (answer.kind === "blocked") {
      stop({ reason: "blocked", index });
      return;
    }
    if (answer.kind === "answered") {
      if (probe) scope = "per_session";
      clean += 1;
      if (clean >= limit) {
        clean = 0;
        limit = Math.min(max, walledBefore ? limit + 1 : Math.ceil(limit * 1.5));
      }
      return;
    }
    walls += 1;
    walledBefore = true;
    clean = 0;
    limit = Math.max(1, Math.floor(limit / 2));
    const session = slot.session;
    slot.session = undefined;
    if (session !== undefined) closing.push(closeQuietly(session));
    if (probe) {
      scope = "per_ip";
      stop({ reason: "ip_limited", index });
      return;
    }
    if (scope === "none_seen") scope = "unknown";
    if (tries < settings.maxAttempts) {
      outcomes[index] = undefined;
      slot.pending = index;
    }
  };
  const begin = (slot: (typeof slots)[number], index: number) => {
    slot.busy = true;
    // The read's place in the pace is held from now, and moved to when it starts reading.
    const held = settings.now();
    slot.lastStart = held;
    started(held);
    attempts[index] = (attempts[index] ?? 0) + 1;
    peak = Math.max(peak, reading());
    const task = (async () => {
      let answer: SessionAnswer<A> | undefined;
      let error = "";
      try {
        if (slot.session === undefined) {
          const replacing = slot.number !== 0;
          slot.session = await driver.open();
          opened += 1;
          slot.number = opened;
          slot.probe = replacing;
          slot.reads = 0;
          const at = starts.indexOf(held);
          if (at !== -1) starts.splice(at, 1);
          slot.lastStart = settings.now();
          started(slot.lastStart);
        }
        slot.reads += 1;
        answer = await driver.read(slot.session, index);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      slot.busy = false;
      settle(slot, index, answer, error);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
  };
  /** Starts in the last minute, oldest first. */
  const recentStarts = (now: number) => {
    while (starts.length > 0 && (starts[0] ?? now) <= now - 60_000) starts.shift();
    return starts;
  };
  /** The earliest time another read could start, given the pace and the stagger. */
  const earliestStart = (now: number) => {
    const recent = recentStarts(now);
    const windowFree = recent.length >= settings.maxPerMinute ? (recent[0] ?? now) + 60_000 : now;
    let at = Number.POSITIVE_INFINITY;
    for (const slot of slots)
      if (!slot.busy && slot.session !== undefined && queue.length > 0)
        at = Math.min(at, slot.lastStart + settings.sessionIntervalMs);
    const opening =
      slots.some((slot) => !slot.busy && slot.session === undefined && (slot.pending !== undefined || queue.length > 0)) ||
      (slots.length < limit && queue.length > 0);
    if (opening) at = Math.min(at, nextOpen);
    return Math.max(at, windowFree);
  };
  /** Starts one read if the pace allows it now: an open session first, else a new one. */
  const tryStart = (): boolean => {
    const now = settings.now();
    if (recentStarts(now).length >= settings.maxPerMinute) return false;
    const ready =
      queue.length === 0
        ? undefined
        : slots.find(
            (slot) =>
              !slot.busy &&
              slot.session !== undefined &&
              slot.lastStart + settings.sessionIntervalMs <= now,
          );
    if (ready !== undefined) {
      begin(ready, queue.shift() as number);
      return true;
    }
    if (nextOpen > now) return false;
    // A walled item goes to its slot's fresh session first; then a new slot, or a closed one.
    let slot =
      slots.find((each) => !each.busy && each.session === undefined && each.pending !== undefined) ??
      (queue.length === 0 ? undefined : slots.find((each) => !each.busy && each.session === undefined));
    if (slot === undefined && slots.length < limit && queue.length > 0) {
      slot = {
        session: undefined,
        number: 0,
        probe: false,
        reads: 0,
        lastStart: 0,
        busy: false,
        pending: undefined,
      };
      slots.push(slot);
    }
    if (slot === undefined) return false;
    if (slot.number !== 0) {
      if (fresh >= settings.maxFreshSessions) {
        stop({ reason: "walled" });
        return false;
      }
      fresh += 1;
    }
    nextOpen = now + settings.staggerMs;
    const index = slot.pending ?? (queue.shift() as number);
    slot.pending = undefined;
    begin(slot, index);
    return true;
  };
  while (stopped === undefined && (waiting() > 0 || running.size > 0)) {
    if (
      waiting() > 0 &&
      settings.budgetMs !== undefined &&
      settings.now() - begun >= settings.budgetMs
    ) {
      stop({ reason: "budget" });
      break;
    }
    while (waiting() > 0 && stopped === undefined && reading() < limit && tryStart()) {
      // Started one; another may start now too.
    }
    if (stopped !== undefined || (waiting() === 0 && running.size === 0)) break;
    const waits: Promise<unknown>[] = [...running];
    if (waiting() > 0 && reading() < limit) {
      const at = earliestStart(settings.now());
      if (Number.isFinite(at)) waits.push(settings.sleep(Math.max(0, at - settings.now())));
    }
    if (waits.length === 0) break;
    await Promise.race(waits);
  }
  // Reads already running finish, so each item ends with what its read saw.
  await Promise.all([...running]);
  for (const slot of slots) if (slot.session !== undefined) closing.push(closeQuietly(slot.session));
  await Promise.all(closing);
  const reason = stopped?.reason ?? "budget";
  return {
    outcomes: outcomes.map(
      (outcome, index) =>
        outcome ?? { index, state: "not_read", reason, attempts: attempts[index] ?? 0 },
    ),
    stopped,
    limitScope: scope,
    sessions: { opened, walls, peak },
  };
}

/**
 * Page code for a Kernel call body, where `browser` is in scope: paste it once at the top of the
 * code string. It declares `readWithSessions(items, readOne, options)`, which reads every item in
 * one of several new browser contexts of the call's browser, each with one tab and cookies of its
 * own, with the pace, the walls and the stops the module comment describes, and closes every
 * context it opened before it returns `{ results, stopped, limitScope, sessions }`.
 *
 * - `readOne({ page, context, item, index, expect, blocked })` reads one item in its session's tab
 *   and returns what to report for it. `expect(locator, timeoutMs?)` waits for an element the read
 *   needs (12 s by default) and throws when it never shows; `blocked(message)` throws to stop the
 *   pool when the page shows a challenge or a block.
 * - A read that throws after the page's own xhr or fetch requests to the site answered 429 or 503,
 *   or after its document did, is a wall: the session is closed and the item read again in a
 *   fresh one. One that throws with no such answer is that item's failure, and its session goes on.
 * - `options.siteDomain` (required) is the site's registrable domain, the operation context's
 *   `siteDomain`; only answers from it or its subdomains count. `options` also takes `start`,
 *   `max`, `staggerMs`, `sessionIntervalMs`, `maxPerMinute`, `maxAttempts`, `maxFreshSessions`,
 *   `expectTimeoutMs` and `budgetMs`: pass the call's remaining time, less a margin, so it
 *   returns before the call's timeout with `not_read` for what it kept back. Pass the pace the
 *   build saw the site take without walling as `sessionIntervalMs` and `max`.
 * - `results` holds one entry per item, in input order: `{ ok: true, value, session, attempts }`,
 *   or `{ ok: false, error, message?, reason?, attempts }` with `error` one of `walled` (still
 *   walled after its tries), `blocked`, `failed` (the read threw) or `not_read`. `stopped` is
 *   null, or `{ reason, index? }` with `reason` `blocked`, `ip_limited`, `walled` or `budget`.
 *   `limitScope` and `sessions` say what the walls showed and how many sessions opened.
 *
 * When `stopped` is `blocked` or `ip_limited`, fail the read in the script, after
 * `waitPastChallenge` when the page shows a challenge, as the core skill's 429 rule says, so a host
 * may give it another browser or address.
 */
export const sessionPoolCode = String.raw`
const readWithSessions = async (items, readOne, options = {}) => {
  const siteDomain = String(options.siteDomain ?? "").toLowerCase().replace(/^\.+/, "");
  if (siteDomain === "") throw new Error("readWithSessions needs options.siteDomain, the site's registrable domain.");
  const settings = {
    start: Math.max(1, Math.min(options.start ?? ${sessionPoolConcurrency.start}, ${sessionPoolConcurrency.max})),
    max: Math.max(1, Math.min(options.max ?? ${sessionPoolConcurrency.max}, ${sessionPoolConcurrency.max})),
    staggerMs: Math.max(0, options.staggerMs ?? ${sessionPoolDefaults.staggerMs}),
    sessionIntervalMs: Math.max(0, options.sessionIntervalMs ?? ${sessionPoolDefaults.sessionIntervalMs}),
    maxPerMinute: Math.max(1, options.maxPerMinute ?? ${sessionPoolDefaults.maxPerMinute}),
    maxAttempts: Math.max(1, options.maxAttempts ?? ${sessionPoolDefaults.maxAttempts}),
    maxFreshSessions: Math.max(0, options.maxFreshSessions ?? ${sessionPoolDefaults.maxFreshSessions}),
    budgetMs: options.budgetMs,
  };
  const expectTimeoutMs = options.expectTimeoutMs ?? ${sessionPoolDefaults.expectTimeoutMs};
  const sameSite = (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === siteDomain || host.endsWith("." + siteDomain);
    } catch {
      return false;
    }
  };
  const messageOf = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
  const sessionPool = ${sessionPool.toString()};
  const run = await sessionPool(items.length, {
    open: async () => {
      const context = await browser.newContext();
      const tab = await context.newPage();
      const session = { context, page: tab, throttled: 0, documentStatus: undefined };
      tab.on("response", (response) => {
        try {
          if (!sameSite(response.url())) return;
          const request = response.request();
          const status = response.status();
          if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) session.documentStatus = status;
          else if ((status === 429 || status === 503) && ["xhr", "fetch"].includes(request.resourceType())) session.throttled += 1;
        } catch {
          // A response the tab closed under is no answer.
        }
      });
      return session;
    },
    read: async (session, index) => {
      session.throttled = 0;
      session.documentStatus = undefined;
      const expect = async (locator, timeoutMs = expectTimeoutMs) => {
        await locator.waitFor({ state: "visible", timeout: timeoutMs });
      };
      const blocked = (message) => {
        const error = new Error(String(message ?? "The site blocked the session"));
        error.name = "SessionBlocked";
        throw error;
      };
      try {
        const value = await readOne({ page: session.page, context: session.context, item: items[index], index, expect, blocked });
        return { kind: "answered", value: { value } };
      } catch (error) {
        const message = messageOf(error);
        if (error?.name === "SessionBlocked" || session.documentStatus === 403) return { kind: "blocked", value: { message } };
        if (session.throttled > 0 || session.documentStatus === 429 || session.documentStatus === 503) return { kind: "walled", value: { message } };
        throw error;
      }
    },
    close: async (session) => {
      await session.context.close();
    },
  }, { ...settings, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  return {
    results: run.outcomes.map((outcome) =>
      outcome.state === "answered"
        ? { ok: true, value: outcome.value.value, session: outcome.session, attempts: outcome.attempts }
        : outcome.state === "failed"
          ? { ok: false, error: "failed", message: outcome.error, attempts: outcome.attempts }
          : outcome.state === "not_read"
            ? { ok: false, error: "not_read", reason: outcome.reason, attempts: outcome.attempts }
            : { ok: false, error: outcome.state, message: outcome.value.message, attempts: outcome.attempts }),
    stopped: run.stopped === undefined ? null : run.stopped,
    limitScope: run.limitScope,
    sessions: run.sessions,
  };
};
`;
