import { describe, expect, it, vi } from "vitest";
import { fetchNseTradingHolidays, parseHolidayMasterResponse } from "../../../../src/main/services/market/nseHolidayFetcher";

function cmEntry(tradingDate: string, srNo = 1) {
  return {
    tradingDate,
    weekDay: "Thursday",
    description: "Test Holiday",
    morning_session: null,
    evening_session: null,
    Sr_no: srNo,
  };
}

function fakeResponse(overrides: Partial<{ ok: boolean; status: number; json: () => Promise<unknown> }> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    ...overrides,
  };
}

describe("parseHolidayMasterResponse", () => {
  it("parses a valid CM array to ISO dates", () => {
    const json = {
      CM: [cmEntry("15-Jan-2026", 1), cmEntry("26-Jan-2026", 2), cmEntry("25-Dec-2026", 3)],
    };
    expect(parseHolidayMasterResponse(json)).toEqual(["2026-01-15", "2026-01-26", "2026-12-25"]);
  });

  it("returns null when the CM key is missing", () => {
    expect(parseHolidayMasterResponse({ FO: [cmEntry("26-Jan-2026")] })).toBeNull();
  });

  it("returns null (not a partial list) when any entry's tradingDate is malformed", () => {
    const json = { CM: [cmEntry("26-Jan-2026", 1), cmEntry("not-a-date", 2)] };
    expect(parseHolidayMasterResponse(json)).toBeNull();
  });

  it("returns null when tradingDate names an impossible calendar date", () => {
    const json = { CM: [cmEntry("31-Feb-2026", 1)] };
    expect(parseHolidayMasterResponse(json)).toBeNull();
  });

  it.each([null, undefined, "a string", 42, ["array"]])("returns null for non-object input %p", (input) => {
    expect(parseHolidayMasterResponse(input)).toBeNull();
  });

  it("returns null when CM is present but not an array", () => {
    expect(parseHolidayMasterResponse({ CM: "not-an-array" })).toBeNull();
  });
});

describe("fetchNseTradingHolidays", () => {
  it("returns the parsed list on a successful response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({
        json: async () => ({ CM: [cmEntry("26-Jan-2026", 1)] }),
      }),
    );

    const result = await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(result).toEqual(["2026-01-26"]);
  });

  it("requests the real holiday-master URL with browser-like headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({
        json: async () => ({ CM: [cmEntry("26-Jan-2026", 1)] }),
      }),
    );

    await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe("https://www.nseindia.com/api/holiday-master?type=trading");
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
    expect(headers.Accept).toBe("application/json");
  });

  it("returns null on a non-2xx response status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 503 }));

    const result = await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(result).toBeNull();
  });

  it("returns null when the fetch throws a network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(result).toBeNull();
  });

  it("returns null when response.json() throws (malformed body)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    );

    const result = await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(result).toBeNull();
  });

  it("returns null when the parsed response has an unusable shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ json: async () => ({ FO: [] }) }));

    const result = await fetchNseTradingHolidays(fetchFn as unknown as typeof fetch);

    expect(result).toBeNull();
  });
});
