import type { KiteClient } from "./kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { CandleWire } from "../sidecar/sidecarProtocol";

export interface RawKiteCandle {
  0: string;
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

// Community-reported per-interval caps, unverified against the live API
// (design §14, item 2). Usable only as an initial chunk-size hint until a
// live Kite session lets us confirm the real limits.
export const INTERVAL_LOOKBACK_HINT_DAYS: Record<string, number> = {
  minute: 60,
  "3minute": 100,
  "5minute": 100,
  "10minute": 100,
  "15minute": 200,
  "30minute": 200,
  "60minute": 400,
  day: 2000,
};

export function parseKiteCandles(raw: RawKiteCandle[]): CandleWire[] {
  return raw.map((row) => ({
    // Kite's timestamps carry an explicit +0530 offset; Date.parse resolves
    // that offset-aware. Stripping it to a naive local/UTC parse is a
    // documented real bug class that corrupts times (design §5.2).
    ts: Math.floor(Date.parse(row[0]) / 1000),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
  }));
}

function extractRawCandles(response: unknown): RawKiteCandle[] {
  const candles = (response as { data?: { candles?: unknown } })?.data?.candles;
  return Array.isArray(candles) ? (candles as RawKiteCandle[]) : [];
}

export interface FetchAndArchiveDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "persistCandles">;
}

export interface FetchAndArchiveParams {
  symbol: string;
  instrumentToken: string;
  timeframe: string;
  from: string;
  to: string;
}

export async function fetchAndArchive(
  deps: FetchAndArchiveDeps,
  params: FetchAndArchiveParams,
): Promise<{ candles: CandleWire[]; closes: number[]; persisted: number }> {
  const response = await deps.kite.getHistoricalData({
    instrumentToken: params.instrumentToken,
    interval: params.timeframe,
    from: params.from,
    to: params.to,
  });

  const candles = parseKiteCandles(extractRawCandles(response));
  const persistResult = await deps.sidecar.persistCandles(params.symbol, params.timeframe, candles, "kite");
  const closes = candles.map((candle) => candle.close);

  return { candles, closes, persisted: persistResult.written };
}
