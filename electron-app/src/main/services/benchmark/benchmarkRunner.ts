import type { AlgoResultWire, CandleWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { Conviction, Direction } from "../analysis/contracts";
import type { Horizon } from "../../ipc/rendererApi";

export type Outcome = "correct" | "incorrect" | "neutral";

export type BenchmarkCadence =
  | { mode: "session_close" }
  | { mode: "stateless_gate" }
  | { mode: "manual"; everyN: number };

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
  cadence: BenchmarkCadence;
  lookaheadBars: number;
  fromTs: number;
  toTs: number;
}

export interface BenchmarkResult {
  params: BenchmarkRunParams;
  candles: CandleWire[];
  decisionPoints: DecisionPoint[];
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
