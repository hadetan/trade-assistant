import { describe, expect, it } from "vitest";
import {
  isHolidayCalendarCovered,
  isTradingDay,
  isWithinSessionHours,
  nextSessionOpen,
} from "../../../../src/main/services/market/tradingCalendar";

// Every fixture is an explicit IST instant. Nothing here reads the wall clock.
function ist(isoWithoutZone: string): Date {
  return new Date(`${isoWithoutZone}+05:30`);
}

describe("isHolidayCalendarCovered", () => {
  it("reports 2026 covered and a year the bundled calendar has never seen uncovered", () => {
    expect(isHolidayCalendarCovered(2026)).toBe(true);
    expect(isHolidayCalendarCovered(1999)).toBe(false);
  });
});

describe("isTradingDay", () => {
  it("accepts an ordinary midweek session day", () => {
    expect(isTradingDay(ist("2026-09-17T11:00:00"))).toBe(true); // Thursday
  });

  it("rejects Saturday and Sunday", () => {
    expect(isTradingDay(ist("2026-09-19T11:00:00"))).toBe(false); // Saturday
    expect(isTradingDay(ist("2026-09-20T11:00:00"))).toBe(false); // Sunday
  });

  it("rejects a bundled-calendar holiday that falls on a weekday", () => {
    // Republic Day, a fixed-date statutory holiday NSE observes every year.
    expect(isTradingDay(ist("2026-01-26T11:00:00"))).toBe(false); // Monday
    // Gandhi Jayanti, likewise fixed-date.
    expect(isTradingDay(ist("2026-10-02T11:00:00"))).toBe(false); // Friday
  });

  it("degrades to weekends-only for a year the calendar does not cover, instead of throwing", () => {
    expect(isTradingDay(ist("1999-06-15T11:00:00"))).toBe(true); // Tuesday
    expect(isTradingDay(ist("1999-06-19T11:00:00"))).toBe(false); // Saturday
  });

  it("classifies by the IST calendar date, not the host's local one", () => {
    // 2026-09-19T02:00 IST is still 2026-09-18 20:30 UTC -- a UTC-based check
    // would call this Friday (a trading day); in IST it is Saturday.
    expect(isTradingDay(ist("2026-09-19T02:00:00"))).toBe(false);
  });
});

describe("isWithinSessionHours", () => {
  it("is true at the open, inside the session, and at the close", () => {
    expect(isWithinSessionHours(ist("2026-09-17T09:15:00"))).toBe(true);
    expect(isWithinSessionHours(ist("2026-09-17T14:00:00"))).toBe(true);
    expect(isWithinSessionHours(ist("2026-09-17T15:30:00"))).toBe(true);
  });

  it("is false pre-open and post-close", () => {
    expect(isWithinSessionHours(ist("2026-09-17T09:14:59"))).toBe(false);
    expect(isWithinSessionHours(ist("2026-09-17T15:30:01"))).toBe(false);
  });

  it("is false all day on a non-trading day, even at an in-session clock time", () => {
    expect(isWithinSessionHours(ist("2026-09-19T11:00:00"))).toBe(false); // Saturday
    expect(isWithinSessionHours(ist("2026-01-26T11:00:00"))).toBe(false); // Republic Day
  });
});

describe("nextSessionOpen", () => {
  it("returns today's open when called before it on a trading day", () => {
    expect(nextSessionOpen(ist("2026-09-17T07:00:00"))).toBe(ist("2026-09-17T09:15:00").getTime() / 1000);
  });

  it("rolls to the next trading day when called after the close", () => {
    expect(nextSessionOpen(ist("2026-09-17T16:00:00"))).toBe(ist("2026-09-18T09:15:00").getTime() / 1000);
  });

  it("skips the weekend from a Friday evening", () => {
    expect(nextSessionOpen(ist("2026-09-18T16:00:00"))).toBe(ist("2026-09-21T09:15:00").getTime() / 1000);
  });

  it("skips a holiday that falls on the next weekday", () => {
    // 2026-10-01 is a Thursday; 2026-10-02 (Gandhi Jayanti, Friday) is closed,
    // so the next open after Thursday's close is Monday 2026-10-05.
    expect(nextSessionOpen(ist("2026-10-01T16:00:00"))).toBe(ist("2026-10-05T09:15:00").getTime() / 1000);
  });

  it("returns the current session's own open while the session is live, so the gate never reports a session in progress as closed", () => {
    expect(nextSessionOpen(ist("2026-09-17T11:00:00"))).toBe(ist("2026-09-17T09:15:00").getTime() / 1000);
  });

  it("rolls to tomorrow's open, not today's already-passed one, anywhere inside the 15:30:00-15:30:59 close minute", () => {
    // isWithinSessionHours already says 15:30:30 is past the close (second-level
    // precision); this must agree instead of truncating to the 930-minute mark.
    expect(isWithinSessionHours(ist("2026-09-17T15:30:30"))).toBe(false);
    expect(nextSessionOpen(ist("2026-09-17T15:30:30"))).toBe(ist("2026-09-18T09:15:00").getTime() / 1000);
  });
});
