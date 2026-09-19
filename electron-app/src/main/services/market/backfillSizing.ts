import { barsPerTradingDay, type CandleInterval } from "./candleInterval";

// Covers the worst realistic run of NSE holidays inside a requested span
// (P13§4.2). Over-fetching costs one wider Kite window and some surplus rows
// the lake merges idempotently; under-fetching silently starves a forecaster.
export const HOLIDAY_BUFFER_DAYS = 5;

export function calendarDaysForBackfill(interval: CandleInterval, requiredBars: number): number {
  if (requiredBars <= 0) return 0;
  const tradingDays = Math.ceil(requiredBars / barsPerTradingDay(interval));
  return Math.ceil((tradingDays * 7) / 5) + HOLIDAY_BUFFER_DAYS;
}

export function maxRequiredLookback(algorithms: { requiredLookback: number }[]): number {
  return algorithms.reduce((max, algo) => Math.max(max, algo.requiredLookback), 0);
}
