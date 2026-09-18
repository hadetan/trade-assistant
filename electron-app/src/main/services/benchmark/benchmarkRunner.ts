import type { AlgoResultWire, CandleWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { AnalysisEnvelope, Conviction, Direction } from "../analysis/contracts";
import type { Horizon } from "../../ipc/rendererApi";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import { generateDeterministicResponse } from "../analysis/deterministicResponseGenerator";

export type Outcome = "correct" | "incorrect" | "neutral";

export type BenchmarkCadence = { mode: "session_close" } | { mode: "stateless_gate" };

export interface DecisionPoint {
  frontierIndex: number;
  ts: number;
  closeAtFrontier: number;
  closeAtLookahead: number;
  realizedReturn: number;
  direction: Direction;
  conviction: Conviction;
  responseText: string;
  algoResults: AlgoResultWire[];
  confluence: ConfluenceWire;
  outcome: Outcome;
}

export interface BenchmarkRunParams {
  symbol: string;
  timeframe: string;
  source: string;
  horizon: Horizon;
  algoId: string;
  lookaheadBars: number;
  fromTs: number;
  toTs: number;
}

export interface BenchmarkProgress {
  phase: "backfill" | "run";
  index: number;
  total: number;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
  cancelled: boolean;
  // Set only when the run has fewer bars than the selected algorithm needs even
  // after backfill (P14§6); the UI renders this instead of the empty summary
  // strip and chart that started this phase. `reason` keeps the two shortfalls
  // apart: "symbol_history" is a claim about the symbol, "archive_unreachable"
  // is a claim about the archive, and they must not be worded alike
  // (decision (xviii)).
  insufficientHistory?: { have: number; need: number; reason: "symbol_history" | "archive_unreachable" };
}

export const NEUTRAL_BAND = 0.001; // mirrors algo_core::benchmark_classify::DEFAULT_NEUTRAL_BAND
export const DEFAULT_POSITIONAL_LOOKAHEAD_BARS = 5; // ~1 trading week of day bars
export const DEFAULT_INTRADAY_LOOKAHEAD_BARS = 30; // ~30 minute bars

export function horizonForTimeframe(timeframe: string): Horizon {
  // Community-archive intraday data is stored under "minute", not "5minute", so
  // map any non-"day" timeframe to intraday rather than assuming "5minute".
  return timeframe === "day" ? "positional" : "intraday";
}

export function defaultCadenceForHorizon(horizon: Horizon): BenchmarkCadence {
  return horizon === "positional" ? { mode: "session_close" } : { mode: "stateless_gate" };
}

export function defaultLookaheadForHorizon(horizon: Horizon): number {
  return horizon === "positional" ? DEFAULT_POSITIONAL_LOOKAHEAD_BARS : DEFAULT_INTRADAY_LOOKAHEAD_BARS;
}

export function classifyDecision(direction: Direction, realizedReturn: number, neutralBand: number = NEUTRAL_BAND): Outcome {
  if (direction === "neutral") return "neutral";
  if (Math.abs(realizedReturn) <= neutralBand) return "neutral";
  const matches = direction === "bullish" ? realizedReturn > 0 : realizedReturn < 0;
  return matches ? "correct" : "incorrect";
}

export function summarize(points: DecisionPoint[]): { correct: number; incorrect: number; neutral: number; hitRate: number | null } {
  const correct = points.filter((p) => p.outcome === "correct").length;
  const incorrect = points.filter((p) => p.outcome === "incorrect").length;
  const neutral = points.filter((p) => p.outcome === "neutral").length;
  const denom = correct + incorrect;
  return { correct, incorrect, neutral, hitRate: denom === 0 ? null : correct / denom };
}

export interface BenchmarkRunnerDeps {
  sidecar: Pick<
    SidecarSupervisor,
    "readLakeCandles" | "benchmarkCompute" | "evaluateScanGateStateless" | "ensureDayBackfill"
  >;
}

export async function runBenchmark(
  deps: BenchmarkRunnerDeps,
  params: BenchmarkRunParams,
  onProgress?: (progress: BenchmarkProgress) => void,
): Promise<BenchmarkResult> {
  // Bhavcopy is the one on-demand source this app has, and it is day-only
  // (P14§1). The source check is not redundant with the timeframe check: the
  // live warm-up path writes ("day", "kite") partitions into the same lake, and
  // backfilling would top up ("day", "bhavcopy") while the run below reads the
  // partition this entry actually names (decision (viii)).
  if (params.timeframe === "day" && params.source === "bhavcopy") {
    let backfill;
    try {
      backfill = await deps.sidecar.ensureDayBackfill(params.symbol, params.algoId, params.lookaheadBars, (index, total) =>
        onProgress?.({ phase: "backfill", index, total }),
      );
    } catch (error) {
      if ((error as { cancelled?: boolean }).cancelled !== true) throw error;
      return { params, candles: [], decisionPoints: [], cancelled: true };
    }
    if (backfill.error && !backfill.sufficient) {
      throw new Error(`backfill failed for ${params.symbol}: ${backfill.error}`);
    }
    if (backfill.error) {
      console.error(`benchmark: backfill for ${params.symbol} reported: ${backfill.error}`);
    }
    if (!backfill.sufficient) {
      return {
        params,
        candles: [],
        decisionPoints: [],
        cancelled: false,
        insufficientHistory: {
          have: backfill.have,
          need: backfill.need,
          reason: backfill.archive_exhausted ? "archive_unreachable" : "symbol_history",
        },
      };
    }
  }

  const { candles } = await deps.sidecar.readLakeCandles(params.symbol, params.timeframe, params.source);
  // The FULL lake partition is the compute window: each frontier's
  // series.slice(0, i + 1) must legitimately reach back before fromTs, or
  // registry::run_applicable's lookback gate silently drops every algorithm
  // whose required_lookback() exceeds it (P13§8).
  const series = candles;
  // A separate index governs eligibility as a *frontier*: only bars inside
  // [fromTs, toTs) are decision points, and only those render on the chart.
  const windowStartIndex = series.findIndex((c) => c.ts >= params.fromTs);
  const firstFrontier = windowStartIndex === -1 ? series.length : windowStartIndex;
  const windowEndIndex = series.findIndex((c) => c.ts >= params.toTs);
  const boundByWindow = windowEndIndex === -1 ? series.length : windowEndIndex;
  // No upper bound from toTs on `series` itself: a day-timeframe entry's single
  // selected day is one bar, and scoring its outcome needs `lookaheadBars` MORE
  // bars beyond it.
  const boundByLookahead = Math.max(0, series.length - params.lookaheadBars);
  const progressTotal = Math.max(0, Math.min(boundByWindow, boundByLookahead) - firstFrontier);
  const cadence = defaultCadenceForHorizon(params.horizon);
  const decisionPoints: DecisionPoint[] = [];
  let prevConfluence: ConfluenceWire | null = null;
  let cancelled = false;

  try {
    for (let i = firstFrontier; i < series.length; i++) {
      // A frontier must fall inside the requested window; `toTs` is exclusive
      // (start of the next day) so a candle stamped exactly at that boundary is
      // never mistaken for part of the selected day.
      if (series[i].ts >= params.toTs) break;
      // Mirror run_replay's boundary: stop once no future bar exists at i+lookahead.
      if (i + params.lookaheadBars >= series.length) break;

      onProgress?.({ phase: "run", index: i - firstFrontier, total: progressTotal });

      let compute: { algo_results: AlgoResultWire[]; confluence: ConfluenceWire } | null = null;
      let isDecisionPoint = false;

      if (cadence.mode === "session_close") {
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1), params.algoId);
        isDecisionPoint = true;
      } else {
        // stateless_gate: compute every frontier to feed the gate, thread the
        // per-run prevConfluence (never persisted -- a benchmark can never
        // corrupt the live scanner's scan_snapshots gate memory).
        compute = await deps.sidecar.benchmarkCompute(params.symbol, params.timeframe, params.horizon, series.slice(0, i + 1), params.algoId);
        const gate = await deps.sidecar.evaluateScanGateStateless(prevConfluence, compute.confluence);
        prevConfluence = compute.confluence;
        isDecisionPoint = gate.decision !== "NoChange";
      }

      if (!isDecisionPoint || compute === null) continue;

      const closeAtFrontier = series[i].close;
      // Mirror run_replay's `current <= 0.0 -> continue`: a data glitch produces
      // no marker, but the candle still renders (it stays in `series`).
      if (closeAtFrontier <= 0) continue;

      const envelope: AnalysisEnvelope = {
        trigger: "reactive",
        instrument: { symbol: params.symbol, exchange: params.symbol.split(":")[0] ?? "", segment: "", kite_token_asof: "" },
        horizon_requested: params.horizon,
        intent_lens: "buying",
        algo_results: compute.algo_results,
        confluence: compute.confluence,
        overlays: {},
      };
      const { direction, conviction, text } = generateDeterministicResponse(envelope);
      const closeAtLookahead = series[i + params.lookaheadBars].close;
      const realizedReturn = (closeAtLookahead - closeAtFrontier) / closeAtFrontier;

      decisionPoints.push({
        frontierIndex: i,
        ts: series[i].ts,
        closeAtFrontier,
        closeAtLookahead,
        realizedReturn,
        direction,
        conviction,
        responseText: text,
        algoResults: compute.algo_results,
        confluence: compute.confluence,
        outcome: classifyDecision(direction, realizedReturn),
      });
    }
  } catch (error) {
    // A hard-cancel (SidecarSupervisor.cancelCurrent) tags its rejection
    // { cancelled: true } so the caller renders "Cancelled", not an error; any
    // other mid-walk rejection stops the walk but preserves the partial run.
    if ((error as { cancelled?: boolean }).cancelled === true) {
      cancelled = true;
    } else {
      console.error(`benchmark: run stopped early: ${(error as Error).message}`);
    }
  }

  return { params, candles: series.slice(firstFrontier), decisionPoints, cancelled };
}
