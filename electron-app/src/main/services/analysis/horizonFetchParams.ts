import type { Horizon } from "../../ipc/rendererApi";

const INTRADAY_LOOKBACK_DAYS = 5;
const POSITIONAL_LOOKBACK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface HorizonFetchParams {
  timeframe: string;
  from: string;
  to: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Kite's historical-data API expects date/time strings in IST regardless of
// the host machine's timezone, so wall-clock components are read off a
// UTC-shifted clone (via the UTC getters) rather than the Date's local ones.
function toIst(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

function formatDate(d: Date): string {
  const ist = toIst(d);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

function formatDateTime(d: Date): string {
  const ist = toIst(d);
  return `${formatDate(d)} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

export function horizonToFetchParams(horizon: Horizon, now: Date): HorizonFetchParams {
  if (horizon === "intraday") {
    const from = new Date(now.getTime() - INTRADAY_LOOKBACK_DAYS * DAY_MS);
    return { timeframe: "5minute", from: formatDateTime(from), to: formatDateTime(now) };
  }
  const from = new Date(now.getTime() - POSITIONAL_LOOKBACK_DAYS * DAY_MS);
  return { timeframe: "day", from: formatDate(from), to: formatDate(now) };
}
