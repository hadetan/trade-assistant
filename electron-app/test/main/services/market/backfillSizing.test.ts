import { describe, expect, it } from "vitest";
import { barsPerTradingDay, CANDLE_INTERVALS, type CandleInterval } from "../../../../src/main/services/market/candleInterval";
import { calendarDaysForBackfill, maxRequiredLookback } from "../../../../src/main/services/market/backfillSizing";
import { INTERVAL_LOOKBACK_HINT_DAYS } from "../../../../src/main/services/kite/historicalDataArchive";

const KRONOS_LOOKBACK = 256; // kronos_math.rs:11 CTX_LEN
const TTM_MOIRAI_LOOKBACK = 512; // ttm_math.rs:20 / moirai_math.rs:13 CONTEXT_LEN

describe("barsPerTradingDay", () => {
  it("matches the P13§3 candles-per-trading-day table for NSE's 375-minute session", () => {
    expect(barsPerTradingDay("5minute")).toBe(75);
    expect(barsPerTradingDay("10minute")).toBe(37);
    expect(barsPerTradingDay("15minute")).toBe(25);
  });
});

describe("calendarDaysForBackfill", () => {
  // The P13§4.2 formula is normative; P13§3's "~N calendar days" table was
  // computed without HOLIDAY_BUFFER_DAYS and is the order-of-magnitude check
  // these numbers pass, not the assertion (see the plan's open item (iv)).
  it("sizes the largest forecaster requirement (512 bars) per interval", () => {
    expect(calendarDaysForBackfill("5minute", TTM_MOIRAI_LOOKBACK)).toBe(15);
    expect(calendarDaysForBackfill("10minute", TTM_MOIRAI_LOOKBACK)).toBe(25);
    expect(calendarDaysForBackfill("15minute", TTM_MOIRAI_LOOKBACK)).toBe(35);
  });

  it("sizes the smallest forecaster requirement (256 bars) per interval", () => {
    expect(calendarDaysForBackfill("5minute", KRONOS_LOOKBACK)).toBe(11);
    expect(calendarDaysForBackfill("10minute", KRONOS_LOOKBACK)).toBe(15);
    expect(calendarDaysForBackfill("15minute", KRONOS_LOOKBACK)).toBe(21);
  });

  it("asks for nothing when nothing is required", () => {
    expect(calendarDaysForBackfill("5minute", 0)).toBe(0);
    expect(calendarDaysForBackfill("5minute", -1)).toBe(0);
  });

  it("never requests a span wider than Kite's per-interval range hint, so the backfill stays one un-chunked call", () => {
    // Guard for the plan's open item (i): if a future forecaster's
    // required_lookback pushes any interval past its hint, this fails loudly
    // instead of the backfill silently returning a truncated window.
    for (const interval of CANDLE_INTERVALS) {
      expect(calendarDaysForBackfill(interval, TTM_MOIRAI_LOOKBACK)).toBeLessThanOrEqual(
        INTERVAL_LOOKBACK_HINT_DAYS[interval satisfies CandleInterval],
      );
    }
  });
});

describe("maxRequiredLookback", () => {
  it("takes the maximum across every linked algorithm, not just the forecasters", () => {
    expect(
      maxRequiredLookback([
        { requiredLookback: 20 },
        { requiredLookback: 512 },
        { requiredLookback: 52 },
      ]),
    ).toBe(512);
  });

  it("returns 0 for an empty registry rather than -Infinity", () => {
    expect(maxRequiredLookback([])).toBe(0);
  });
});
