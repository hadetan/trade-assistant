import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { CandleWire } from "../sidecar/sidecarProtocol";
import { parseKiteCandles, type RawKiteCandle } from "../kite/historicalDataArchive";
import { calendarDaysForBackfill } from "./backfillSizing";
import type { CandleInterval } from "./candleInterval";

// The lake partition the live warm-up owns. Distinct from "bhavcopy", which the
// daily-bar ingestion path writes and this phase never touches.
export const WARMUP_SOURCE = "kite";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface TopUpDeps {
  kite: Pick<KiteClient, "getHistoricalData">;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles">;
}

export interface TopUpParams {
  symbol: string;
  instrumentToken: string;
  interval: CandleInterval;
  requiredBars: number;
  now: Date;
}

export interface TopUpResult {
  candles: CandleWire[];
  fetched: number;
  backfilled: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Kite's historical-data API expects IST date-time strings regardless of the
// host machine's timezone, so components are read off a UTC-shifted clone.
function formatIstDateTime(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`
  );
}

function extractRawCandles(response: unknown): RawKiteCandle[] {
  const candles = (response as { data?: { candles?: unknown } })?.data?.candles;
  return Array.isArray(candles) ? (candles as RawKiteCandle[]) : [];
}

export async function topUpCandles(deps: TopUpDeps, params: TopUpParams): Promise<TopUpResult> {
  const existing = await deps.sidecar.readLakeCandles(params.symbol, params.interval, WARMUP_SOURCE);
  const lastTs = existing.candles.length === 0 ? null : existing.candles[existing.candles.length - 1].ts;
  const backfilled = lastTs === null;

  const from =
    lastTs === null
      ? new Date(params.now.getTime() - calendarDaysForBackfill(params.interval, params.requiredBars) * DAY_MS)
      : new Date(lastTs * 1000);

  // A zero- or negative-width window would make Kite either error or return the
  // same last bar forever; the lake is already current, so nothing to do.
  if (from.getTime() >= params.now.getTime()) {
    return { candles: existing.candles, fetched: 0, backfilled };
  }

  const response = await deps.kite.getHistoricalData({
    instrumentToken: params.instrumentToken,
    interval: params.interval,
    from: formatIstDateTime(from),
    to: formatIstDateTime(params.now),
  });
  const fetched = parseKiteCandles(extractRawCandles(response));

  if (fetched.length > 0) {
    // write_sourced_candles is a read-merge-write keyed on ts, so re-sending the
    // last stored bar is idempotent -- no from+1 arithmetic, no gap risk.
    const persisted = await deps.sidecar.persistCandles(params.symbol, params.interval, fetched, WARMUP_SOURCE);
    if (persisted.error != null) {
      throw new Error(`warming ${params.symbol} ${params.interval} failed: ${persisted.error}`);
    }
    if (persisted.written !== fetched.length) {
      throw new Error(
        `warming ${params.symbol} ${params.interval} failed: wrote ${persisted.written} of ${fetched.length} candles`,
      );
    }
  }

  const merged = await deps.sidecar.readLakeCandles(params.symbol, params.interval, WARMUP_SOURCE);
  return { candles: merged.candles, fetched: fetched.length, backfilled };
}
