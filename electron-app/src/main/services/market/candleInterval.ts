export type CandleInterval = "5minute" | "10minute" | "15minute";

export const CANDLE_INTERVALS: CandleInterval[] = ["5minute", "10minute", "15minute"];

export const CANDLE_INTERVAL_LABEL: Record<CandleInterval, string> = {
  "5minute": "5-minute",
  "10minute": "10-minute",
  "15minute": "15-minute",
};

// NSE's regular equity session is 09:15-15:30 IST (P13§3).
export const NSE_SESSION_MINUTES = 375;

const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  "5minute": 5,
  "10minute": 10,
  "15minute": 15,
};

export function intervalMinutes(interval: CandleInterval): number {
  return INTERVAL_MINUTES[interval];
}

export function barsPerTradingDay(interval: CandleInterval): number {
  // Floor, not round: a partial trailing bar is not a bar you can rely on
  // receiving, so 375/10 counts as 37 ten-minute bars, never 38.
  return Math.floor(NSE_SESSION_MINUTES / INTERVAL_MINUTES[interval]);
}
