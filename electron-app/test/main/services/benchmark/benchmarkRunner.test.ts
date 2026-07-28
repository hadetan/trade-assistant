import { describe, expect, it, vi } from "vitest";
import {
  classifyDecision,
  defaultCadenceForHorizon,
  defaultLookaheadForHorizon,
  horizonForTimeframe,
  runBenchmark,
  summarize,
  NEUTRAL_BAND,
} from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { BenchmarkRunnerDeps, DecisionPoint } from "../../../../src/main/services/benchmark/benchmarkRunner";
import type { CandleWire, ConfluenceWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

function point(outcome: DecisionPoint["outcome"]): DecisionPoint {
  return {
    frontierIndex: 0,
    ts: 0,
    closeAtFrontier: 1,
    closeAtLookahead: 1,
    realizedReturn: 0,
    direction: "bullish",
    conviction: "low",
    responseText: "",
    algoResults: [],
    confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
    outcome,
  };
}

describe("horizon / cadence / lookahead derivation", () => {
  it("derives positional only for the day timeframe, intraday for everything else", () => {
    expect(horizonForTimeframe("day")).toBe("positional");
    expect(horizonForTimeframe("minute")).toBe("intraday");
    expect(horizonForTimeframe("5minute")).toBe("intraday");
    expect(horizonForTimeframe("15minute")).toBe("intraday");
  });

  it("binds cadence to horizon", () => {
    expect(defaultCadenceForHorizon("positional")).toEqual({ mode: "session_close" });
    expect(defaultCadenceForHorizon("intraday")).toEqual({ mode: "stateless_gate" });
  });

  it("binds lookahead defaults to horizon", () => {
    expect(defaultLookaheadForHorizon("positional")).toBe(5);
    expect(defaultLookaheadForHorizon("intraday")).toBe(30);
  });
});

describe("classifyDecision (TS mirror of algo_core::benchmark_classify)", () => {
  it("scores a directional call by the sign of the realized return", () => {
    expect(classifyDecision("bullish", 0.05)).toBe("correct");
    expect(classifyDecision("bullish", -0.05)).toBe("incorrect");
    expect(classifyDecision("bearish", -0.05)).toBe("correct");
  });

  it("scores a neutral call neutral regardless of magnitude", () => {
    expect(classifyDecision("neutral", 0.42)).toBe("neutral");
    expect(classifyDecision("neutral", -0.42)).toBe("neutral");
  });

  it("scores a within-band or band-edge directional call neutral (inclusive)", () => {
    expect(classifyDecision("bullish", 0.0005)).toBe("neutral");
    expect(classifyDecision("bullish", NEUTRAL_BAND)).toBe("neutral");
  });
});

describe("summarize", () => {
  it("counts each outcome and excludes neutral from the hit-rate", () => {
    const result = summarize([point("correct"), point("correct"), point("incorrect"), point("neutral")]);
    expect(result).toEqual({ correct: 2, incorrect: 1, neutral: 1, hitRate: 2 / 3 });
  });

  it("returns a null hit-rate when there are zero directional outcomes", () => {
    expect(summarize([]).hitRate).toBeNull();
    expect(summarize([point("neutral"), point("neutral")]).hitRate).toBeNull();
  });
});

const BULLISH: ConfluenceWire = { bullish_count: 8, bearish_count: 1, neutral_count: 1, weighted_vote: 0.5 };

function seriesOf(closes: number[]): CandleWire[] {
  return closes.map((close, i) => ({ ts: 1_000 + i, open: close, high: close, low: close, close, volume: 100 }));
}

function baseParams(overrides: Partial<import("../../../../src/main/services/benchmark/benchmarkRunner").BenchmarkRunParams> = {}) {
  return {
    symbol: "NSE:INFY",
    timeframe: "day",
    source: "bhavcopy",
    horizon: "positional" as const,
    cadence: { mode: "session_close" as const },
    lookaheadBars: 1,
    fromTs: 0,
    toTs: 1e12,
    ...overrides,
  };
}

describe("runBenchmark frontier walk", () => {
  it("positional session_close produces one decision point per eligible bar", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }));
    // N=8, L=3, break when i+3>=8 -> i in 0..4 -> 5 decision points.
    expect(result.decisionPoints).toHaveLength(5);
    expect(benchmarkCompute).toHaveBeenCalledTimes(5);
  });

  it("intraday stateless_gate cadence is gate-driven and threads prev/curr", async () => {
    const closes = [10, 11, 12, 13, 14, 15]; // N=6, L=2 -> eligible i in 0..3
    const perFrontier: ConfluenceWire[] = closes.map((_, i) => ({ bullish_count: i, bearish_count: 0, neutral_count: 1, weighted_vote: 0.5 }));
    const decisions = ["WorthLook", "NoChange", "WorthAiCall", "NoChange"];
    let gateCall = 0;
    const gateArgs: Array<{ prev: ConfluenceWire | null; curr: ConfluenceWire }> = [];
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf(closes) }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
        evaluateScanGateStateless: vi.fn().mockImplementation((prev: ConfluenceWire | null, curr: ConfluenceWire) => {
          gateArgs.push({ prev, curr });
          return Promise.resolve({ type: "scan_gate", id: 1, decision: decisions[gateCall++] });
        }),
      },
    };
    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", cadence: { mode: "stateless_gate" }, lookaheadBars: 2 }));
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 2]);
    expect(gateArgs[0].prev).toBeNull();
    expect(gateArgs[1].prev).toEqual(gateArgs[0].curr);
    expect(gateArgs[2].prev).toEqual(gateArgs[1].curr);
  });

  it("manual everyN stride produces decision points only at every Nth index", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ cadence: { mode: "manual", everyN: 3 }, lookaheadBars: 2 }));
    // N=10, L=2 -> eligible i in 0..7; every 3rd -> i in {0,3,6}.
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 3, 6]);
    expect(benchmarkCompute).toHaveBeenCalledTimes(3);
  });

  it("skips a zero/negative frontier close without a marker but keeps walking", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, -5, 13, 14, 15]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 2 }));
    // N=6, L=2 -> eligible i in 0..3; i=2 has close -5 -> skipped.
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 1, 3]);
    expect(result.candles).toHaveLength(6); // the glitch candle still renders on the chart
  });

  it("stops at the lookahead boundary with no out-of-range read", async () => {
    const benchmarkCompute = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 5 }));
    expect(result.decisionPoints).toHaveLength(0);
    expect(benchmarkCompute).not.toHaveBeenCalled();
  });

  it("wires classification exactly against the realized future close", async () => {
    async function outcomeFor(closes: number[]): Promise<string> {
      const deps: BenchmarkRunnerDeps = {
        sidecar: {
          readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf(closes) }),
          benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
          evaluateScanGateStateless: vi.fn(),
        },
      };
      const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
      return result.decisionPoints[0].outcome;
    }
    expect(await outcomeFor([100, 110])).toBe("correct"); // bullish + +10% future move
    expect(await outcomeFor([100, 90])).toBe("incorrect"); // bullish + -10%
    expect(await outcomeFor([100, 100.05])).toBe("neutral"); // +0.05% within band
  });

  it("preserves partial results on a mid-run sidecar rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const benchmarkCompute = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 3) return Promise.reject(new Error("sidecar request 3 timed out"));
      return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
    expect(result.decisionPoints).toHaveLength(2); // the first two frontiers survived
    consoleError.mockRestore();
  });
});
