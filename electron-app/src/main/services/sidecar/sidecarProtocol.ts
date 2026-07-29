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

export interface SidecarProgressWire {
  type: "progress";
  id: number;
  step: string; // request-type name ("compute", …) or algorithm id ("rsi", …)
  status: "running" | "done";
}

export type SidecarResponseWire =
  | ComputeResponseWire
  | PersistCandlesResponseWire
  | WatchlistResponseWire
  | ScanGateResponseWire
  | LakeSymbolsResponseWire
  | LakeCandlesResponseWire
  | BenchmarkComputeResponseWire;

export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] }
  | { type: "add_watchlist_symbol"; id: number; symbol: string }
  | { type: "remove_watchlist_symbol"; id: number; symbol: string }
  | { type: "list_watchlist"; id: number }
  | { type: "evaluate_scan_gate"; id: number; symbol: string; confluence: ConfluenceWire }
  | { type: "list_lake_symbols"; id: number }
  | { type: "read_lake_candles"; id: number; symbol: string; timeframe: string; source: string }
  | { type: "benchmark_compute"; id: number; symbol: string; timeframe: string; horizon: string; candles: CandleWire[] }
  | { type: "evaluate_scan_gate_stateless"; id: number; prev: ConfluenceWire | null; curr: ConfluenceWire };

export function encodeRequest(request: SidecarRequestWire): string {
  return `${JSON.stringify(request)}\n`;
}
