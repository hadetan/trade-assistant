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
const DAY_SECONDS = 86_400;

function backfillOk(have = 10_000, need = 0) {
  return vi
    .fn()
    .mockResolvedValue({ type: "day_backfill", id: 1, have, need, sufficient: true, archive_exhausted: false });
}

function seriesOf(closes: number[]): CandleWire[] {
  return closes.map((close, i) => ({ ts: 1_000 + i, open: close, high: close, low: close, close, volume: 100 }));
}

function baseParams(overrides: Partial<import("../../../../src/main/services/benchmark/benchmarkRunner").BenchmarkRunParams> = {}) {
  return {
    symbol: "NSE:INFY",
    timeframe: "day",
    source: "bhavcopy",
    horizon: "positional" as const,
    algoId: "sma",
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
        ensureDayBackfill: backfillOk(),
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
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf(closes) }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[], _algoId: string) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
        evaluateScanGateStateless: vi.fn().mockImplementation((prev: ConfluenceWire | null, curr: ConfluenceWire) => {
          gateArgs.push({ prev, curr });
          return Promise.resolve({ type: "scan_gate", id: 1, decision: decisions[gateCall++] });
        }),
      },
    };
    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", lookaheadBars: 2 }));
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 2]);
    expect(gateArgs[0].prev).toBeNull();
    expect(gateArgs[1].prev).toEqual(gateArgs[0].curr);
    expect(gateArgs[2].prev).toEqual(gateArgs[1].curr);
  });

  it("skips a zero/negative frontier close without a marker but keeps walking", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, -5, 13, 14, 15]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 2 }));
    // N=6, L=2 -> eligible i in 0..3; i=2 has close -5 -> skipped.
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([0, 1, 3]);
    // Bounded past the LAST decision point's (frontierIndex 3) own lookahead
    // window (3+2+1=6), which here reaches the full 6-bar series -- the
    // glitch candle at index 2 still renders on the chart within that bound.
    expect(result.candles).toHaveLength(6);
    expect(result.candles[2].close).toBe(-5);
  });

  it("stops at the lookahead boundary with no out-of-range read", async () => {
    const benchmarkCompute = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
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
          ensureDayBackfill: backfillOk(),
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
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
    expect(result.decisionPoints).toHaveLength(2); // the first two frontiers survived
    expect(result.cancelled).toBe(false);
    consoleError.mockRestore();
  });

  it("propagates an initial readLakeCandles rejection instead of resolving empty", async () => {
    const benchmarkCompute = vi.fn();
    const evaluateScanGateStateless = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockRejectedValue(new Error("lake read failed")),
        benchmarkCompute,
        evaluateScanGateStateless,
      },
    };
    await expect(runBenchmark(deps, baseParams())).rejects.toThrow("lake read failed");
    expect(benchmarkCompute).not.toHaveBeenCalled();
    expect(evaluateScanGateStateless).not.toHaveBeenCalled();
  });

  it("invokes onProgress once per surviving loop iteration with the correct (index, total) pairs", async () => {
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 3 }), (p) => progress.push([p.phase, p.index, p.total]));
    // N=8, L=3 -> eligible i in 0..4 (5 iterations), each reported against that same
    // eligible-frontier count (toTs is unbounded here, so the lookahead bound wins).
    expect(progress).toEqual([
      ["run", 0, 5],
      ["run", 1, 5],
      ["run", 2, 5],
      ["run", 3, 5],
      ["run", 4, 5],
    ]);
    expect(result.decisionPoints).toHaveLength(5);
  });

  it("bounds onProgress's total to the eligible window, not the entire remaining lake series", async () => {
    // A day-timeframe lake entry's selected window is one day, but `series` (built
    // from `fromTs` with no upper bound) can carry many more trading days behind
    // it -- onProgress must not report that whole tail as "total work" when only
    // one frontier actually falls inside the window.
    const dayStart = 1_700_000_000;
    const toTs = dayStart + DAY_SECONDS;
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const candles: CandleWire[] = closes.map((close, i) => ({
      ts: dayStart + i * DAY_SECONDS,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    }));
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];
    await runBenchmark(deps, baseParams({ timeframe: "day", fromTs: dayStart, toTs, lookaheadBars: 2 }), (p) =>
      progress.push([p.phase, p.index, p.total]),
    );
    expect(progress).toEqual([["run", 0, 1]]);
  });

  it("computes a window-start frontier against the lake history BEFORE fromTs, not a truncated window", async () => {
    // 40 bars of lake history, but only the last 3 fall inside the selected
    // window. Before this fix the first frontier saw 1 bar and every algorithm
    // with a real required_lookback was silently dropped by run_applicable.
    const dayStart = 1_700_000_000;
    const candles: CandleWire[] = Array.from({ length: 40 }, (_, i) => ({
      ts: dayStart + i * DAY_SECONDS,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    const fromTs = candles[37].ts;
    const windows: number[] = [];
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) => {
          windows.push(window.length);
          return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
        }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ fromTs, toTs: 1e12, lookaheadBars: 1 }));
    // Frontiers 37 and 38 are eligible (39 has no bar at i+1); each is handed
    // everything up to and including itself, reaching back before fromTs.
    expect(windows).toEqual([38, 39]);
    // The chart still shows only the selected window: firstFrontier (37)
    // through the LAST decision point's (38) own lookahead bar (39), i.e. 3
    // bars -- not the whole unbounded tail of `series` used above for
    // lookback context.
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0].ts).toBe(fromTs);
  });

  it("reports progress from zero at the window's first frontier, not from its lake index", async () => {
    const dayStart = 1_700_000_000;
    const candles: CandleWire[] = Array.from({ length: 40 }, (_, i) => ({
      ts: dayStart + i * DAY_SECONDS,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];
    await runBenchmark(deps, baseParams({ fromTs: candles[37].ts, toTs: 1e12, lookaheadBars: 1 }), (p) =>
      progress.push([p.phase, p.index, p.total]),
    );
    expect(progress).toEqual([
      ["run", 0, 2],
      ["run", 1, 2],
    ]);
  });

  it("day-timeframe single-day window still scores an outcome using bars beyond toTs for lookahead", async () => {
    // A day-timeframe lake entry has exactly one candle per selected day, so
    // scoring its outcome needs `lookaheadBars` MORE candles after the window
    // -- if `series` were bounded above by `toTs`, this would always produce
    // zero decision points for every day-timeframe run.
    const dayStart = 1_700_000_000;
    const toTs = dayStart + 86_400;
    const closes = [100, 101, 102, 103, 104, 105, 106]; // the selected day + 6 more trading days after it
    const candles: CandleWire[] = closes.map((close, i) => ({
      ts: dayStart + i * 86_400,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    }));
    const benchmarkCompute = vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ timeframe: "day", fromTs: dayStart, toTs, lookaheadBars: 5 }));
    expect(result.decisionPoints.length).toBeGreaterThanOrEqual(1);
  });

  it("tags cancelled=true and keeps only the pre-cancellation decision points on a cancellation-tagged rejection", async () => {
    let call = 0;
    const benchmarkCompute = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 3) return Promise.reject(Object.assign(new Error("sidecar run cancelled"), { cancelled: true }));
      return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
    });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13, 14, 15, 16, 17]) }),
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const result = await runBenchmark(deps, baseParams({ lookaheadBars: 1 }));
    expect(result.cancelled).toBe(true);
    expect(result.decisionPoints).toHaveLength(2);
  });

  it("returns an insufficientHistory result and never computes when the symbol's real history falls short", async () => {
    const benchmarkCompute = vi.fn();
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 8,
          need: 256,
          sufficient: false,
          archive_exhausted: false,
        }),
        readLakeCandles,
        benchmarkCompute,
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 8, need: 256, reason: "symbol_history" });
    expect(result.decisionPoints).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(result.cancelled).toBe(false);
    // Nothing downstream of the pre-flight runs -- not even the lake read.
    expect(readLakeCandles).not.toHaveBeenCalled();
    expect(benchmarkCompute).not.toHaveBeenCalled();
  });

  it("sizes the pre-flight against the one selected algorithm and leaves a sufficient run untouched", async () => {
    const ensureDayBackfill = backfillOk(400);
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos", lookaheadBars: 1, fromTs: 1_000 }));

    expect(ensureDayBackfill).toHaveBeenCalledTimes(1);
    expect(ensureDayBackfill.mock.calls[0][0]).toBe("NSE:INFY");
    expect(ensureDayBackfill.mock.calls[0][1]).toBe("kronos");
    // This run's own selected day and scoring window, not defaults: the sidecar
    // sizes against the bars surrounding that one day and cannot infer either.
    expect(ensureDayBackfill.mock.calls[0][2]).toBe(1_000);
    expect(ensureDayBackfill.mock.calls[0][3]).toBe(1);
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("skips the pre-flight entirely for a non-day timeframe, which has no bhavcopy source", async () => {
    const ensureDayBackfill = backfillOk();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    await runBenchmark(deps, baseParams({ timeframe: "minute", source: "kaggle", horizon: "positional", lookaheadBars: 1 }));

    expect(ensureDayBackfill).not.toHaveBeenCalled();
  });

  it("skips the pre-flight for a day entry that is not bhavcopy-sourced, so it cannot verdict the wrong partition", async () => {
    // The live warm-up path writes ("day", "kite") partitions
    // (candleWarmup.ts's WARMUP_SOURCE, historicalDataArchive.ts's `day`
    // lookback hint) and they appear in the same picker. Backfilling would
    // check ("day", "bhavcopy") while the run reads ("day", "kite") --
    // wasted fetches at best, a bogus insufficient-history verdict at worst.
    const ensureDayBackfill = backfillOk();
    const readLakeCandles = vi
      .fn()
      .mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12, 13]) });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles,
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ timeframe: "day", source: "kite", lookaheadBars: 1 }));

    expect(ensureDayBackfill).not.toHaveBeenCalled();
    // And the run is otherwise exactly what it was before this phase.
    expect(readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "day", "kite");
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints).toHaveLength(3);
  });

  it("reports an exhausted archive as its own reason instead of blaming the symbol's history", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 41,
          need: 256,
          sufficient: false,
          archive_exhausted: true,
        }),
        readLakeCandles: vi.fn(),
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos" }));

    expect(result.insufficientHistory).toEqual({ have: 41, need: 256, reason: "archive_unreachable" });
    expect(result.cancelled).toBe(false);
  });

  it("reports backfill progress as its own phase before the frontier walk's", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockImplementation((_symbol: string, _algoId: string, _fromTs: number, _lookahead: number, onDay?: (i: number, t: number) => void) => {
          onDay?.(1, 2);
          onDay?.(2, 2);
          return Promise.resolve({ type: "day_backfill", id: 1, have: 2, need: 2, sufficient: true, archive_exhausted: false });
        }),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: seriesOf([10, 11, 12]) }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };
    const progress: Array<[string, number, number]> = [];

    await runBenchmark(deps, baseParams({ lookaheadBars: 1 }), (p) => progress.push([p.phase, p.index, p.total]));

    // N=3, L=1 -> eligible frontiers i in {0, 1}.
    expect(progress).toEqual([
      ["backfill", 1, 2],
      ["backfill", 2, 2],
      ["run", 0, 2],
      ["run", 1, 2],
    ]);
  });

  it("a thin lake backfilled around the UI's default selected day yields a real decision point for THAT day", async () => {
    // The bug this guards, in the shape a real invocation has: the Benchmark UI
    // tests exactly ONE candle (fromTs = the start of the selected day, toTs one
    // day later) and defaults that day to the entry's EARLIEST bar. A backfill
    // sized so that *some* frontier somewhere in the series is usable is not
    // enough -- the one the UI selects has to be the usable one. Here the lake
    // started with 8 bars and the walk added the 19 older ones the earliest of
    // those 8 was missing, so that bar itself carries a full lookback.
    const lookback = 20;
    const lookahead = 5;
    const originalBars = 8;
    const backfilled = lookback - 1; // the earliest original bar already counts as one
    const total = backfilled + originalBars; // 27
    // Production encoding, exactly: each day's candle is stamped at that day's
    // 15:30 IST close (10:00 UTC), while the UI sends the day's UTC MIDNIGHT as
    // `fromTs`. A fixture that collapses the two hides the off-by-one this test
    // exists to pin.
    const firstDayStart = Date.UTC(2023, 10, 13) / 1000;
    const SESSION_CLOSE_OFFSET = 36_000;
    const candles: CandleWire[] = Array.from({ length: total }, (_, i) => ({
      ts: firstDayStart + i * DAY_SECONDS + SESSION_CLOSE_OFFSET,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    // The UI's default: the earliest bar the entry had before the backfill.
    // Every backfilled bar is strictly older, so it sits at index `backfilled`.
    const selectedIndex = backfilled;
    const fromTs = firstDayStart + selectedIndex * DAY_SECONDS;
    const toTs = fromTs + DAY_SECONDS;
    expect(candles[selectedIndex].ts).toBe(fromTs + SESSION_CLOSE_OFFSET);
    // Both gates, for the ONE frontier the loop will actually reach:
    expect(candles.slice(0, selectedIndex + 1)).toHaveLength(lookback); // leading context
    expect(selectedIndex + lookahead).toBeLessThan(total); // a real bar to score against
    const windows: number[] = [];
    const ensureDayBackfill = vi.fn().mockResolvedValue({
      type: "day_backfill",
      id: 1,
      // What the real Rust handler answers for this exact lake, recomputed
      // against the frontier-boundary split: with to_ts = fromTs + 86400,
      // leading = 20 bars ending with the selected day's own (capped at the
      // lookback) and trailing = 7 bars after it (capped at the lookahead), so
      // have = 20 + 5 = need and sufficient holds.
      have: lookback + lookahead,
      need: lookback + lookahead,
      sufficient: true,
      archive_exhausted: false,
    });
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill,
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) => {
          windows.push(window.length);
          return Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH });
        }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ algoId: "kronos", fromTs, toTs, lookaheadBars: lookahead }));

    // The selected day is what the sidecar was sized against.
    expect(ensureDayBackfill.mock.calls[0][2]).toBe(fromTs);
    expect(result.insufficientHistory).toBeUndefined();
    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([selectedIndex]);
    expect(result.decisionPoints[0].ts).toBe(candles[selectedIndex].ts);
    // One compute, over a window that is exactly the algorithm's lookback.
    expect(windows).toEqual([lookback]);
  });

  it("tags a cancellation during the pre-flight as cancelled rather than throwing", async () => {
    const readLakeCandles = vi.fn();
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("sidecar run cancelled"), { cancelled: true })),
        readLakeCandles,
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams());

    expect(result.cancelled).toBe(true);
    expect(result.insufficientHistory).toBeUndefined();
    expect(readLakeCandles).not.toHaveBeenCalled();
  });

  it("surfaces a backfill that failed outright as an error instead of a misleading history banner", async () => {
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: vi.fn().mockResolvedValue({
          type: "day_backfill",
          id: 1,
          have: 40,
          need: 256,
          sufficient: false,
          archive_exhausted: false,
          error: "fetch error: HTTP 503 for https://nsearchives.nseindia.com/x.zip",
        }),
        readLakeCandles: vi.fn(),
        benchmarkCompute: vi.fn(),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    await expect(runBenchmark(deps, baseParams())).rejects.toThrow(/HTTP 503/);
  });

  it("bounds result.candles past the LAST decision point's lookahead, not just the first, for a multi-decision-point stateless_gate run", async () => {
    // A single intraday day-window can pack several stateless-gate decision
    // points (unlike a day-timeframe run, which always has exactly one). The
    // chart keys its markers by ts against `result.candles`, so bounding only
    // past the FIRST decision point's lookahead silently drops every later
    // one's marker and tested-candle highlight (they'd have no ts match at
    // all) even though decisionPoints itself reports them correctly.
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]; // N=10, L=2 -> eligible i in 0..7
    const series = seriesOf(closes);
    const perFrontier: ConfluenceWire[] = closes.map((_, i) => ({ bullish_count: i, bearish_count: 0, neutral_count: 1, weighted_vote: 0.5 }));
    // Decision points at i=1 and i=6 -- far apart within the same window.
    const decisions = ["NoChange", "WorthLook", "NoChange", "NoChange", "NoChange", "NoChange", "WorthAiCall", "NoChange"];
    let gateCall = 0;
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles: series }),
        benchmarkCompute: vi.fn().mockImplementation((_s, _t, _h, window: CandleWire[]) =>
          Promise.resolve({ type: "benchmark_compute", id: 1, algo_results: [], confluence: perFrontier[window.length - 1] }),
        ),
        evaluateScanGateStateless: vi.fn().mockImplementation((_prev: ConfluenceWire | null, _curr: ConfluenceWire) =>
          Promise.resolve({ type: "scan_gate", id: 1, decision: decisions[gateCall++] }),
        ),
      },
    };

    const result = await runBenchmark(deps, baseParams({ horizon: "intraday", lookaheadBars: 2 }));

    expect(result.decisionPoints.map((p) => p.frontierIndex)).toEqual([1, 6]);
    const lastPoint = result.decisionPoints[result.decisionPoints.length - 1];
    // The last decision point's own scoring bar (frontierIndex + lookaheadBars)
    // must be present in result.candles, and its ts must be reachable there too.
    expect(series[lastPoint.frontierIndex + 2].ts).toBe(series[8].ts);
    expect(result.candles.some((c) => c.ts === lastPoint.ts)).toBe(true);
    expect(result.candles[result.candles.length - 1].ts).toBe(series[8].ts);
  });

  it("bounds result.candles to the selected day plus lookaheadBars, not the entire backfilled partition", async () => {
    // P14's backfill routinely pads a partition with 80-100+ bars of OLDER
    // history so the algorithm has enough lookback context (correct, and NOT
    // under test here). That padding must stay internal: the chart should only
    // ever see the tested day through the day its outcome is scored against.
    const dayStart = 1_700_000_000;
    const before = 50;
    const after = 50;
    const lookaheadBars = 3;
    const total = before + 1 + after;
    const candles: CandleWire[] = Array.from({ length: total }, (_, i) => ({
      ts: dayStart + (i - before) * DAY_SECONDS,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 100,
    }));
    const fromTs = candles[before].ts;
    const toTs = fromTs + DAY_SECONDS;
    const deps: BenchmarkRunnerDeps = {
      sidecar: {
        ensureDayBackfill: backfillOk(),
        readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 1, candles }),
        benchmarkCompute: vi.fn().mockResolvedValue({ type: "benchmark_compute", id: 1, algo_results: [], confluence: BULLISH }),
        evaluateScanGateStateless: vi.fn(),
      },
    };

    const result = await runBenchmark(deps, baseParams({ timeframe: "day", fromTs, toTs, lookaheadBars }));

    expect(result.candles).toHaveLength(lookaheadBars + 1);
    expect(result.candles[0].ts).toBe(fromTs);
    expect(result.candles[result.candles.length - 1].ts).toBe(fromTs + lookaheadBars * DAY_SECONDS);
  });
});
