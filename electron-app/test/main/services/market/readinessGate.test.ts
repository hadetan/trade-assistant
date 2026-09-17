import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEngineOnlyReadiness } from "../../../../src/main/services/market/readinessGate";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const IN_SESSION = new Date("2026-09-17T11:00:00+05:30"); // Thursday, mid-session
const PRE_OPEN = new Date("2026-09-17T08:00:00+05:30");
const POST_CLOSE = new Date("2026-09-17T16:00:00+05:30");
const WEEKEND = new Date("2026-09-19T11:00:00+05:30"); // Saturday
const HOLIDAY = new Date("2026-01-26T11:00:00+05:30"); // Republic Day, a Monday

const PARAMS = { symbol: "NSE:INFY", instrumentToken: "408065", interval: "5minute" as const, now: IN_SESSION };

function lakeOf(count: number): CandleWire[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: 1_700_000_000 + i * 300,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

function deps(overrides: { status?: "authenticated" | "needsLogin" | "unknown"; lake?: CandleWire[] } = {}) {
  const lake = overrides.lake ?? lakeOf(300);
  return {
    kiteStatus: vi.fn(() => overrides.status ?? "authenticated"),
    kite: { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: [] } }) },
    sidecar: {
      listAlgorithms: vi.fn().mockResolvedValue({
        type: "algorithms",
        id: 1,
        algorithms: [{ id: "kronos", cost: "slow", required_lookback: 256 }],
      }),
      readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: lake }),
      persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 0 }),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("checkEngineOnlyReadiness", () => {
  it("passes all three checks silently when Kite is up, the lake is warm, and the session is live", async () => {
    expect(await checkEngineOnlyReadiness(deps() as never, PARAMS)).toEqual({ ok: true });
  });

  it("fails with kite_not_connected and short-circuits before data or time are evaluated", async () => {
    const d = deps({ status: "needsLogin" });

    expect(await checkEngineOnlyReadiness(d as never, PARAMS)).toEqual({ ok: false, reason: "kite_not_connected" });
    expect(d.sidecar.readLakeCandles).not.toHaveBeenCalled();
    expect(d.sidecar.listAlgorithms).not.toHaveBeenCalled();
    expect(d.kite.getHistoricalData).not.toHaveBeenCalled();
  });

  it("treats an unknown Kite session as not connected", async () => {
    expect(await checkEngineOnlyReadiness(deps({ status: "unknown" }) as never, PARAMS)).toEqual({
      ok: false,
      reason: "kite_not_connected",
    });
  });

  it("fails with insufficient_history carrying exact have/need counts, and never reaches the market-hours check", async () => {
    // Deliberately in-session, so a market_closed answer would prove the order wrong.
    const result = await checkEngineOnlyReadiness(deps({ lake: lakeOf(180) }) as never, PARAMS);
    expect(result).toEqual({ ok: false, reason: "insufficient_history", have: 180, need: 256 });
  });

  it("fails with market_closed and the next open before the market opens", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: PRE_OPEN });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-17T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed after the close, pointing at the next trading day", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: POST_CLOSE });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-18T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed on a weekend, pointing at Monday", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: WEEKEND });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-09-21T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("fails with market_closed on a bundled-calendar holiday", async () => {
    const result = await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: HOLIDAY });
    expect(result).toEqual({
      ok: false,
      reason: "market_closed",
      nextOpenAt: new Date("2026-01-27T09:15:00+05:30").getTime() / 1000,
    });
  });

  it("warns once about a year the bundled holiday calendar does not cover instead of silently trusting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await checkEngineOnlyReadiness(deps() as never, { ...PARAMS, now: new Date("2030-06-18T11:00:00+05:30") });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2030"));
  });
});
