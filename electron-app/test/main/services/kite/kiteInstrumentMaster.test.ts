import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiteInstrumentMaster, parseInstrumentCsv } from "../../../../src/main/services/kite/kiteInstrumentMaster";

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-kite-instruments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const SAMPLE_CSV =
  "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" +
  '408065,1594,INFY,"INFOSYS LIMITED",0,,0,0.05,1,EQ,NSE,NSE\n' +
  '779521,3045,TCS,"TATA CONSULTANCY SERVICES, LTD",0,,0,0.05,1,EQ,NSE,NSE\n';

function fakeResponse(overrides: Partial<{ ok: boolean; status: number; text: () => Promise<string> }> = {}) {
  return { ok: true, status: 200, text: async () => SAMPLE_CSV, ...overrides };
}

describe("parseInstrumentCsv", () => {
  it("parses rows and handles a quoted field containing a literal comma", () => {
    const rows = parseInstrumentCsv(SAMPLE_CSV);
    expect(rows).toEqual([
      { instrument_token: "408065", tradingsymbol: "INFY", name: "INFOSYS LIMITED", segment: "NSE", exchange: "NSE" },
      {
        instrument_token: "779521",
        tradingsymbol: "TCS",
        name: "TATA CONSULTANCY SERVICES, LTD",
        segment: "NSE",
        exchange: "NSE",
      },
    ]);
  });

  it("returns an empty array for an empty/header-only CSV", () => {
    expect(parseInstrumentCsv("")).toEqual([]);
    expect(parseInstrumentCsv("instrument_token,tradingsymbol,name,segment,exchange\n")).toEqual([]);
  });
});

describe("KiteInstrumentMaster", () => {
  it("downloads and caches on first search, then searches case-insensitively by symbol or name", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({
      apiKey: "k123",
      accessToken: "at999",
      cacheDir: tempCacheDir(),
      fetchFn,
      now: () => new Date("2026-09-26T05:00:00.000Z"),
    });

    const bySymbol = await master.search("infy");
    expect(bySymbol).toEqual([
      { instrument_token: "408065", tradingsymbol: "INFY", name: "INFOSYS LIMITED", segment: "NSE", exchange: "NSE" },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.kite.trade/instruments",
      { headers: { Authorization: "token k123:at999", "X-Kite-Version": "3" } },
    );

    const byName = await master.search("tata consultancy");
    expect(byName).toHaveLength(1);
    expect(byName[0].tradingsymbol).toBe("TCS");

    // A second search on the same instance must not re-download.
    await master.search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("caps results at 25", async () => {
    const manyRows = Array.from({ length: 40 }, (_, i) => `${i},1,SYM${i},"NAME ${i}",0,,0,0.05,1,EQ,NSE,NSE`).join("\n");
    const csv = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" + manyRows;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => csv });
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    expect(await master.search("sym")).toHaveLength(25);
  });

  it("reuses a same-day on-disk cache across instances without re-downloading", async () => {
    const cacheDir = tempCacheDir();
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const now = () => new Date("2026-09-26T05:00:00.000Z");

    await new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn, now }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // A fresh instance (simulating a new app launch) reads the on-disk cache instead of re-downloading.
    const second = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn, now });
    await second.search("tcs");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-downloads when the on-disk cache is from a prior IST day", async () => {
    const cacheDir = tempCacheDir();
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());

    await new KiteInstrumentMaster({
      apiKey: "k",
      accessToken: "a",
      cacheDir,
      fetchFn,
      now: () => new Date("2026-09-25T05:00:00.000Z"),
    }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await new KiteInstrumentMaster({
      apiKey: "k",
      accessToken: "a",
      cacheDir,
      fetchFn,
      now: () => new Date("2026-09-26T05:00:00.000Z"),
    }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("treats a corrupt on-disk cache file as stale rather than crashing", async () => {
    const cacheDir = tempCacheDir();
    writeFileSync(path.join(cacheDir, "kite-instruments.json"), "not valid json{{{", "utf8");
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn });

    await expect(master.search("infy")).resolves.toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when the download fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    await expect(master.search("infy")).rejects.toThrow(/kite instrument master download failed: HTTP 403/);
  });

  it("returns an empty array for a blank query without downloading", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    expect(await master.search("   ")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
