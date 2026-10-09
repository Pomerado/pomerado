import type { KernelExecuteClient } from "../runtime/kernel-execute-client.js";

/** A point in pixels. */
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** A point on a pointer path, reached `atMs` after the path starts. */
export interface TimedPoint extends PointerPoint {
  readonly atMs: number;
}

/** A source of uniform numbers in [0, 1), such as `Math.random` or `seededRandom(seed)`. */
export type PointerRandom = () => number;

/**
 * The ranges a person-like click keeps to, in milliseconds: the move's length, the time between
 * two path points, the pause on the target before the press and how long the button stays down.
 */
export const pointerTiming = {
  pathMs: [180, 650],
  stepMs: [12, 20],
  pauseMs: [80, 260],
  pressMs: [55, 140],
} as const;

/**
 * A deterministic `PointerRandom` for tests and replays (mulberry32). The same seed gives the same
 * sequence.
 */
export function seededRandom(seed: number): PointerRandom {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A person-like pointer path from `from` to `to`: one cubic Bezier bowed to a random side by 8 to
 * 15 % of the distance (at most 80 px), travelled with minimum-jerk easing, so it starts and ends
 * slowly. Its length follows the distance as Fitts's law does, 180 to 650 ms, with a point every 12
 * to 20 ms. Every point but the last moves by up to 1 px of jitter on each axis; the last is `to`
 * exactly. Both control points lie between the ends along the line, so the path never passes the
 * target and comes back: it has no overshoot loop. A move under 2 px is the target alone.
 *
 * The path starts after `from`, which is where the pointer already is. Self-contained, so page code
 * embeds it with `Function.prototype.toString`.
 */
export function humanPointerPath(
  from: PointerPoint,
  to: PointerPoint,
  random: PointerRandom,
): readonly TimedPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [{ x: to.x, y: to.y, atMs: 0 }];
  const fitts = 180 + 120 * Math.log2(1 + distance / 40);
  const durationMs = Math.min(650, Math.max(180, fitts * (0.85 + 0.3 * random())));
  const stepMs = 12 + 8 * random();
  const steps = Math.max(2, Math.round(durationMs / stepMs));
  const side = random() < 0.5 ? -1 : 1;
  const bow = Math.min(80, distance * (0.08 + 0.07 * random())) * side;
  const normal = { x: -dy / distance, y: dx / distance };
  const control = (along: number) => {
    const reach = bow * (0.6 + 0.4 * random());
    return { x: from.x + dx * along + normal.x * reach, y: from.y + dy * along + normal.y * reach };
  };
  const first = control(0.3);
  const second = control(0.7);
  const points: TimedPoint[] = [];
  for (let step = 1; step <= steps; step++) {
    const time = step / steps;
    const eased = time * time * time * (10 - 15 * time + 6 * time * time);
    const rest = 1 - eased;
    const along = (start: number, one: number, two: number, end: number) =>
      rest * rest * rest * start +
      3 * rest * rest * eased * one +
      3 * rest * eased * eased * two +
      eased * eased * eased * end;
    const last = step === steps;
    points.push({
      x: last ? to.x : along(from.x, first.x, second.x, to.x) + (random() * 2 - 1),
      y: last ? to.y : along(from.y, first.y, second.y, to.y) + (random() * 2 - 1),
      atMs: Math.round(durationMs * time),
    });
  }
  return points;
}

/**
 * Where in a box to click, as fractions of its width and height from its centre: within the
 * middle half, and at least 5 % off the centre on each axis, so never the exact centre.
 */
export function pointerTarget(random: PointerRandom): PointerPoint {
  const offset = () => (random() < 0.5 ? -1 : 1) * (0.05 + 0.2 * random());
  return { x: offset(), y: offset() };
}

/**
 * The pause on the target before the press, 80 to 260 ms and skewed short (`80 + 180·u²`), and
 * how long the button stays down, 55 to 140 ms.
 */
export function clickTiming(random: PointerRandom): {
  readonly pauseMs: number;
  readonly pressMs: number;
} {
  const pause = random();
  return {
    pauseMs: Math.round(80 + 180 * pause * pause),
    pressMs: Math.round(55 + 85 * random()),
  };
}

/** Why a click stayed Playwright's own, as the counts in `humanClickStatsPath` name it. */
export const humanClickFallbacks = [
  "unavailable",
  "no_events",
  "held",
  "hidden",
  "covered",
  "scaled",
  "missed",
  "failed",
] as const;
export type HumanClickFallback = (typeof humanClickFallbacks)[number];

/**
 * The files the page code and a host share on the browser's machine:
 * - `hold`: a host writes it before its own use of the mouse, such as a press and hold, and
 *   deletes it after; a click finds it there, written less than 30 s ago, and stays Playwright's;
 * - `click`: the page code writes it while it moves and presses, and deletes it after, for a host
 *   to wait on, for at most 5 s after it was written;
 * - `stats`: the executor's running counts, `{ real, fallback: { [reason]: count } }`.
 */
export const humanClickPaths = {
  hold: "/tmp/pomerado-pointer-hold",
  click: "/tmp/pomerado-pointer-click",
  stats: "/tmp/pomerado-pointer-stats.json",
} as const;

export interface HumanClickOptions {
  /**
   * The browser machine's own input service. By default the page code finds it from the
   * executor's environment (Kernel's image service on its `PORT`); a host without it gets
   * Playwright's click.
   */
  readonly endpoint?: string;
  /** A seed for every random choice, for tests; `Math.random` otherwise. */
  readonly seed?: number;
  /** How long a move may go unanswered by the page's own `mousemove`; 300 ms by default. */
  readonly eventWaitMs?: number;
}

/**
 * Page code for a hosted Kernel call, where `page` is in scope: it makes every plain left click
 * in this executor process a real one, from the operating system's pointer, with a person's
 * movement and timing. Kernel's executor runs in the browser's own machine, beside the input
 * service Kernel's computer API calls, and reaches it on localhost without a key.
 *
 * It wraps Playwright's frame click, which `locator.click`, `page.click` and `frame.click` all
 * use, once per executor process; running it again does nothing. A click with any option but
 * `timeout`, `strict`, `noWaitAfter`, a left `button`, one `clickCount`, or `force` and `trial`
 * left false stays Playwright's. For a plain click it:
 * 1. runs Playwright's own checks with `trial: true` (attached, visible, stable, enabled, not
 *    covered at its centre, scrolled into view), so a click that would time out still does, with
 *    Playwright's error;
 * 2. picks a point in the element's middle half, never its centre, and checks the element is what
 *    that point hits and that its page is the visible tab;
 * 3. moves the pointer there on `humanPointerPath`, as steps of one batched call, and waits for the
 *    page's own trusted `mousemove`, which places the viewport on the screen exactly (the window's
 *    metrics can be tens of pixels off); a miss moves again once from where it landed;
 * 4. checks again what the pointer's point hits, then pauses, presses and releases in one batched
 *    call with `clickTiming`.
 *
 * Installing it never fails the call it starts. Its listeners live in Patchright's isolated
 * world, which page scripts never see. Anything that
 * fails before the press, or a service, page or tab that cannot take real input (a headless
 * browser, which moves no page pointer, or a host without the service), leaves the click
 * Playwright's, and the reason is counted in `humanClickPaths.stats`; a service that showed no
 * page event is not tried again for 5 minutes. A press that fails once the button may have gone
 * down throws, since the click may have happened and is never repeated. A host's hold file keeps
 * the pointer for the host, so the click stays Playwright's then.
 */
export const humanClickCode = (options: HumanClickOptions = {}) => `await (async () => {
// Installing never fails the call it starts: a click then stays Playwright's.
try {
const options = ${JSON.stringify(options)};
const state = (globalThis.__pomeradoHumanClick ??= { origins: new WeakMap(), stats: { real: 0, fallback: {} } });
const frameClass = Object.getPrototypeOf(page.mainFrame());
if (state.patched !== undefined && frameClass.click === state.patched) return;
state.original ??= frameClass.click;
const original = state.original;
${seededRandom.toString()}
${humanPointerPath.toString()}
${pointerTarget.toString()}
${clickTiming.toString()}
const random = options.seed === undefined ? Math.random : seededRandom(options.seed);
const paths = ${JSON.stringify(humanClickPaths)};
const eventWaitMs = options.eventWaitMs ?? 300;
const endpoint = () => {
  if (options.endpoint !== undefined) return options.endpoint;
  const env = typeof process === "object" ? process.env : {};
  return env.WITH_KERNEL_IMAGES_API === "true" && /^[0-9]{1,5}$/.test(env.PORT ?? "")
    ? "http://127.0.0.1:" + env.PORT
    : undefined;
};
const call = async (base, path, init, limitMs) => {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(limitMs) });
  if (!response.ok && response.status !== 404) throw new Error("Input service answered " + response.status);
  return response;
};
const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const batch = (base, actions) => {
  const sleeps = actions.reduce((sum, action) => sum + (action.sleep?.duration_ms ?? 0), 0);
  return call(base, "/computer/batch", json({ actions }), sleeps + 5000);
};
const recent = async (base, path, withinMs) => {
  const response = await call(base, "/fs/file_info?path=" + encodeURIComponent(path), { method: "GET" }, 2000);
  if (response.status === 404) return false;
  const info = await response.json();
  return Date.now() - Date.parse(info.mod_time) < withinMs;
};
const save = (base) =>
  call(base, "/fs/write_file?path=" + encodeURIComponent(paths.stats), { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: JSON.stringify(state.stats) }, 2000).catch(() => undefined);
const count = async (base, reason) => {
  if (reason === undefined) state.stats.real += 1;
  else state.stats.fallback[reason] = (state.stats.fallback[reason] ?? 0) + 1;
  if (base !== undefined) await save(base);
};
const moves = (path, startMs = 0) => {
  const actions = [];
  let at = startMs;
  for (const point of path) {
    // Each step takes the service about 13 ms itself.
    const wait = point.atMs - at - 13;
    if (wait > 0) actions.push({ type: "sleep", sleep: { duration_ms: Math.round(wait) } });
    actions.push({ type: "move_mouse", move_mouse: { x: Math.round(point.x), y: Math.round(point.y), smooth: false } });
    at = Math.max(point.atMs, at + 13);
  }
  return actions;
};
// The element's own document's last trusted mousemove, through a listener in this world.
const watch = (locator) => locator.evaluate((element) => {
  const doc = element.ownerDocument;
  const tracker = (globalThis.__pomeradoPointer ??= { seq: 0, last: null, docs: new WeakSet() });
  if (!tracker.docs.has(doc)) {
    tracker.docs.add(doc);
    doc.addEventListener("mousemove", (event) => {
      if (!event.isTrusted) return;
      tracker.seq += 1;
      tracker.last = { x: event.clientX, y: event.clientY, seq: tracker.seq };
    }, { capture: true, passive: true });
  }
  return tracker.last === null ? 0 : tracker.last.seq;
});
const lastMove = async (locator, after) => {
  const until = Date.now() + eventWaitMs;
  for (;;) {
    const last = await locator.evaluate(() => globalThis.__pomeradoPointer?.last ?? null);
    if (last !== null && last.seq > after) return last;
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
// Whether the element is what its own document's point hits, in that document's coordinates.
const hits = (locator, point) => locator.evaluate((element, at) => {
  const root = element.getRootNode();
  const scope = typeof root.elementFromPoint === "function" ? root : element.ownerDocument;
  const found = scope.elementFromPoint(at.x, at.y);
  return found !== null && (found === element || element.contains(found));
}, point);
const real = async (frame, selector, clickOptions) => {
  const base = endpoint();
  if (base === undefined) return { reason: "unavailable" };
  if (state.downUntil !== undefined && Date.now() < state.downUntil) return { base, reason: "unavailable" };
  if (await recent(base, paths.hold, 30000)) return { base, reason: "held" };
  const locator = frame.locator(selector);
  await locator.click({ ...(clickOptions.timeout === undefined ? {} : { timeout: clickOptions.timeout }), trial: true });
  const offset = pointerTarget(random);
  const aim = await locator.evaluate((element, fraction) => {
    const doc = element.ownerDocument;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width * (0.5 + fraction.x);
    const y = rect.top + rect.height * (0.5 + fraction.y);
    const root = element.getRootNode();
    const scope = typeof root.elementFromPoint === "function" ? root : doc;
    const found = scope.elementFromPoint(x, y);
    const top = window.top === window ? window : null;
    return {
      visible: doc.visibilityState === "visible",
      hit: found !== null && (found === element || element.contains(found)),
      x, y, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      ratio: window.devicePixelRatio,
      metrics: top === null ? null : { screenX: top.screenX, screenY: top.screenY, chromeX: (top.outerWidth - top.innerWidth) / 2, chromeY: top.outerHeight - top.innerHeight },
    };
  }, offset);
  if (!aim.visible) return { base, reason: "hidden" };
  if (!aim.hit) return { base, reason: "covered" };
  if (aim.ratio !== 1) return { base, reason: "scaled" };
  const box = await locator.boundingBox();
  if (box === null || !(aim.width > 0) || !(aim.height > 0)) return { base, reason: "covered" };
  // The element's document maps to the top viewport by its box, through any frames above it.
  const scaleX = box.width / aim.width;
  const scaleY = box.height / aim.height;
  const toTop = (point) => ({ x: box.x + (point.x - aim.left) * scaleX, y: box.y + (point.y - aim.top) * scaleY });
  const point = toTop(aim);
  const tab = frame.page();
  const origin = state.origins.get(tab) ?? (aim.metrics === null
    ? { x: 0, y: 0 }
    : { x: aim.metrics.screenX + aim.metrics.chromeX, y: aim.metrics.screenY + aim.metrics.chromeY });
  const screen = (at) => ({ x: Math.round(at.x + point.x), y: Math.round(at.y + point.y) });
  const position = await (await call(base, "/computer/get_mouse_position", json({}), 2000)).json();
  const seq = await watch(locator);
  let commanded = screen(origin);
  await batch(base, moves(humanPointerPath(position, commanded, random)));
  let seen = await lastMove(locator, seq);
  if (seen === null) {
    state.downUntil = Date.now() + 300000;
    return { base, reason: "no_events" };
  }
  let landed = toTop(seen);
  if (Math.abs(landed.x - point.x) > 1.5 || Math.abs(landed.y - point.y) > 1.5) {
    // Where the commanded point really landed: the viewport sits that much off the estimate.
    const corrected = { x: origin.x + point.x - landed.x, y: origin.y + point.y - landed.y };
    const from = commanded;
    commanded = screen(corrected);
    await batch(base, moves(humanPointerPath(from, commanded, random)));
    seen = await lastMove(locator, seen.seq);
    if (seen === null) return { base, reason: "missed" };
    landed = toTop(seen);
    if (Math.abs(landed.x - point.x) > 1.5 || Math.abs(landed.y - point.y) > 1.5) return { base, reason: "missed" };
    state.origins.set(tab, corrected);
  } else state.origins.set(tab, origin);
  if (!(await hits(locator, seen))) return { base, reason: "covered" };
  const arrived = Date.now();
  if (await recent(base, paths.hold, 30000)) return { base, reason: "held" };
  const { pauseMs, pressMs } = clickTiming(random);
  await call(base, "/fs/write_file?path=" + encodeURIComponent(paths.click), { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "click" }, 2000).catch(() => undefined);
  const at = { x: commanded.x, y: commanded.y, button: "left" };
  try {
    await batch(base, [
      { type: "sleep", sleep: { duration_ms: Math.max(0, pauseMs - (Date.now() - arrived)) } },
      { type: "click_mouse", click_mouse: { ...at, click_type: "down" } },
      { type: "sleep", sleep: { duration_ms: pressMs } },
      { type: "click_mouse", click_mouse: { ...at, click_type: "up" } },
    ]);
  } catch (error) {
    await batch(base, [{ type: "click_mouse", click_mouse: { ...at, click_type: "up" } }]).catch(() => undefined);
    await count(base, "failed");
    throw new Error("The real click may have happened: its press failed", { cause: error });
  } finally {
    await call(base, "/fs/delete_file", { ...json({ path: paths.click }), method: "PUT" }, 2000).catch(() => undefined);
  }
  return { base };
};
const plain = (clickOptions) => Object.entries(clickOptions ?? {}).every(([key, value]) =>
  value === undefined ||
  ["timeout", "strict", "noWaitAfter"].includes(key) ||
  (key === "button" && value === "left") ||
  (key === "clickCount" && value === 1) ||
  ((key === "force" || key === "trial") && value === false));
state.patched = async function (selector, clickOptions = {}) {
  if (!plain(clickOptions)) return original.call(this, selector, clickOptions);
  let outcome;
  try {
    outcome = await real(this, selector, clickOptions);
  } catch (error) {
    // Playwright's own checks fail as its click would; a press that may have happened throws.
    if (error?.name === "TimeoutError" || /real click may have happened/.test(error?.message ?? "")) throw error;
    outcome = { base: endpoint(), reason: "failed" };
  }
  await count(outcome.base, outcome.reason);
  if (outcome.reason === undefined) return;
  return original.call(this, selector, clickOptions);
};
frameClass.click = state.patched;
} catch {}
})();
`;

/**
 * A Kernel client whose every call starts with `humanClickCode`, so a hosted script's plain left
 * clicks are real ones. A host without Kernel's input service, the local host included, leaves
 * its client as it is.
 */
export const withHumanClicks = (
  client: KernelExecuteClient,
  options: HumanClickOptions = {},
): KernelExecuteClient => {
  const prefix = humanClickCode(options);
  return {
    browsers: {
      playwright: {
        execute: (sessionId, body, requestOptions) =>
          client.browsers.playwright.execute(
            sessionId,
            { ...body, code: prefix + body.code },
            requestOptions,
          ),
      },
    },
  };
};
