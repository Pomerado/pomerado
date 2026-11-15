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

/** Today's date in `timeZone`, `YYYY-MM-DD`. */
export const todayIn = (timeZone: string): string =>
  new Date(wallAt(Date.now(), timeZone)).toISOString().slice(0, 10);

/**
 * The ISO 8601 timestamp of a local date (`YYYY-MM-DD`) and clock time (`HH:MM` or `HH:MM:SS`,
 * 24-hour) in `timeZone`, with that zone's offset on that date: `2026-12-15T07:15:00-08:00`.
 * Across a daylight-saving change, a clock time the change skips moves forward by the change,
 * and one it repeats takes the earlier of the two. An impossible date or time throws `RangeError`.
 */
export const zonedTime = (date: string, time: string, timeZone: string): string => {
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
  const instant = fits.length > 0 ? Math.min(...fits) : wall - (offsets[0] ?? 0);
  const offset = Math.round((wallAt(instant, timeZone) - instant) / 60_000);
  const local = new Date(instant + offset * 60_000).toISOString().slice(0, 19);
  const size = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
};
