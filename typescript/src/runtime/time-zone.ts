/**
 * A site's dates and times in its own time zone, with `Intl` only. A script's clock runs in
 * whatever zone its process or browser has, often UTC or the browsing place's, so "today" and a
 * time's offset come from the site's or the place's IANA zone instead, such as
 * `America/Los_Angeles`. An unknown zone throws the `RangeError` `Intl` raises.
 */

const dayMs = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** The wall clock in `timeZone` at instant `ms`, read as if it were UTC's, to the second. */
const wallAt = (ms: number, timeZone: string) => {
  // `Intl` reads a missing zone as the process's own, which is never the site's.
  if (typeof timeZone !== "string") throw new RangeError("A time zone is an IANA name");
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? Number.NaN;
  // setUTCFullYear, unlike Date.UTC, keeps years 0 to 99 as written.
  const wall = new Date(0);
  wall.setUTCFullYear(part("year"), part("month") - 1, part("day"));
  return wall.setUTCHours(part("hour"), part("minute"), part("second"), 0);
};

/** The date in `timeZone` at instant `ms`, `YYYY-MM-DD`. */
const dateAt = (ms: number, timeZone: string) =>
  new Date(wallAt(ms, timeZone)).toISOString().slice(0, 10);

/** Today's date in `timeZone`, `YYYY-MM-DD`. */
export const todayIn = (timeZone: string): string => dateAt(Date.now(), timeZone);

/** Every instant a valid local date and clock time names, earliest first (see `zonedTime`). */
const instantsOf = (date: string, time: string, timeZone: string): number[] => {
  const written = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(written)
    ? Date.parse(`${written}Z`)
    : Number.NaN;
  if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 19) !== written)
    throw new RangeError("zonedTime takes a real date as YYYY-MM-DD and a time as HH:MM or HH:MM:SS");
  // The zone's offsets a day either side: two when a change falls between them.
  const offsets = [...new Set([wall - dayMs, wall + dayMs].map((ms) => wallAt(ms, timeZone) - ms))];
  const fits = offsets.map((offset) => wall - offset).filter((ms) => wallAt(ms, timeZone) === wall);
  // A skipped time fits neither; the offset before the change moves it forward by the change.
  return fits.length > 0 ? fits.sort((a, b) => a - b) : [wall - (offsets[0] ?? 0)];
};

/** Instant `ms` as an ISO 8601 timestamp with `timeZone`'s offset at that instant. */
const stampAt = (ms: number, timeZone: string) => {
  const offset = Math.round((wallAt(ms, timeZone) - ms) / 60_000);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const size = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
};

/**
 * The ISO 8601 timestamp of a local date (`YYYY-MM-DD`) and clock time (`HH:MM` or `HH:MM:SS`,
 * 24-hour) in `timeZone`, with that zone's offset on that date: `2026-12-15T07:15:00-08:00`.
 * Across a daylight-saving change, a clock time the change skips moves forward by the change,
 * and one it repeats takes the earlier of the two. An impossible date or time throws `RangeError`.
 */
export const zonedTime = (date: string, time: string, timeZone: string): string =>
  stampAt(instantsOf(date, time, timeZone)[0] ?? Number.NaN, timeZone);

/**
 * A clock time as sites write it: `7:45 PM`, `7 pm`, `7:45 p.m.`, `19:45`, `19:45:30`, `19h45`,
 * `19 h` or `7.45pm`. A time with no AM or PM is read on the 24-hour clock and needs its minutes,
 * except in the `19h` notation.
 */
const clockText =
  /^(\d{1,2})(?:\s*([:.hH])\s*(\d{2})?(?:\s*:\s*(\d{2}))?)?\s*(?:([aApP])\.?\s*[mM]\.?)?$/u;

/** `clock` as `HH:MM:SS` on the 24-hour clock, or `RangeError` for anything else. */
const clockOf = (clock: string): string => {
  const parts = clockText.exec(clock.trim());
  const [, hourText = "", separator, minuteText, secondText, meridiem] = parts ?? [];
  const hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  const hNotation = separator !== undefined && /^[hH]$/u.test(separator);
  const valid =
    parts !== null &&
    // `7:` or `7.` names no minute, and neither does a bare hour on the 24-hour clock.
    (minuteText !== undefined || hNotation || (separator === undefined && meridiem !== undefined)) &&
    (secondText === undefined || minuteText !== undefined) &&
    minute < 60 &&
    second < 60 &&
    (meridiem === undefined ? hour < 24 : hour >= 1 && hour <= 12);
  if (!valid)
    throw new RangeError(
      "zonedClock takes one clock time such as 7:45 PM or 19:45, with no date, zone or other text",
    );
  const hours =
    meridiem === undefined ? hour : (hour % 12) + (/^[pP]$/u.test(meridiem) ? 12 : 0);
  return `${pad(hours)}:${pad(minute)}:${pad(second)}`;
};

/** The day after (`days` 1) or before (`days` -1) the date `YYYY-MM-DD`. */
const dayFrom = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);

/** How near `now` a time counts as now: a minute, the precision of most clock times a site shows. */
const nowSlackMs = 60_000;

/**
 * Which day a clock time the site shows is on: the date it states, `YYYY-MM-DD`, or, when it
 * states none, the day that puts the time `next` (at now or later, as for a pickup the site
 * schedules), `last` (at now or earlier, as for a delivery already made) or `nearest` to now (as
 * for an estimate that may already have passed). A time within a minute of now counts as now.
 */
export type ClockDay = `${number}-${number}-${number}` | "next" | "last" | "nearest";

/**
 * The ISO 8601 timestamp, with its zone's offset, of a clock time a site shows in `timeZone`, such
 * as `2026-11-15T19:45:00-08:00` for `7:45 PM` in `America/Los_Angeles`, so a tool never returns a
 * bare clock time. `clock` is one clock time (`7:45 PM`, `19:45`, `19h45`); strip the text around
 * it first, and for a range, use `zonedWindow`. `day` is the date the site states, `YYYY-MM-DD`, or
 * the rule that picks one from yesterday, today and tomorrow in the zone (`ClockDay`). `timeZone`
 * is the zone the site wrote the time in: the zone the page names beside it, or else the browser's
 * own zone, a script context's `browserTimeZone`, since a page writes most times it shows in its
 * browser's zone. `now` is the instant `day`'s rule counts from, by default the current time.
 * Across a daylight-saving change, a time the change skips moves forward by the change; one it
 * repeats takes the earlier of the two on a stated date, while a rule weighs both, so `next` at
 * 1:10 AM in the repeated hour finds the second 1:30 AM. Anything else as `clock`, an impossible
 * date or an unknown zone throws `RangeError`.
 */
export const zonedClock = (
  day: ClockDay,
  clock: string,
  timeZone: string,
  now: number = Date.now(),
): string => {
  const time = clockOf(clock);
  if (day !== "next" && day !== "last" && day !== "nearest") return zonedTime(day, time, timeZone);
  const today = dateAt(now, timeZone);
  // Yesterday's time is before now and tomorrow's after it, so `next` and `last` always find one.
  const candidates = [-1, 0, 1]
    .flatMap((days) => instantsOf(dayFrom(today, days), time, timeZone))
    .map((instant) => ({ instant, from: instant - now }));
  const chosen =
    day === "next"
      ? candidates.find(({ from }) => from > -nowSlackMs)
      : day === "last"
        ? candidates.findLast(({ from }) => from < nowSlackMs)
        : candidates.reduce((best, next) => (Math.abs(next.from) < Math.abs(best.from) ? next : best));
  if (chosen === undefined) throw new RangeError("zonedClock found no day for the clock time");
  return stampAt(chosen.instant, timeZone);
};

/** The AM or PM a clock time writes, as its first letter, or undefined for none. */
const halfOf = (clock: string) => clockText.exec(clock.trim())?.[5];

/** A range end's clock as `HH:MM:SS`: Midnight, Noon, or `clock` with `half` (`am`, `pm`) added. */
const windowClock = (clock: string, half = ""): string => {
  if (/^\s*midnight\s*$/iu.test(clock)) return "00:00:00";
  if (/^\s*noon\s*$/iu.test(clock)) return "12:00:00";
  return clockOf(`${clock.trim()} ${half}`);
};

/** A range's two clocks as `HH:MM:SS`, with an AM or PM written once read as `zonedWindow` says. */
const windowClocks = (start: string, end: string): [string, string] => {
  const [startHalf, endHalf] = [halfOf(start), halfOf(end)];
  const written = startHalf ?? endHalf;
  if (written === undefined || (startHalf !== undefined && endHalf !== undefined))
    return [windowClock(start), windowClock(end)];
  // The clock that wrote none takes `half`; the other keeps its own.
  const read = (half: string): [string, string] =>
    startHalf === undefined
      ? [windowClock(start, half), windowClock(end)]
      : [windowClock(start), windowClock(end, half)];
  const same = read(`${written}m`);
  return same[0] <= same[1] ? same : read(/^[aA]$/u.test(written) ? "pm" : "am");
};

/**
 * The ISO 8601 timestamps, with their zone's offset, of a range a site shows in `timeZone`:
 * `start` on `day` as `zonedClock` reads it, and `end` on the same day, or the next when it is at
 * or before `start`. Each clock takes what `zonedClock` takes, or Midnight or Noon; an AM or PM
 * written once applies to both, unless that puts the start after the end, when the clock that
 * wrote none takes the other.
 */
export const zonedWindow = (
  day: ClockDay,
  start: string,
  end: string,
  timeZone: string,
  now: number = Date.now(),
): { start: string; end: string } => {
  const [first, last] = windowClocks(start, end);
  const from = zonedClock(day, first, timeZone, now);
  // `next` counts a time within a minute of now as now, so from a minute on it finds the first
  // time after `start`, in the same pass of an hour a daylight-saving change repeats.
  const to = zonedClock("next", last, timeZone, Date.parse(from) + nowSlackMs);
  return { start: from, end: to };
};

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then `await browserTimeZone()` returns the IANA zone the page runs in, such as
 * `America/New_York`, the zone the page writes the times it computes in. Pass a frame,
 * `await browserTimeZone(frame)`, to read the zone a frame runs in. Read it in the call that
 * reads the times, and never from the script's own clock: the script runs elsewhere, often in
 * UTC, and the browser's clock follows where it browses from, not the caller's place. A script's
 * context already holds the page's zone as `browserTimeZone`, with no code in the page; this
 * stays for tools written before it.
 *
 * ```js
 * const eta = await visibleText(page.locator(".eta-time"));
 * return { eta, zone: await browserTimeZone() };
 * ```
 */
export const browserTimeZoneCode = `
const browserTimeZone = (target = page) =>
  target.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
`;
