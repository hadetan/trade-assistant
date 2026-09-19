import { describe, expect, it, vi } from "vitest";
import {
  assembleWarmedEnvelope,
  requiredBarsFor,
} from "../../../../src/main/services/analysis/warmedEnvelope";
import { computeResponse } from "../../../fixtures/sidecarFixtures";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

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

function depsWith(compute = vi.fn().mockResolvedValue(computeResponse())) {
  return { sidecar: { compute } };
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
  it("sends the warmed data's trailing required-bars window as candles, not the full lake", async () => {
    const deps = depsWith();

    await assembleWarmedEnvelope(
      deps as never,
      { trigger: "reactive", instrument: INSTRUMENT, interval: "5minute", intent_lens: "buying" },
      { candles: lakeOf(400), requiredBars: 256 },
    );

    const [symbol, timeframe, horizon, candles] = deps.sidecar.compute.mock.calls[0];
    expect(symbol).toBe("NSE:INFY");
    expect(timeframe).toBe("5minute");
    expect(horizon).toBe("intraday");
    expect(candles).toHaveLength(256);
    expect((candles as CandleWire[])[255].ts).toBe(1_700_000_000 + 399 * 300);
    expect((candles as CandleWire[])[0].volume).toBe(1_000 + 144);
  });

  it("sends everything the warmed data has when it holds fewer bars than required, rather than an empty window", async () => {
    const deps = depsWith();

    await assembleWarmedEnvelope(
      deps as never,
      { trigger: "reactive", instrument: INSTRUMENT, interval: "5minute", intent_lens: "buying" },
      { candles: lakeOf(40), requiredBars: 256 },
    );

    expect(deps.sidecar.compute.mock.calls[0][3]).toHaveLength(40);
  });

  it("never re-fetches or re-reads the lake -- it only ever calls sidecar.compute", async () => {
    const deps = depsWith();

    await assembleWarmedEnvelope(
      deps as never,
      { trigger: "reactive", instrument: INSTRUMENT, interval: "5minute", intent_lens: "buying" },
      { candles: lakeOf(400), requiredBars: 256 },
    );

    expect(Object.keys(deps.sidecar)).toEqual(["compute"]);
  });

  it("reports the interval as the envelope's timeframe and intraday as its requested horizon", async () => {
    const deps = depsWith();

    const envelope = await assembleWarmedEnvelope(
      deps as never,
      { trigger: "reactive", instrument: INSTRUMENT, interval: "15minute", intent_lens: "selling" },
      { candles: lakeOf(400), requiredBars: 256 },
    );

    expect(envelope.horizon_requested).toBe("intraday");
    expect(envelope.intent_lens).toBe("selling");
    expect(envelope.instrument.kite_token_asof).toBe("408065");
    expect(envelope.algo_results[0].algo_id).toBe("rsi");
    expect(envelope.overlays).toEqual({});
  });

  it("emits a sidecar error trace and rethrows when compute rejects", async () => {
    const deps = depsWith(vi.fn().mockRejectedValue(new Error("sidecar is not running")));
    const traced: Array<{ source: string; kind: string; detail?: string }> = [];

    await expect(
      assembleWarmedEnvelope(
        deps as never,
        {
          trigger: "reactive",
          instrument: INSTRUMENT,
          interval: "5minute",
          intent_lens: "buying",
          onTrace: (e) => traced.push(e),
        },
        { candles: lakeOf(400), requiredBars: 256 },
      ),
    ).rejects.toThrow(/sidecar is not running/);
    expect(traced).toEqual([{ source: "sidecar", kind: "error", detail: "sidecar is not running" }]);
  });
});
