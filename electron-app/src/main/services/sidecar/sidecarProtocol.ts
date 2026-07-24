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

export type SidecarResponseWire = ComputeResponseWire | PersistCandlesResponseWire;

export type SidecarRequestWire =
  | { type: "compute"; id: number; symbol: string; timeframe: string; closes: number[] }
  | { type: "persist_candles"; id: number; symbol: string; timeframe: string; source: string; candles: CandleWire[] };

export function encodeRequest(request: SidecarRequestWire): string {
  return `${JSON.stringify(request)}\n`;
}
