import { afterEach, describe, expect, it, vi } from "vitest";
import { todayIn, zonedClock, zonedTime } from "../../src/browser/index.js";

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

// A clock time a page shows, such as an estimate's "7:45 PM", as one timestamp in the zone the page
// wrote it in, so a tool never returns a bare clock time.
describe("zonedClock", () => {
  const ms = (iso: string) => Date.parse(iso);

  it("puts the same clock text at different moments in different browser zones", () => {
    const now = ms("2026-11-16T00:30:00Z");
    expect(zonedClock("nearest", "7:45 PM", "America/New_York", now)).toBe("2026-11-15T19:45:00-05:00");
    expect(zonedClock("nearest", "7:45 PM", "America/Los_Angeles", now)).toBe("2026-11-15T19:45:00-08:00");
  });

  it("takes the date the site states", () => {
    expect(zonedClock("2026-12-15", "7:15 AM", "America/Los_Angeles")).toBe("2026-12-15T07:15:00-08:00");
    expect(zonedClock("2026-07-04", "19:30", "Europe/Paris")).toBe("2026-07-04T19:30:00+02:00");
  });

  it("picks the day by the rule when the site states none", () => {
    // 11:50 PM in Los Angeles on Nov 15.
    const lateEvening = ms("2026-11-16T07:50:00Z");
    // An estimate just after midnight is tomorrow's; a late one still reads as today's.
    expect(zonedClock("nearest", "12:38 AM", "America/Los_Angeles", lateEvening)).toBe("2026-11-16T00:38:00-08:00");
    expect(zonedClock("nearest", "11:20 PM", "America/Los_Angeles", lateEvening)).toBe("2026-11-15T23:20:00-08:00");
    // A pickup scheduled for 9 AM is tomorrow's; a delivery made at 6:10 PM was today's.
    expect(zonedClock("next", "9:00 AM", "America/Los_Angeles", lateEvening)).toBe("2026-11-16T09:00:00-08:00");
    expect(zonedClock("last", "6:10 PM", "America/Los_Angeles", lateEvening)).toBe("2026-11-15T18:10:00-08:00");
    // Just after midnight, a delivery made at 11 PM was yesterday's.
    expect(zonedClock("last", "11:00 PM", "America/Los_Angeles", ms("2026-11-16T08:05:00Z"))).toBe(
      "2026-11-15T23:00:00-08:00",
    );
    // A time within a minute of now is now, whichever way the rule looks.
    expect(zonedClock("next", "11:50 PM", "America/Los_Angeles", lateEvening + 30_000)).toBe("2026-11-15T23:50:00-08:00");
    expect(zonedClock("last", "11:51 PM", "America/Los_Angeles", lateEvening + 30_000)).toBe("2026-11-15T23:51:00-08:00");
  });

  it("picks the day by the rule across daylight-saving changes", () => {
    const la = "America/Los_Angeles";
    // Clocks fall back from 2:00 AM PDT to 1:00 AM PST on Nov 1, 2026, so 1:30 AM comes twice.
    expect(zonedClock("next", "1:30 AM", la, ms("2026-11-01T08:10:00Z"))).toBe("2026-11-01T01:30:00-07:00");
    // At 1:10 AM PST, in the repeated hour, the next 1:30 AM is the second one, 20 minutes away.
    expect(zonedClock("next", "1:30 AM", la, ms("2026-11-01T09:10:00Z"))).toBe("2026-11-01T01:30:00-08:00");
    expect(zonedClock("nearest", "1:30 AM", la, ms("2026-11-01T09:25:00Z"))).toBe("2026-11-01T01:30:00-08:00");
    expect(zonedClock("last", "1:30 AM", la, ms("2026-11-01T09:40:00Z"))).toBe("2026-11-01T01:30:00-08:00");
    expect(zonedClock("last", "1:30 AM", la, ms("2026-11-01T09:20:00Z"))).toBe("2026-11-01T01:30:00-07:00");
    // A date the site states takes the earlier one.
    expect(zonedClock("2026-11-01", "1:30 AM", la)).toBe("2026-11-01T01:30:00-07:00");
    // Clocks spring forward from 2:00 AM PST to 3:00 AM PDT on Mar 8, 2026: 2:30 AM moves to 3:30 AM.
    expect(zonedClock("next", "2:30 AM", la, ms("2026-03-08T09:50:00Z"))).toBe("2026-03-08T03:30:00-07:00");
    // At 3:10 AM PDT that moved 2:30 AM is still ahead, so the last one was the day before.
    expect(zonedClock("last", "2:30 AM", la, ms("2026-03-08T10:10:00Z"))).toBe("2026-03-07T02:30:00-08:00");
    // A half-hour change: Lord Howe Island repeats 1:30 to 2:00 AM on Apr 5, 2026.
    expect(zonedClock("next", "1:45 AM", "Australia/Lord_Howe", ms("2026-04-04T15:05:00Z"))).toBe(
      "2026-04-05T01:45:00+10:30",
    );
  });

  it("reads a clock time in the notations sites write", () => {
    const at = (clock: string) => zonedClock("2026-11-15", clock, "UTC").slice(11, 19);
    expect(at("7:45 PM")).toBe("19:45:00");
    expect(at("7:45\u202fPM")).toBe("19:45:00");
    expect(at("7:45pm")).toBe("19:45:00");
    expect(at("7:45 p.m.")).toBe("19:45:00");
    expect(at("7 pm")).toBe("19:00:00");
    expect(at("7.45pm")).toBe("19:45:00");
    expect(at("12:05 AM")).toBe("00:05:00");
    expect(at("12 PM")).toBe("12:00:00");
    expect(at(" 19:45:30 ")).toBe("19:45:30");
    expect(at("07:05")).toBe("07:05:00");
    expect(at("19h45")).toBe("19:45:00");
    expect(at("19 h")).toBe("19:00:00");
    expect(at("0:30")).toBe("00:30:00");
  });

  it("refuses text that is not one clock time, and an unknown zone", () => {
    for (const clock of [
      "",
      "7",
      "7:",
      "7:45 PM ET",
      "7:45 PM EST",
      "Today, 7:45 PM",
      "12:38-12:59 AM",
      "25:00",
      "13:00 PM",
      "0:30 AM",
      "7:60",
      "7:45:60",
    ])
      expect(() => zonedClock("2026-11-15", clock, "America/Los_Angeles"), clock).toThrow(RangeError);
    expect(() => zonedClock("nearest", "7:45 PM", "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => zonedClock("2026-02-30", "7:45 PM", "America/Los_Angeles")).toThrow(RangeError);
  });
});
