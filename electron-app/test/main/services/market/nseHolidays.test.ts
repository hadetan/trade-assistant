import { beforeEach, describe, expect, it, vi } from "vitest";

function cmEntry(tradingDate: string) {
  return {
    tradingDate,
    weekDay: "Thursday",
    description: "Test Holiday",
    morning_session: null,
    evening_session: null,
    Sr_no: 1,
  };
}

function fakeFetchWithTradingDates(tradingDates: string[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ CM: tradingDates.map(cmEntry) }),
  });
}

function fakeFailingFetch() {
  return vi.fn().mockRejectedValue(new Error("network down"));
}

async function loadFreshModule() {
  vi.resetModules();
  return import("../../../../src/main/services/market/nseHolidays");
}

describe("getEffectiveHolidaysForYear", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("falls back to the static calendar for a year with no override", async () => {
    const { getEffectiveHolidaysForYear, NSE_HOLIDAY_CALENDAR } = await loadFreshModule();
    expect(getEffectiveHolidaysForYear("2026")).toEqual(NSE_HOLIDAY_CALENDAR["2026"]);
  });

  it("falls back to an empty array for a year covered by neither the static calendar nor an override", async () => {
    const { getEffectiveHolidaysForYear } = await loadFreshModule();
    expect(getEffectiveHolidaysForYear("1999")).toEqual([]);
  });
});

describe("refreshNseHolidayCalendar", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("replaces the effective calendar for a fetched year, leaving other years' static entries untouched", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear, NSE_HOLIDAY_CALENDAR } = await loadFreshModule();
    const fetchFn = fakeFetchWithTradingDates(["01-Jan-2031", "15-Aug-2031"]);

    const result = await refreshNseHolidayCalendar(fetchFn as unknown as typeof fetch);

    expect(result).toBe("refreshed");
    expect(getEffectiveHolidaysForYear("2031")).toEqual(["2031-01-01", "2031-08-15"]);
    expect(getEffectiveHolidaysForYear("2026")).toEqual(NSE_HOLIDAY_CALENDAR["2026"]);
  });

  it("leaves the effective calendar exactly as the static calendar on a failed fetch", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear, NSE_HOLIDAY_CALENDAR } = await loadFreshModule();
    const fetchFn = fakeFailingFetch();

    const result = await refreshNseHolidayCalendar(fetchFn as unknown as typeof fetch);

    expect(result).toBe("fallback");
    expect(getEffectiveHolidaysForYear("2026")).toEqual(NSE_HOLIDAY_CALENDAR["2026"]);
    expect(getEffectiveHolidaysForYear("1999")).toEqual([]);
  });

  it("closes the real 15-Jan-2026 regression: a successful refresh makes the effective 2026 calendar include a date the static calendar is missing", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear, NSE_HOLIDAY_CALENDAR } = await loadFreshModule();
    expect(NSE_HOLIDAY_CALENDAR["2026"]).not.toContain("2026-01-15");

    const fetchFn = fakeFetchWithTradingDates([
      "15-Jan-2026",
      ...NSE_HOLIDAY_CALENDAR["2026"].map((iso) => {
        const [y, m, d] = iso.split("-");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${d}-${months[Number(m) - 1]}-${y}`;
      }),
    ]);

    const result = await refreshNseHolidayCalendar(fetchFn as unknown as typeof fetch);

    expect(result).toBe("refreshed");
    expect(getEffectiveHolidaysForYear("2026")).toContain("2026-01-15");
  });
});
