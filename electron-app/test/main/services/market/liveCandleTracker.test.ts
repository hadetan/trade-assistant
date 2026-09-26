import { describe, expect, it } from "vitest";
import { LiveCandleTracker } from "../../../../src/main/services/market/liveCandleTracker";

// 2026-09-26 is a Saturday in real life but the tracker has no day-of-week
// logic -- it only buckets by minutes-since-IST-midnight, so any date works.
// 09:15:00 IST = 03:45:00 UTC.
const IST_0915_UTC_SECONDS = Date.UTC(2026, 8, 26, 3, 45, 0) / 1000;

describe("LiveCandleTracker", () => {
  it("returns null for every tick within the same 5-minute bucket", () => {
    const tracker = new LiveCandleTracker(5);

    expect(tracker.onTick(IST_0915_UTC_SECONDS, 100)).toBeNull();
    expect(tracker.onTick(IST_0915_UTC_SECONDS + 60, 101)).toBeNull();
    expect(tracker.onTick(IST_0915_UTC_SECONDS + 299, 99)).toBeNull();
  });

  it("returns the closed candle with correct OHLC when a tick crosses into a new bucket", () => {
    const tracker = new LiveCandleTracker(5);

    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    tracker.onTick(IST_0915_UTC_SECONDS + 60, 105);
    tracker.onTick(IST_0915_UTC_SECONDS + 120, 95);
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 102); // exactly 09:20:00 -- next bucket

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 105, low: 95, close: 95 });
  });

  it("starts a fresh forming candle after a close, using the crossing tick as its first price", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    tracker.onTick(IST_0915_UTC_SECONDS + 300, 102); // closes bucket 1, opens bucket 2 at 102

    const closedSecond = tracker.onTick(IST_0915_UTC_SECONDS + 600, 110); // closes bucket 2

    expect(closedSecond).toEqual({ ts: IST_0915_UTC_SECONDS + 300, open: 102, high: 102, low: 102, close: 102 });
  });

  it("still closes correctly across a gap in ticks (no tick lands exactly on a boundary)", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    // Next tick arrives 7 minutes later -- well past the 5-minute boundary,
    // simulating an illiquid instrument with no tick exactly at :20:00.
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 420, 108);

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 100, low: 100, close: 100 });
  });

  it("aligns bucket boundaries to wall-clock minutes since IST midnight, not session-open-relative offsets", () => {
    const tracker = new LiveCandleTracker(10);
    // 09:15 IST is 555 minutes since midnight -- not a multiple of 10, so the
    // first bucket for a 10-minute tracker starting at market open is
    // [09:10, 09:20), matching how Kite's own historical 10-minute bars are
    // aligned (from-midnight wall-clock marks), not [09:15, 09:25).
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 5 * 60, 105); // 09:20:00 -- crosses into [09:20,09:30)

    expect(closed?.ts).toBe(IST_0915_UTC_SECONDS - 5 * 60); // bucket started at 09:10:00
  });
});
