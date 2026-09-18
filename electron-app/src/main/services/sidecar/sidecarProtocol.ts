// These interfaces mirror the Rust sidecar's serde JSON contract verbatim
// (rust-core/crates/sidecar/src/protocol.rs); field names stay snake_case to
// match the bytes on the wire, not this project's TS naming convention.
export interface CandleWire {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlgoResultWire {
  algo_id: string;
  symbol: string;
  timeframe: string;
  horizon: string;
  direction: string;
  magnitude: number;
  confidence: number;
  evidence: string[];
  computed_at: string;
}

export interface ConfluenceWire {
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  weighted_vote: number;
}

export interface ComputeResponseWire {
  type: "compute";
  id: number;
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
}

export interface PersistCandlesResponseWire {
  type: "persist_candles";
  id: number;
  written: number;
  error?: string;
}

export interface WatchlistResponseWire {
  type: "watchlist";
  id: number;
  symbols: string[];
  error?: string;
}

export interface ScanGateResponseWire {
  type: "scan_gate";
  id: number;
  decision: "NoChange" | "WorthLook" | "WorthAiCall";
  error?: string;
}

export interface LakeSymbolWire {
  symbol: string;
  timeframe: string;
  source: string;
  from_ts: number;
  to_ts: number;
  candle_count: number;
}

export interface LakeSymbolsResponseWire {
  type: "lake_symbols";
  id: number;
  entries: LakeSymbolWire[];
  error?: string;
}

export interface LakeCandlesResponseWire {
  type: "lake_candles";
  id: number;
  candles: CandleWire[];
  error?: string;
}

export interface BenchmarkComputeResponseWire {
  type: "benchmark_compute";
  id: number;
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
}

export interface DayBackfillResponseWire {
  type: "day_backfill";
  id: number;
  have: number;
  need: number;
  sufficient: boolean;
  // The walk gave up because the archive had no file for CLOSED_DAY_LIMIT
  // weekdays running -- a different claim from "this symbol is only N days
  // old", and the sidecar always sends it, so it is required here too.
  archive_exhausted: boolean;
  error?: string;
}

export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string; // request-type name ("compute", …) or algorithm id ("rsi", …)
  status: "running" | "done";
  // Present only on a counted step (today just "backfill"); absence is how a
  // consumer tells an ordinary bracket line from an N-of-M one.
  index?: number;
  total?: number;
}

export interface AlgorithmWire {
  id: string;
  cost: "fast" | "slow";
  required_lookback: number;
}

export interface ListAlgorithmsResponseWire {
  type: "algorithms";
  id: number;
  algorithms: AlgorithmWire[];
}

export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire
  | LakeSymbolsResponseWire
  | LakeCandlesResponseWire
  | BenchmarkComputeResponseWire
  | ListAlgorithmsResponseWire
  | DayBackfillResponseWire;

export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] }
  | { type: "add_watchlist_symbol"; id: number; symbol: string }
  | { type: "remove_watchlist_symbol"; id: number; symbol: string }
  | { type: "list_watchlist"; id: number }
  | { type: "evaluate_scan_gate"; id: number; symbol: string; confluence: ConfluenceWire }
  | { type: "list_lake_symbols"; id: number }
  | { type: "read_lake_candles"; id: number; symbol: string; timeframe: string; source: string }
  | { type: "benchmark_compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[]; algo_id: string }
  | { type: "evaluate_scan_gate_stateless"; id: number; prev: ConfluenceWire | null; curr: ConfluenceWire }
  | { type: "list_algorithms"; id: number }
  | { type: "ensure_day_backfill"; id: number; symbol: string; algo_id: string };

export function encodeRequest(request: SidecarRequestWire): string {
  return `${JSON.stringify(request)}\n`;
}
