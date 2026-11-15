import { afterEach, describe, expect, it, vi } from "vitest";
import { todayIn, zonedTime } from "../../src/browser/index.js";

afterEach(() => {
  vi.useRealTimers();
});

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

// A site's "today" is its own zone's date, which UTC's date can be a day ahead of or behind.
describe("todayIn", () => {
  it("gives today's date in the zone, not in UTC", () => {
    at("2026-11-15T02:51:41Z");
    expect(todayIn("America/Los_Angeles")).toBe("2026-11-14");
    expect(todayIn("Pacific/Honolulu")).toBe("2026-11-14");
    expect(todayIn("UTC")).toBe("2026-11-15");
    expect(todayIn("Asia/Tokyo")).toBe("2026-11-15");
  });

  it("follows the zone's daylight-saving offset on each side of a change", () => {
    // 00:30 PDT on the day after clocks went forward; a standard-time offset reads 23:30 the day before.
    at("2026-03-09T07:30:00Z");
    expect(todayIn("America/Los_Angeles")).toBe("2026-03-09");
    // 23:30 PST on the day clocks went back; a daylight-time offset reads 00:30 the day after.
    at("2026-11-02T07:30:00Z");
    expect(todayIn("America/Los_Angeles")).toBe("2026-11-01");
  });

  it("refuses a zone the runtime does not know", () => {
    expect(() => todayIn("Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

// A site's local date and clock time as one ISO 8601 timestamp with that zone's offset on that day.
describe("zonedTime", () => {
  it("gives the timestamp with the zone's offset on that date", () => {
    expect(zonedTime("2026-12-15", "07:15", "America/Los_Angeles")).toBe("2026-12-15T07:15:00-08:00");
    expect(zonedTime("2026-07-04", "19:30", "America/New_York")).toBe("2026-07-04T19:30:00-04:00");
    expect(zonedTime("2026-11-14", "20:21:41", "Asia/Kolkata")).toBe("2026-11-14T20:21:41+05:30");
    expect(zonedTime("2026-11-14", "20:36", "Asia/Kathmandu")).toBe("2026-11-14T20:36:00+05:45");
    expect(zonedTime("2026-11-15", "02:51:41", "UTC")).toBe("2026-11-15T02:51:41+00:00");
    expect(zonedTime("2026-11-14", "00:00", "America/Los_Angeles")).toBe("2026-11-14T00:00:00-08:00");
    expect(zonedTime("0001-01-01", "00:00", "UTC")).toBe("0001-01-01T00:00:00+00:00");
    expect(Date.parse(zonedTime("2026-11-14", "18:51:41", "America/Los_Angeles"))).toBe(
      Date.parse("2026-11-15T02:51:41Z"),
    );
  });

  it("takes each day's own offset across daylight-saving changes, in both hemispheres", () => {
    expect(zonedTime("2026-03-07", "09:00", "America/Los_Angeles")).toBe("2026-03-07T09:00:00-08:00");
    expect(zonedTime("2026-03-08", "09:00", "America/Los_Angeles")).toBe("2026-03-08T09:00:00-07:00");
    expect(zonedTime("2026-10-31", "09:00", "America/Los_Angeles")).toBe("2026-10-31T09:00:00-07:00");
    expect(zonedTime("2026-11-01", "09:00", "America/Los_Angeles")).toBe("2026-11-01T09:00:00-08:00");
    expect(zonedTime("2026-01-15", "10:00", "Australia/Sydney")).toBe("2026-01-15T10:00:00+11:00");
    expect(zonedTime("2026-07-15", "10:00", "Australia/Sydney")).toBe("2026-07-15T10:00:00+10:00");
  });

  it("moves a clock time the change skips forward, and takes the earlier of one it repeats", () => {
    expect(zonedTime("2026-03-08", "02:30", "America/Los_Angeles")).toBe("2026-03-08T03:30:00-07:00");
    expect(zonedTime("2026-11-01", "01:30", "America/Los_Angeles")).toBe("2026-11-01T01:30:00-07:00");
    expect(zonedTime("2026-10-04", "02:30", "Australia/Sydney")).toBe("2026-10-04T03:30:00+11:00");
    expect(zonedTime("2026-04-05", "02:30", "Australia/Sydney")).toBe("2026-04-05T02:30:00+11:00");
  });

  it("refuses an impossible date or time, a time not written HH:MM[:SS], and an unknown zone", () => {
    for (const [date, time] of [
      ["2026-02-30", "10:00"],
      ["2026-11-14", "24:00"],
      ["2026-11-14", "10:60"],
      ["2026-11-14", "7:15 PM"],
      ["Nov 14, 2026", "10:00"],
    ] as const)
      expect(() => zonedTime(date, time, "America/Los_Angeles")).toThrow(RangeError);
    expect(() => zonedTime("2026-11-14", "10:00", "Mars/Olympus_Mons")).toThrow(RangeError);
  });
});
