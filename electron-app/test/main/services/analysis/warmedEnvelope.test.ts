import { describe, expect, it, vi } from "vitest";
import {
  assembleWarmedEnvelope,
  requiredBarsFor,
} from "../../../../src/main/services/analysis/warmedEnvelope";
import { computeResponse } from "../../../fixtures/sidecarFixtures";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

const NOW = new Date("2026-09-17T14:00:00+05:30");
const INSTRUMENT = { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" };

function lakeOf(count: number): CandleWire[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: 1_700_000_000 + i * 300,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1_000 + i,
  }));
}

function depsWith(lake: CandleWire[], algorithms = [{ id: "sma", cost: "fast", required_lookback: 20 }, { id: "kronos", cost: "slow", required_lookback: 256 }]) {
  return {
    kite: { getHistoricalData: vi.fn().mockResolvedValue({ data: { candles: [] } }) },
    sidecar: {
      listAlgorithms: vi.fn().mockResolvedValue({ type: "algorithms", id: 1, algorithms }),
      readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: lake }),
      persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 0 }),
      compute: vi.fn().mockResolvedValue(computeResponse()),
    },
  };
}

describe("requiredBarsFor", () => {
  it("takes the maximum required_lookback across every linked algorithm, fast and slow alike", async () => {
    const sidecar = {
      listAlgorithms: vi.fn().mockResolvedValue({
        type: "algorithms",
        id: 1,
        algorithms: [
          { id: "sma", cost: "fast", required_lookback: 20 },
          { id: "ttm", cost: "slow", required_lookback: 512 },
          { id: "ichimoku", cost: "fast", required_lookback: 52 },
        ],
      }),
    };
    expect(await requiredBarsFor(sidecar as never)).toBe(512);
  });
});

describe("assembleWarmedEnvelope", () => {
  it("sends the lake's trailing required-bars window as candles, not a fresh Kite closes array", async () => {
    const deps = depsWith(lakeOf(400));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    const [symbol, timeframe, horizon, candles] = deps.sidecar.compute.mock.calls[0];
    expect(symbol).toBe("NSE:INFY");
    expect(timeframe).toBe("5minute");
    expect(horizon).toBe("intraday");
    // requiredBars is 256 here, so the trailing 256 of the 400 stored bars.
    expect(candles).toHaveLength(256);
    expect((candles as CandleWire[])[255].ts).toBe(1_700_000_000 + 399 * 300);
    expect((candles as CandleWire[])[0].volume).toBe(1_000 + 144);
  });

  it("sends everything the lake has when it holds fewer bars than required, rather than an empty window", async () => {
    const deps = depsWith(lakeOf(40));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    expect(deps.sidecar.compute.mock.calls[0][3]).toHaveLength(40);
  });

  it("tops up before reading, so a session reopen never computes against a stale lake", async () => {
    const deps = depsWith(lakeOf(400));

    await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "5minute",
      intent_lens: "buying",
      now: NOW,
    });

    expect(deps.kite.getHistoricalData).toHaveBeenCalled();
    const kiteOrder = deps.kite.getHistoricalData.mock.invocationCallOrder[0];
    const computeOrder = deps.sidecar.compute.mock.invocationCallOrder[0];
    expect(kiteOrder).toBeLessThan(computeOrder);
  });

  it("reports the interval as the envelope's timeframe and intraday as its requested horizon", async () => {
    const deps = depsWith(lakeOf(400));

    const envelope = await assembleWarmedEnvelope(deps as never, {
      trigger: "reactive",
      instrument: INSTRUMENT,
      interval: "15minute",
      intent_lens: "selling",
      now: NOW,
    });

    expect(envelope.horizon_requested).toBe("intraday");
    expect(envelope.intent_lens).toBe("selling");
    expect(envelope.instrument.kite_token_asof).toBe("408065");
    expect(envelope.algo_results[0].algo_id).toBe("rsi");
    expect(envelope.overlays).toEqual({});
  });

  it("emits a sidecar error trace and rethrows when compute rejects", async () => {
    const deps = depsWith(lakeOf(400));
    deps.sidecar.compute = vi.fn().mockRejectedValue(new Error("sidecar is not running"));
    const traced: Array<{ source: string; kind: string; detail?: string }> = [];

    await expect(
      assembleWarmedEnvelope(deps as never, {
        trigger: "reactive",
        instrument: INSTRUMENT,
        interval: "5minute",
        intent_lens: "buying",
        now: NOW,
        onTrace: (e) => traced.push(e),
      }),
    ).rejects.toThrow(/sidecar is not running/);
    expect(traced).toEqual([{ source: "sidecar", kind: "error", detail: "sidecar is not running" }]);
  });
});
