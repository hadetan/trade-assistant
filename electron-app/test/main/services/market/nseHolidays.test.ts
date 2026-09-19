import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nse-holiday-cache-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function tempCachePath(name = "cache.json"): string {
  return path.join(tempDir, name);
}

describe("getEffectiveHolidaysForYear", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns an empty array for a year that has never been refreshed or cached", async () => {
    const { getEffectiveHolidaysForYear } = await loadFreshModule();
    expect(getEffectiveHolidaysForYear("2026")).toEqual([]);
    expect(getEffectiveHolidaysForYear("1999")).toEqual([]);
  });
});

describe("isYearCoveredByEffectiveCalendar", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports uncovered for any year before a refresh or cache load has ever populated it", async () => {
    const { isYearCoveredByEffectiveCalendar } = await loadFreshModule();
    expect(isYearCoveredByEffectiveCalendar("2026")).toBe(false);
  });

  it("reports covered for a year populated by a successful refresh", async () => {
    const { refreshNseHolidayCalendar, isYearCoveredByEffectiveCalendar } = await loadFreshModule();
    await refreshNseHolidayCalendar(fakeFetchWithTradingDates(["01-Jan-2031"]) as unknown as typeof fetch, tempCachePath());
    expect(isYearCoveredByEffectiveCalendar("2031")).toBe(true);
  });
});

describe("refreshNseHolidayCalendar", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("populates the effective calendar for a fetched year, leaving a previously-fetched year's data intact", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();

    await refreshNseHolidayCalendar(fakeFetchWithTradingDates(["01-Jan-2025"]) as unknown as typeof fetch, tempCachePath());
    const result = await refreshNseHolidayCalendar(
      fakeFetchWithTradingDates(["01-Jan-2031", "15-Aug-2031"]) as unknown as typeof fetch,
      tempCachePath(),
    );

    expect(result).toBe("refreshed");
    expect(getEffectiveHolidaysForYear("2031")).toEqual(["2031-01-01", "2031-08-15"]);
    expect(getEffectiveHolidaysForYear("2025")).toEqual(["2025-01-01"]);
  });

  it("leaves the effective calendar untouched on a failed fetch", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();

    const result = await refreshNseHolidayCalendar(fakeFailingFetch() as unknown as typeof fetch, tempCachePath());

    expect(result).toBe("fallback");
    expect(getEffectiveHolidaysForYear("2026")).toEqual([]);
    expect(getEffectiveHolidaysForYear("1999")).toEqual([]);
  });

  it("a later successful refresh's data for an already-covered year replaces/extends it", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const SYNTHETIC_DATE = "2026-07-04"; // not a real NSE holiday, chosen only to prove the mechanism

    await refreshNseHolidayCalendar(
      fakeFetchWithTradingDates(["26-Jan-2026"]) as unknown as typeof fetch,
      tempCachePath(),
    );
    expect(getEffectiveHolidaysForYear("2026")).not.toContain(SYNTHETIC_DATE);

    const result = await refreshNseHolidayCalendar(
      fakeFetchWithTradingDates(["26-Jan-2026", "04-Jul-2026"]) as unknown as typeof fetch,
      tempCachePath(),
    );

    expect(result).toBe("refreshed");
    expect(getEffectiveHolidaysForYear("2026")).toContain(SYNTHETIC_DATE);
    expect(getEffectiveHolidaysForYear("2026")).toContain("2026-01-26");
  });

  it("persists the complete resulting override map to the cache file on success", async () => {
    const { refreshNseHolidayCalendar } = await loadFreshModule();
    const cachePath = tempCachePath();

    await refreshNseHolidayCalendar(
      fakeFetchWithTradingDates(["01-Jan-2031", "15-Aug-2031"]) as unknown as typeof fetch,
      cachePath,
    );

    const written = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(written).toEqual({ "2031": ["2031-01-01", "2031-08-15"] });
  });

  it("persists cumulative overrides across multiple successful refreshes, not just the latest fetch's years", async () => {
    const { refreshNseHolidayCalendar } = await loadFreshModule();
    const cachePath = tempCachePath();

    await refreshNseHolidayCalendar(fakeFetchWithTradingDates(["01-Jan-2025"]) as unknown as typeof fetch, cachePath);
    await refreshNseHolidayCalendar(fakeFetchWithTradingDates(["01-Jan-2031"]) as unknown as typeof fetch, cachePath);

    const written = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    expect(written).toEqual({ "2025": ["2025-01-01"], "2031": ["2031-01-01"] });
  });

  it("does not crash and still reports refreshed when the cache write fails", async () => {
    const { refreshNseHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const unwritablePath = path.join(tempDir, "does-not-exist-dir", "cache.json");

    const result = await refreshNseHolidayCalendar(
      fakeFetchWithTradingDates(["01-Jan-2031"]) as unknown as typeof fetch,
      unwritablePath,
    );

    expect(result).toBe("refreshed");
    expect(getEffectiveHolidaysForYear("2031")).toEqual(["2031-01-01"]);
  });
});

describe("loadCachedHolidayCalendar", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("populates the override map from a valid cache file", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const cachePath = tempCachePath();
    fs.writeFileSync(cachePath, JSON.stringify({ "2031": ["2031-01-01", "2031-08-15"] }));

    loadCachedHolidayCalendar(cachePath);

    expect(getEffectiveHolidaysForYear("2031")).toEqual(["2031-01-01", "2031-08-15"]);
  });

  it("leaves the override map empty when the cache file is missing", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();

    expect(() => loadCachedHolidayCalendar(tempCachePath("missing.json"))).not.toThrow();

    expect(getEffectiveHolidaysForYear("2031")).toEqual([]);
  });

  it("leaves the override map empty when the cache file is malformed JSON", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const cachePath = tempCachePath();
    fs.writeFileSync(cachePath, "{not valid json");

    expect(() => loadCachedHolidayCalendar(cachePath)).not.toThrow();

    expect(getEffectiveHolidaysForYear("2031")).toEqual([]);
  });

  it("leaves the override map empty when the cache file is a well-formed JSON array instead of an object", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const cachePath = tempCachePath();
    fs.writeFileSync(cachePath, JSON.stringify(["2031-01-01"]));

    loadCachedHolidayCalendar(cachePath);

    expect(getEffectiveHolidaysForYear("2031")).toEqual([]);
  });

  it("leaves the override map empty when a year's value is not an array of strings", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const cachePath = tempCachePath();
    fs.writeFileSync(cachePath, JSON.stringify({ "2031": "2031-01-01" }));

    loadCachedHolidayCalendar(cachePath);

    expect(getEffectiveHolidaysForYear("2031")).toEqual([]);
  });

  it("leaves the override map empty when a year's array contains non-string entries", async () => {
    const { loadCachedHolidayCalendar, getEffectiveHolidaysForYear } = await loadFreshModule();
    const cachePath = tempCachePath();
    fs.writeFileSync(cachePath, JSON.stringify({ "2031": [1, 2, 3] }));

    loadCachedHolidayCalendar(cachePath);

    expect(getEffectiveHolidaysForYear("2031")).toEqual([]);
  });
});
