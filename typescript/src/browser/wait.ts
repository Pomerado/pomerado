import { timeoutDefaults } from "../runtime/deadline.js";

/**
 * What one outcome's locator matched at the last look: all its matches and the visible ones, and
 * after an `action`, how many visible ones are new or changed since before it.
 */
export interface OutcomeObservation {
  readonly count: number;
  readonly visible: number;
  readonly changed?: number;
}

/** When a progress sign was first and last seen, in milliseconds from the wait's start. */
export interface WaitProgressSign {
  readonly first: number;
  readonly last: number;
}

/**
 * What a wait saw of the page's progress: each kind of sign and when, how long ago the last one
 * was, the page's own requests still in flight, and how many repeating requests it ignored.
 */
export interface WaitProgress {
  readonly signs: Readonly<Record<string, WaitProgressSign>>;
  readonly quietSinceMs: number;
  readonly inflight: number;
  readonly ignoredRepeats: number;
}

/** One entry of `waitReport()`: a wait this call ran and how it ended, in words and numbers. */
export interface WaitRecord {
  readonly wait: "waitForOutcome" | "waitForRows" | "waitForValues" | "waitForChange";
  readonly outcome?: string;
  readonly reason?: string;
  readonly elapsedMs: number;
  readonly looks: number;
  readonly progress: string;
  readonly summary: string;
}

/**
 * The page-progress tracker every wait shares. A wait keeps going while the page shows progress
 * and fails once it has shown none for `noProgressMs`. Progress is any of:
 *
 * - the author's `loading` locator showing (for as long as it shows);
 * - a generic loading sign, within `region` when one is named, coming, going, or new: a busy
 *   region, an indeterminate progress bar, or a skeleton, shimmer, spinner or loader class (never
 *   on a form control) counts while it shows until it has held for `noProgressMs`. Determinate
 *   bars (ratings, steps, meters) never count, and signs showing before the action in the same
 *   number, or class hints already there at the first look, are the page's own decoration.
 *   `waitForRows` also counts, for as long as it shows, any such sign beside its rows (in their
 *   container or the element around it, never inside a row);
 * - DOM changes inside the author's `region` (never the whole page: carousels and ads never stop);
 * - one of the site's own `document`, `xhr` or `fetch` requests in flight (the site is
 *   `siteDomain`, else a conservative guess from the page's host). A request the action started
 *   counts until it ends, up to `lateFillCap`, and the page then gets `unchangedMs` to render its
 *   answer; any other counts for 10 s and keeps the page busy for 4 s, since long-polls and
 *   streams stay open. Beacons, images, fonts and media never count, and a request repeated with
 *   the same method, URL and body (numbers aside) at a steady interval is a poll and is ignored;
 * - the page's URL changing, or the page being replaced;
 * - the wait's own reads changing: an outcome's matches, rows or values filling or changing.
 *
 * Network activity alone never proves the content is coming; it only keeps a wait alive.
 */
const progressCode = String.raw`
const waitLimits = Object.freeze(${JSON.stringify({
  navigation: timeoutDefaults.navigation,
  action: timeoutDefaults.action,
  answer: timeoutDefaults.answer,
  answerCap: timeoutDefaults.answerCap,
  settle: timeoutDefaults.settle,
  unchanged: timeoutDefaults.unchanged,
  lateFillCap: timeoutDefaults.lateFillCap,
})});
const waitRecords = [];
// Every wait this call ran, oldest first, each with a sentence saying how it ended.
const waitReport = () => waitRecords.map((record) => ({ ...record }));
const waitSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitSeconds = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + " s";
const waitContextLost = (error) =>
  /Execution context was destroyed|Frame was detached/.test(String(error?.message));
// Generic loading signs. A busy region or an indeterminate progress bar says the page is loading;
// a determinate bar (one with a value) is a rating, a step or a meter. A class that names a
// skeleton, shimmer, spinner or loader is only a hint, and never on a form control.
const waitLoadingSigns = '[aria-busy="true"], [role="progressbar"]:not([aria-valuenow], [aria-valuetext])';
const waitLoadingClasses =
  ':is([class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [class*="loader" i]):not(input, select, textarea, button, option, [role="progressbar"])';
// A request the wait's action started, while it ran or in the second after, is the answer on its
// way: it counts as progress and keeps the page busy until it ends, up to
// lateFillCap. Any other request counts as progress for up to 10 s, and keeps the page busy for up
// to 4 s (or the no-progress window when shorter): a long-poll or a stream stays open with nothing
// to come, and starts on its own.
const waitCausedMs = 1000;
const waitInflightMs = 10000;
const waitBusyRequestMs = 4000;
// The site's registrable domain, when the code gave none: the last two labels of the page's host,
// or three under a country's shared second level (example.co.uk, never co.uk). Pass the context's
// siteDomain, which the host computed with the public suffix list, to be exact.
const waitSiteDomain = (host) => {
  const labels = host.split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return host;
  const shared = labels.at(-1).length === 2 &&
    /^(?:ac|co|com|edu|gen|go|gob|gov|gv|in|ind|info|int|lg|ltd|me|mil|ne|net|nhs|nic|nom|or|org|plc|sch|web)$/.test(labels.at(-2));
  return labels.slice(shared ? -3 : -2).join(".");
};
// What makes two requests the same one again: method, path, query and body, with every number
// (counters, timestamps, cache busters) read as the same.
const waitRequestKey = (request) => {
  const url = new URL(request.url());
  const body = String(request.postData() ?? "").slice(0, 4096).replace(/\d+/g, "#");
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 1) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619);
  return request.method() + " " + url.origin + url.pathname + url.search.replace(/\d+/g, "#") + " " + (hash >>> 0).toString(36);
};
const waitProgress = (options = {}) => {
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const key = "pomerado.waitProgress." + Date.now() + "." + Math.random();
  let started = Date.now();
  // Requests that start before this are the action's: from the baseline look, taken just before
  // the action, to a second after it returned. A wait without an action causes none.
  let causedUntil = -Infinity;
  let acted = false;
  let lastProgress = started;
  let signs = {};
  const mark = (kind, at = Date.now()) => {
    const sign = (signs[kind] ??= { first: at - started, last: at - started });
    sign.last = at - started;
    if (at > lastProgress) lastProgress = at;
  };
  const sameSite = (url) => {
    try {
      const host = new URL(url).hostname;
      const domain = options.siteDomain ?? waitSiteDomain(new URL(page.url()).hostname);
      return domain !== "" && (host === domain || host.endsWith("." + domain));
    } catch {
      return false;
    }
  };
  // The site's requests in flight, by request: when each started and what makes it the same again.
  const pending = new Map();
  const starts = new Map();
  const polls = new Set();
  let ignoredRepeats = 0;
  const onRequest = (request) => {
    if (!["document", "xhr", "fetch"].includes(request.resourceType()) || !sameSite(request.url())) return;
    const key = waitRequestKey(request);
    const now = Date.now();
    // A poll repeats the same request at a steady interval: from its third start, once two
    // intervals of at least 50 ms agree within half, it is ignored with every copy in flight.
    // Requests to one path that differ, such as an API's different queries, never are.
    const times = [...(starts.get(key) ?? []), now].slice(-3);
    starts.set(key, times);
    if (!polls.has(key) && times.length === 3) {
      const [first, second] = [times[1] - times[0], times[2] - times[1]];
      if (Math.min(first, second) >= 50 && Math.abs(first - second) <= Math.max(first, second) / 2) {
        polls.add(key);
        for (const [other, entry] of pending) if (entry.key === key) pending.delete(other);
      }
    }
    if (polls.has(key)) {
      ignoredRepeats += 1;
      return;
    }
    pending.set(request, { at: now, key, caused: now <= causedUntil });
    mark("site request");
  };
  // When the action's last request ended: the page then gets unchangedMs to render its answer.
  let causedEnded = -Infinity;
  const onDone = (request) => {
    const entry = pending.get(request);
    if (entry === undefined) return;
    pending.delete(request);
    if (entry.caused) causedEnded = Date.now();
    mark("site request");
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  let url = page.url();
  // Generic signs, each kind with its count before the action (or, for class hints, at the first
  // look), its count at the last look and when that last changed. A sign counts while it shows
  // more than before, until its count has held for the no-progress window. A sign that stays is
  // part of the page. (waitForRows also counts the signs beside its rows: see waitListSigns.)
  const generic = {
    signs: { selector: waitLoadingSigns, holdMs: noProgressMs, before: undefined, count: 0, changedAt: started, shows: false },
    classes: {
      selector: waitLoadingClasses,
      holdMs: noProgressMs,
      before: undefined,
      count: 0,
      changedAt: started,
      shows: false,
      firstLook: true,
    },
  };
  let loadingShows = false;
  let region = { count: 0, targets: 0 };
  const scope = options.region ?? page;
  // One look at the page's signs. The baseline look, taken before the action, notes them without
  // counting anything as progress.
  // Quiet time runs to the latest look that could see progress: the first look after the start
  // only installs the region's observer and notes the signs.
  let samples = 0;
  let sampledAt = started;
  const sample = async (changes = [], baseline = false) => {
    const now = Date.now();
    samples += 1;
    sampledAt = now;
    const note = (kind) => {
      if (!baseline) mark(kind, now);
    };
    for (const kind of changes) note(kind);
    if (page.url() !== url) {
      url = page.url();
      note("URL change");
    }
    for (const { at, caused } of pending.values())
      if (now - at < (caused ? waitLimits.lateFillCap : waitInflightMs)) {
        note("site request");
        break;
      }
    try {
      loadingShows = options.loading !== undefined && (await options.loading.filter({ visible: true }).count()) > 0;
      if (loadingShows) note("loading sign");
      // A generic sign counts when it comes or goes, and while it is new: see generic above.
      for (const sign of Object.values(generic)) {
        const count = await scope.locator(sign.selector).filter({ visible: true }).count();
        if (baseline || (sign.firstLook && sign.before === undefined)) {
          sign.before = count;
          sign.changedAt = now;
        } else {
          if (count !== sign.count) {
            sign.changedAt = now;
            note("loading sign");
          }
          sign.shows = count > (sign.before ?? 0) && now - sign.changedAt < sign.holdMs;
          if (sign.shows) note("loading sign");
        }
        sign.count = count;
      }
      if (options.region !== undefined) {
        const seen = await options.region.evaluateAll((elements, key) => {
          const state = (globalThis[Symbol.for(key)] ??= { count: 0, targets: new Set() });
          state.observer ??= new MutationObserver((records) => {
            state.count += records.length;
          });
          for (const element of elements)
            if (!state.targets.has(element)) {
              state.targets.add(element);
              state.observer.observe(element, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["class", "hidden", "aria-busy", "aria-hidden", "src", "value", "disabled"],
              });
            }
          return { count: state.count, targets: state.targets.size };
        }, key);
        // The first look only installs the observer; a region that appears later is progress.
        if (seen.count !== region.count || (seen.targets !== region.targets && region.targets !== 0))
          note("region changes");
        region = seen;
      }
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      note("page replaced");
    }
  };
  return {
    // Before the action: what already shows is the page from before it.
    baseline: () => {
      acted = true;
      causedUntil = Infinity;
      return sample([], true);
    },
    // The budgets start once the action returns; requests it started stay in flight.
    begin: () => {
      started = Date.now();
      causedUntil = acted ? started + waitCausedMs : -Infinity;
      lastProgress = started;
      signs = {};
      samples = 0;
    },
    // Without a baseline, a sign already showing at the first look is the page still loading.
    sample: (changes) => sample(changes),
    quietMs: () => (samples < 2 ? 0 : sampledAt - lastProgress),
    // A loading sign showing or a site request in flight, at the last look. waitForRows judges the
    // generic signs itself, beside its rows (pageSigns false).
    busy: (pageSigns = true) => {
      const now = Date.now();
      const busyRequestMs = Math.min(noProgressMs, waitBusyRequestMs);
      return loadingShows || (pageSigns && (generic.signs.shows || generic.classes.shows)) ||
        now - causedEnded < (options.unchangedMs ?? waitLimits.unchanged) ||
        [...pending.values()].some(({ at, caused }) => now - at < (caused ? waitLimits.lateFillCap : busyRequestMs));
    },
    diagnostics: () => ({
      signs: Object.fromEntries(Object.entries(signs).map(([kind, sign]) => [kind, { ...sign }])),
      quietSinceMs: lastProgress - started,
      inflight: pending.size,
      ignoredRepeats,
    }),
    describe: () => {
      const entries = Object.entries(signs);
      const seen = entries.length === 0
        ? "no progress seen"
        : "progress seen: " +
          entries
            .map(([kind, { first, last }]) =>
              kind + " " + (last > first ? waitSeconds(first) + "–" + waitSeconds(last) : "at " + waitSeconds(first)))
            .join(", ") +
          "; last progress at " + waitSeconds(lastProgress - started);
      return seen + (ignoredRepeats > 0 ? "; ignored " + ignoredRepeats + " repeating requests" : "");
    },
    stop: async () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      await options.region
        ?.evaluateAll((elements, key) => {
          globalThis[Symbol.for(key)]?.observer?.disconnect();
          delete globalThis[Symbol.for(key)];
        }, key)
        .catch(() => undefined);
    },
  };
};
const waitRecord = (record) => {
  waitRecords.push(record);
  return record;
};
`;

/**
 * `waitForOutcome`, unchanged in what it decides, now with a progress budget: it fails as
 * `outcome_unknown` once the page shows no outcome and no progress for `noProgressMs`.
 */
const outcomeCode = String.raw`
const outcomeWaitSeen = (observations) =>
  Object.entries(observations)
    .map(([name, { count, visible, changed }]) =>
      name + " " + visible + " visible of " + count + (changed === 0 && visible > 0 ? ", unchanged" : ""))
    .join(", ");
const outcomeWaitFailure = (reason, message, observations, extra) =>
  Object.assign(new Error(reason + message), {
    name: "OutcomeWaitFailure",
    reason,
    observations,
    ...extra,
  });
// What each visible element showed before the action, kept in the page by a key of this wait's
// own; a page the action replaced has none, so everything on it is new.
const outcomeWaitNote = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = (globalThis[Symbol.for(key)] ??= new WeakMap());
    for (const element of elements) noted.set(element, element.innerText);
  }, key);
const outcomeWaitChanged = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = globalThis[Symbol.for(key)];
    return elements.filter((element) => noted?.get(element) !== element.innerText).length;
  }, key);
const outcomeWaitObserve = async (outcomes, key) => {
  const observations = {};
  for (const [name, locator] of Object.entries(outcomes)) {
    const count = await locator.count();
    const visible = count === 0 ? 0 : await locator.filter({ visible: true }).count();
    observations[name] = key === undefined ? { count, visible }
      : { count, visible, changed: visible === 0 ? 0 : await outcomeWaitChanged(locator, key) };
  }
  return observations;
};
const waitForOutcome = async (outcomes, options = {}) => {
  const names = Object.keys(outcomes);
  if (names.length === 0) throw new TypeError("waitForOutcome needs at least one outcome");
  const timeout = options.timeout ?? waitLimits.answerCap;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const progress = waitProgress({ ...options, noProgressMs });
  let looks = 0;
  const finish = (fields, summary) =>
    waitRecord({
      wait: "waitForOutcome",
      ...fields,
      elapsedMs: Date.now() - begun,
      looks,
      progress: progress.describe(),
      summary: "waitForOutcome: " + summary + "; " + progress.describe(),
    });
  let begun = Date.now();
  let key;
  try {
    if (options.action !== undefined) {
      key = "pomerado.outcomeWait." + Date.now() + "." + Math.random();
      for (const locator of Object.values(outcomes)) await outcomeWaitNote(locator, key);
      await progress.baseline();
      await options.action();
    }
    progress.begin();
    begun = Date.now();
    const until = begun + timeout;
    const unchangedFrom = begun + (options.unchangedMs ?? waitLimits.unchanged);
    // A page or frame the action is replacing can drop a look midway; the next look sees the new one.
    const look = () =>
      outcomeWaitObserve(outcomes, key).catch((error) => {
        if (waitContextLost(error)) return undefined;
        throw error;
      });
    // The outcomes are looked at one after another, so the page can change between two of them:
    // a decision holds only once the next look, taken at once, agrees.
    let previous;
    let last;
    let signature;
    let quietBefore = false;
    while (true) {
      const observations = await look();
      looks += 1;
      const current = JSON.stringify(observations ?? null);
      await progress.sample(
        observations === undefined ? ["page replaced"]
          : signature !== undefined && current !== signature ? ["outcome matches changing"] : [],
      );
      signature = current;
      last = observations ?? last;
      const stale = Date.now() < unchangedFrom;
      const shown = names.find(
        (name) => observations?.[name].visible > 0 && !(stale && observations[name].changed === 0),
      );
      const decision = shown === undefined ? undefined : shown + ":" + Math.min(observations[shown].count, 2);
      if (decision !== undefined && decision === previous) {
        if (observations[shown].count > 1) {
          const failure = outcomeWaitFailure("outcome_ambiguous", ": " + outcomeWaitSeen(observations), observations, {
            outcome: shown,
          });
          finish({ reason: "outcome_ambiguous", outcome: shown }, failure.message);
          throw failure;
        }
        finish({ outcome: shown }, '"' + shown + '" showed after ' + (Date.now() - begun) + " ms (" + looks + " looks)");
        return shown;
      }
      const settled = decision === undefined || previous !== undefined;
      // A first sighting at the deadline still gets its confirming look.
      if (Date.now() >= until && settled) {
        const seen = last ?? (await look().catch(() => undefined)) ?? {};
        const failure = outcomeWaitFailure(
          "outcome_timeout",
          " after " + Math.round(timeout) + " ms: " + outcomeWaitSeen(seen) + "; " + progress.describe(),
          seen,
          { progress: progress.diagnostics() },
        );
        finish({ reason: "outcome_timeout" }, failure.message);
        throw failure;
      }
      // Nothing shows, not even an answer from before the action, and the page went quiet.
      // A quiet page fails only when the next look agrees, since the page may have answered
      // between this look's outcomes and its progress sample.
      const anyShown = names.some((name) => observations?.[name].visible > 0);
      const quiet = decision === undefined && !anyShown && progress.quietMs() >= noProgressMs;
      if (quiet && !quietBefore) quietBefore = true;
      else if (quiet) {
        const seen = last ?? {};
        const failure = outcomeWaitFailure(
          "outcome_unknown",
          " after " + (Date.now() - begun) + " ms, " + Math.round(noProgressMs) + " ms without progress, no outcome showing: " +
            outcomeWaitSeen(seen) + "; " + progress.describe(),
          seen,
          { progress: progress.diagnostics() },
        );
        finish({ reason: "outcome_unknown" }, failure.message);
        throw failure;
      } else quietBefore = false;
      // Only a first sighting is looked at again at once; anything else waits for the next poll.
      if (settled) await waitSleep(100);
      previous = decision;
    }
  } finally {
    if (key !== undefined)
      await page
        .evaluate((key) => {
          delete globalThis[Symbol.for(key)];
        }, key)
        .catch(() => undefined);
    await progress.stop();
  }
};
`;

/**
 * `waitForRows`, `waitForValues` and `waitForChange`: wait for the values a tool returns to be
 * filled in and to read the same on two looks.
 */
const valueCode = String.raw`
// Runs in the page: reads each element's value, or says it is absent or still loading. A value is
// still loading when it is empty, reads as a loading word or only dots, matches the author's
// placeholder, or sits in an aria-busy, skeleton or shimmer element (up to its row).
const waitReadInPage = (elements, spec) => {
  const loadingWords = /^(?:loading|updating|calculating|fetching|searching|please wait)\b/i;
  const visible = (element) =>
    typeof element.checkVisibility === "function" ? element.checkVisibility()
      : element.getClientRects().length > 0;
  const busy = (element, stop) => {
    for (let node = element, depth = 0; node instanceof Element && depth < 8; node = node.parentElement, depth += 1) {
      if (node.getAttribute("aria-busy") === "true") return true;
      if (/skeleton|shimmer/i.test(node.getAttribute("class") ?? "")) return true;
      if (node === stop) break;
    }
    return false;
  };
  const read = (element, field, stop, identity) => {
    if (!(element instanceof Element)) return { state: "absent" };
    const raw = field.attribute ? element.getAttribute(field.attribute) : visible(element) ? element.innerText : "";
    const value = String(raw ?? "").trim();
    const placeholder = field.placeholder ? new RegExp(field.placeholder.source, field.placeholder.flags) : undefined;
    if (value === "" || loadingWords.test(value) || /^[.…\s]+$/.test(value) || placeholder?.test(value))
      return { state: "loading" };
    if (!identity && busy(element, stop)) return { state: "loading" };
    return { state: "filled", value };
  };
  // How many loading signs show beside a list's rows: in the rows' container or the element around
  // it, or busy on an element around them, but never inside a row. A decoration lives in its card,
  // while a list still loading shows its spinner, skeleton or busy state beside the rows. A class
  // hint that holds rows is their layout, not a sign.
  const listSigns = (rows, selectors) => {
    if (rows.length === 0) return 0;
    let common = rows[0].parentElement;
    while (common !== null && !rows.every((row) => common.contains(row))) common = common.parentElement;
    if (common === null) return 0;
    const outer = common.parentElement;
    const root = outer === null || outer === document.body || outer === document.documentElement ? common : outer;
    let count = 0;
    for (let node = root.parentElement; node !== null; node = node.parentElement)
      if (node.matches(selectors.signs) && visible(node)) count += 1;
    for (const element of [root, ...root.querySelectorAll(selectors.all)])
      if (
        element.matches(selectors.all) &&
        visible(element) &&
        !rows.some((row) => row.contains(element)) &&
        (element.matches(selectors.signs) || !rows.some((row) => element.contains(row)))
      )
        count += 1;
    return count;
  };
  // One look reads the rows and the signs beside them together, so neither is staler.
  if (spec.mode === "rows")
    return { signs: listSigns(elements, spec.signs), rows: elements.map((row) => {
      // A row's field is its first visible match, such as the price a responsive card shows
      // beside a hidden copy. Read text whose matches are all hidden is hidden, not loading: the
      // selector names the wrong copy, or the site shows it only on another layout.
      const at = (field) => {
        if (!field.selector) return row;
        const matches = [...row.querySelectorAll(field.selector)];
        return matches.find(visible) ?? (field.attribute || matches.length === 0 ? matches[0] : "hidden");
      };
      const take = (field, identity) => {
        const element = at(field);
        return element === "hidden" ? { state: "hidden" } : read(element, field, row, identity);
      };
      const fields = {};
      for (const [name, field] of Object.entries(spec.fields)) fields[name] = take(field, false);
      return { key: take(spec.key, true), fields };
    }) };
  const field = spec.field;
  const candidates = field.attribute ? elements : elements.filter(visible);
  if (candidates.length === 0) return { state: "absent" };
  if (field.all) {
    const values = candidates.map((element) => read(element, field, undefined, false));
    return values.some((value) => value.state !== "filled") ? { state: "loading" }
      : { state: "filled", value: values.map((value) => value.value) };
  }
  if (candidates.length > 1) return { state: "ambiguous", count: candidates.length };
  return read(candidates[0], field, undefined, false);
};
// A field as the page code reads it: a CSS selector inside the row (or the row itself), or for
// waitForValues a Playwright locator, with an attribute to read instead of the text.
const waitFieldSpec = (field, where) => {
  const spec = typeof field === "string" ? { selector: field }
    : field !== null && typeof field === "object" && typeof field.evaluateAll === "function" ? { locator: field }
    : field !== null && typeof field === "object" ? field
    : undefined;
  if (spec === undefined) throw new TypeError(where + " needs a selector, a locator or { selector | locator, attribute }");
  const placeholder = spec.placeholder instanceof RegExp
    ? { source: spec.placeholder.source, flags: spec.placeholder.flags.replace("g", "") }
    : undefined;
  return {
    ...(spec.selector === undefined ? {} : { selector: spec.selector }),
    ...(spec.locator === undefined ? {} : { locator: spec.locator }),
    ...(spec.attribute === undefined ? {} : { attribute: spec.attribute }),
    ...(spec.all === true ? { all: true } : {}),
    ...(spec.optional === true ? { optional: true } : {}),
    ...(placeholder === undefined ? {} : { placeholder }),
  };
};
const valueWaitFailure = (reason, message, details) =>
  Object.assign(new Error(reason + message), { name: "ValueWaitFailure", reason, ...details });
const valueWaitRows = (list) =>
  list.length === 0 ? "" : (list.length === 1 ? " in row " : " in rows ") + list.slice(0, 10).join(", ") + (list.length > 10 ? " and " + (list.length - 10) + " more" : "");
// Runs the shared loop for a value wait: look, note progress, return once ready on two agreeing
// looks, fail once quiet or past the cap. evaluate() returns { ready, snapshot, filled, problems,
// result, settleMs }.
const valueWaitLoop = async (wait, options, evaluate, timeoutDefault) => {
  const timeout = options.timeout ?? timeoutDefault;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const progress = waitProgress({ ...options, noProgressMs });
  let looks = 0;
  let begun = Date.now();
  const finish = (fields, summary) =>
    waitRecord({
      wait,
      ...fields,
      elapsedMs: Date.now() - begun,
      looks,
      progress: progress.describe(),
      summary: wait + ": " + summary + "; " + progress.describe(),
    });
  try {
    await options.prepare?.();
    if (options.action !== undefined) {
      await progress.baseline();
      await options.action();
    }
    progress.begin();
    begun = Date.now();
    const until = begun + timeout;
    let candidate;
    let candidateAt = begun;
    let filled = -1;
    let quietBefore = false;
    while (true) {
      let state;
      try {
        state = await evaluate(progress);
      } catch (error) {
        if (!waitContextLost(error)) throw error;
        state = undefined;
      }
      looks += 1;
      const changes = [];
      if (state === undefined) changes.push("page replaced");
      else if (state.signs) changes.push("loading sign");
      else if (candidate !== undefined && state.snapshot !== candidate) {
        changes.push(state.filled > filled ? "values filling" : "values changing");
      }
      await progress.sample(changes);
      const now = Date.now();
      if (state !== undefined) {
        if (state.snapshot !== candidate) {
          candidate = state.snapshot;
          candidateAt = now;
        }
        filled = state.filled;
        // Readiness that depends on progress is judged after this look's sample.
        state.ready = typeof state.ready === "function" ? state.ready() : state.ready;
        if (state.ready && now - candidateAt >= state.settleMs) {
          finish({ outcome: "ready" }, state.summary(now - begun, looks));
          return state.result;
        }
      }
      if (now >= until) {
        const problems = state?.problems ?? "the page was being replaced";
        const failure = valueWaitFailure(
          "values_timeout",
          " after " + Math.round(timeout) + " ms: " + problems + "; " + progress.describe(),
          { progress: progress.diagnostics() },
        );
        finish({ reason: "values_timeout" }, failure.message);
        throw failure;
      }
      // A quiet page fails only when the next look agrees, as in waitForOutcome.
      const quiet = progress.quietMs() >= noProgressMs && !state?.ready;
      if (quiet && !quietBefore) quietBefore = true;
      else if (quiet) {
        const reason = state?.reason ?? "values_loading";
        const failure = valueWaitFailure(
          reason,
          " after " + (now - begun) + " ms, " + Math.round(noProgressMs) + " ms without progress: " +
            (state?.problems ?? "nothing read") + "; " + progress.describe(),
          { progress: progress.diagnostics() },
        );
        finish({ reason }, failure.message);
        throw failure;
      } else quietBefore = false;
      await waitSleep(100);
    }
  } finally {
    await progress.stop();
  }
};
const waitForRows = async (rows, fields, options = {}) => {
  const count = options.count;
  if (!Number.isInteger(count) || count < 1) throw new TypeError("waitForRows needs count, the number of rows you return");
  if (options.key === undefined) throw new TypeError("waitForRows needs key, the field that identifies a row");
  const key = waitFieldSpec(options.key, "waitForRows key");
  const spec = {
    mode: "rows",
    key,
    fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, waitFieldSpec(field, "waitForRows field " + name)])),
  };
  const settle = options.stableMs ?? waitLimits.settle;
  const fewSettle = Math.max(settle, options.unchangedMs ?? waitLimits.unchanged);
  spec.signs = { all: waitLoadingSigns + ", " + waitLoadingClasses, signs: waitLoadingSigns };
  return valueWaitLoop("waitForRows", options, async (progress) => {
    const { rows: read, signs: listSigns } = await rows.evaluateAll(waitReadInPage, spec);
    const identified = read.filter((row) => row.key.state === "filled");
    const hiddenKeys = read.flatMap((row, index) => (row.key.state === "hidden" ? [index + 1] : []));
    const taken = identified.slice(0, count);
    const loading = {};
    const hidden = {};
    const missing = {};
    let filledCount = 0;
    taken.forEach((row, index) => {
      for (const [name, value] of Object.entries(row.fields)) {
        if (value.state === "filled") filledCount += 1;
        else if (value.state === "loading") (loading[name] ??= []).push(index + 1);
        else if (spec.fields[name].optional) continue;
        else if (value.state === "hidden") (hidden[name] ??= []).push(index + 1);
        else (missing[name] ??= []).push(index + 1);
      }
    });
    const problems = [
      ...Object.entries(loading).map(([name, list]) => name + " still loading" + valueWaitRows(list)),
      ...Object.entries(hidden).map(([name, list]) => name + " hidden" + valueWaitRows(list)),
      ...Object.entries(missing).map(([name, list]) => name + " missing" + valueWaitRows(list)),
    ];
    const complete = problems.length === 0;
    const few = taken.length < count;
    if (hiddenKeys.length > 0) problems.push("key hidden" + valueWaitRows(hiddenKeys));
    return {
      // No identified row is never an answer: an empty list is waitForOutcome's to decide. Fewer
      // rows than asked are an answer only once nothing shows the list is still loading.
      ready: () => complete && taken.length > 0 && (!few || (listSigns === 0 && !progress.busy(false))),
      signs: listSigns > 0,
      settleMs: few ? fewSettle : settle,
      filled: taken.length * 1000 + filledCount,
      snapshot: JSON.stringify(taken),
      reason: "values_loading",
      problems:
        identified.length + " identified rows of " + read.length + ", needed " + count +
        (problems.length === 0 ? "" : "; " + problems.join("; ")),
      summary: (elapsed, looks) =>
        taken.length + " of " + count + " rows filled and holding after " + elapsed + " ms (" + looks + " looks)" +
        (few ? ", fewer rows than asked and the count held" : ""),
      result: {
        rows: taken.map((row) => ({
          key: row.key.value,
          ...Object.fromEntries(Object.entries(row.fields).map(([name, value]) => [name, value.state === "filled" ? value.value : null])),
        })),
        more: identified.length > count,
      },
    };
  }, waitLimits.lateFillCap);
};
// Reads each named field once: its value, or that it is absent, ambiguous or still loading.
const valueWaitRead = async (specs) => {
  const read = {};
  for (const [name, spec] of Object.entries(specs))
    read[name] = await spec.locator.evaluateAll(waitReadInPage, { mode: "field", field: { ...spec, locator: undefined } });
  return read;
};
const valueWaitState = (specs, read) => {
  const problems = [];
  let filled = 0;
  let absent = false;
  for (const [name, value] of Object.entries(read)) {
    if (value.state === "filled") filled += 1;
    else if (value.state === "loading") problems.push(name + " still loading");
    else if (value.state === "ambiguous") problems.push(name + " matches " + value.count + " visible elements");
    else if (!specs[name].optional) {
      absent = true;
      problems.push(name + " missing");
    }
  }
  const values = Object.fromEntries(Object.entries(read).map(([name, value]) => [name, value.state === "filled" ? value.value : null]));
  return { problems, filled, absent, values, complete: problems.length === 0 };
};
const valueWaitSpecs = (fields, where) => {
  const specs = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, waitFieldSpec(field, where + " field " + name)]));
  for (const [name, spec] of Object.entries(specs))
    if (spec.locator === undefined) throw new TypeError(where + " field " + name + " needs a Playwright locator");
  if (Object.keys(specs).length === 0) throw new TypeError(where + " needs at least one field");
  return specs;
};
const waitForValues = async (fields, options = {}) => {
  const specs = valueWaitSpecs(fields, "waitForValues");
  const settle = options.stableMs ?? waitLimits.settle;
  return valueWaitLoop("waitForValues", options, async () => {
    const state = valueWaitState(specs, await valueWaitRead(specs));
    return {
      ready: state.complete,
      settleMs: settle,
      filled: state.filled,
      snapshot: JSON.stringify(state.values),
      reason: "values_loading",
      problems: state.problems.join("; "),
      summary: (elapsed, looks) => Object.keys(specs).length + " values filled and holding after " + elapsed + " ms (" + looks + " looks)",
      result: { values: state.values },
    };
  }, waitLimits.lateFillCap);
};
const waitForChange = async (fields, options = {}) => {
  const specs = valueWaitSpecs(fields, "waitForChange");
  if (options.before === undefined && options.action === undefined)
    throw new TypeError("waitForChange needs before (the values from before the choice) or action (the choice itself)");
  let before = options.before;
  if (before !== undefined && (before === null || typeof before !== "object" || Array.isArray(before) ||
      Object.keys(before).sort().join() !== Object.keys(specs).sort().join()))
    throw new TypeError("waitForChange's before must be the values object an earlier wait returned, with the same field names");
  const settle = options.stableMs ?? waitLimits.settle;
  const unchangedMs = options.unchangedMs ?? waitLimits.unchanged;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  return valueWaitLoop("waitForChange", {
    ...options,
    prepare: async () => {
      if (before === undefined) before = valueWaitState(specs, await valueWaitRead(specs)).values;
    },
  }, async (progress) => {
    const state = valueWaitState(specs, await valueWaitRead(specs));
    const changed = JSON.stringify(state.values) !== JSON.stringify(before);
    // The same values count once nothing has shown progress for unchangedMs: a loading sign or
    // request that came after the choice must first go.
    return {
      ready: () => state.complete && (changed || progress.quietMs() >= Math.min(unchangedMs, noProgressMs)),
      settleMs: changed ? settle : 0,
      filled: state.filled,
      snapshot: JSON.stringify(state.values),
      reason: state.absent && state.problems.every((problem) => problem.endsWith(" missing")) ? "change_unknown" : "values_loading",
      problems: state.problems.length > 0 ? state.problems.join("; ") : changed ? "values changed but not yet holding" : "values unchanged",
      summary: (elapsed, looks) =>
        (changed ? "values changed" : "values confirmed unchanged after " + unchangedMs + " ms without progress") +
        ", after " + elapsed + " ms (" + looks + " looks)",
      result: { values: state.values, changed },
    };
  }, waitLimits.answerCap);
};
`;

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it once at the top of the code
 * string, then wait with your verified Playwright locators. It declares four waits that share one
 * set of limits (`waitLimits`, from `timeoutDefaults`) and one progress budget, and `waitReport()`.
 *
 * Every wait returns as soon as its condition holds: a ready page costs one confirming look, and
 * the value waits `settle` (0.5 s) between their two looks. While it waits it watches the page's
 * progress: the site's own loading sign passed as `loading`, for as long as it shows; a generic
 * sign (a busy region, an indeterminate progress bar, a skeleton, shimmer, spinner or loader class,
 * within `region` when named) only while it is new, so decorations never hold a wait; DOM changes
 * inside the `region` you name; one of the site's own document or API requests in flight (beacons,
 * polls and long-open requests aside; pass the context's `siteDomain` to say which hosts are the
 * site's); the URL changing; and the wait's own reads filling or changing. It keeps waiting while progress
 * continues, up to `timeout`, and fails once nothing has progressed for `noProgressMs` (default
 * `answer`, 8 s). A failure is an `Error` with a `reason`, and a message that names the reason, what
 * each outcome or field showed (counts and states, never page text), which progress signs it saw
 * and when progress stopped. `waitReport()` returns one record per wait this call ran, each with a
 * `summary` sentence: return it from a probe to see how each wait ended.
 *
 * `waitForOutcome(outcomes, { action, loading, region, siteDomain, noProgressMs, timeout,
 * unchangedMs }?)` waits for whichever of the page's possible answers appears, after a step whose
 * answer can vary, such as a search, a filter, a date pick or a submit, and returns its key.
 * `outcomes` names one locator per answer, highest priority first, such as `{ refused, failed,
 * unavailable, empty, results }`: when several show at once, the first listed wins, so list a
 * refusal, the site's error or a greyed-out choice before an empty state, and an empty state before
 * results. Each locator names one element, such as the results list rather than its rows. It only
 * observes: about every 100 ms it counts each locator's matches and its visible ones, and never
 * clicks, types or navigates itself. It answers once two looks in a row agree, the second taken at
 * once. `timeout` (default `answerCap`, 30 s) is the hard cap, reached only while the page keeps
 * progressing. `action` is the step itself, such as `() => apply.click()`, which it runs exactly
 * once, after noting what each outcome showed: a match that was visible before it, with the same
 * text, counts only once it has stayed so for `unchangedMs` (default 2000). `timeout`,
 * `noProgressMs` and `unchangedMs` start once the action returns. Its `OutcomeWaitFailure` has
 * `observations` (`OutcomeObservation` by key) and one of these reasons:
 *
 * - `outcome_ambiguous`, when the winning outcome's locator matches more than one element; its
 *   `outcome` is that key. Scope the locator, for example with `.filter({ visible: true })`.
 * - `outcome_unknown`, when no outcome shows and the page made no progress for `noProgressMs`: a
 *   challenge, the site's error or a layout the code does not handle, never slowness.
 * - `outcome_timeout`, when the page was still progressing at `timeout`.
 *
 * `waitForRows(rows, fields, { count, key, ...options })` waits until the first `count` identified
 * rows have every field filled and read the same on two looks `stableMs` apart (default `settle`,
 * 0.5 s), and returns `{ rows: [{ key, ...fields }], more }`. `rows` is a locator for every row;
 * `key` and each field are a CSS selector inside the row, or `{ selector, attribute, optional,
 * placeholder }` (no selector reads the row itself), read from its first visible match; a needed
 * text field whose matches are all hidden is reported `hidden`. A row without a key is a
 * placeholder slot and is skipped. When fewer identified rows than `count` exist, it returns them
 * once their count and values held for `unchangedMs` with no loading sign beside the rows and no
 * request the action started still in flight; no identified row at all
 * is never an answer, so decide an empty list with `waitForOutcome` first. Options also take
 * `action` (run once first, such as a "load more" click), `loading`, `region`, `siteDomain`,
 * `noProgressMs` and `timeout` (default `lateFillCap`, 15 s).
 *
 * `waitForValues(fields, options?)` waits until each named field (a Playwright locator, or
 * `{ locator, attribute, all, optional, placeholder }`) is filled in and the values read the same
 * on two looks, and returns `{ values }`. `all` reads every visible match as a list.
 *
 * `waitForChange(fields, { before, action, ...options })` waits, after a choice, for the values
 * that depend on it: it returns `{ values, changed }` once they differ from `before` (or from what
 * they were before `action` ran) and hold, or once they stayed the same for `unchangedMs` with no
 * progress sign showing, so a loading sign or request the choice started must first go.
 *
 * A value is still loading, never absent, while it is empty, reads as a loading word or only dots,
 * matches the field's `placeholder` pattern, or sits in an `aria-busy`, skeleton or shimmer
 * element. An `optional` field may be absent and is then `null`; a needed one may not. A value
 * still loading when progress stops fails with `values_loading`, whether optional or not;
 * `change_unknown` when waitForChange's fields are missing; `values_timeout` at the cap. Each is a
 * `ValueWaitFailure`.
 */
export const waitCode = `${progressCode}${outcomeCode}${valueCode}`;

/**
 * `waitForOutcome` alone, for code written against the first release of it: it declares only the
 * names that release declared (`waitForOutcome`, `outcomeWaitFailure`, `outcomeWaitNote`,
 * `outcomeWaitChanged` and `outcomeWaitObserve`), keeping every other helper inside, so code that
 * pastes it beside helpers of its own still parses. New code pastes `waitCode` instead; never both.
 */
export const outcomeOnlyWaitCode = `
const { outcomeWaitFailure, outcomeWaitNote, outcomeWaitChanged, outcomeWaitObserve, waitForOutcome } = (() => {
${progressCode}${outcomeCode}
return { outcomeWaitFailure, outcomeWaitNote, outcomeWaitChanged, outcomeWaitObserve, waitForOutcome };
})();
`;
