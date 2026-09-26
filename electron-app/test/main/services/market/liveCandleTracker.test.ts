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

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 105, low: 95, close: 95, volume: 0 });
  });

  it("starts a fresh forming candle after a close, using the crossing tick as its first price", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    tracker.onTick(IST_0915_UTC_SECONDS + 300, 102); // closes bucket 1, opens bucket 2 at 102

    const closedSecond = tracker.onTick(IST_0915_UTC_SECONDS + 600, 110); // closes bucket 2

    expect(closedSecond).toEqual({ ts: IST_0915_UTC_SECONDS + 300, open: 102, high: 102, low: 102, close: 102, volume: 0 });
  });

  it("still closes correctly across a gap in ticks (no tick lands exactly on a boundary)", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100);
    // Next tick arrives 7 minutes later -- well past the 5-minute boundary,
    // simulating an illiquid instrument with no tick exactly at :20:00.
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 420, 108);

    expect(closed).toEqual({ ts: IST_0915_UTC_SECONDS, open: 100, high: 100, low: 100, close: 100, volume: 0 });
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

  it("reports a bar's own volume as the rise in Kite's day-cumulative volume_traded, not the raw total", () => {
    const tracker = new LiveCandleTracker(5);

    tracker.onTick(IST_0915_UTC_SECONDS, 100, 1_000_000);
    tracker.onTick(IST_0915_UTC_SECONDS + 120, 101, 1_000_450);
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 102, 1_000_700);

    expect(closed?.volume).toBe(700);
  });

  it("starts the next bar's volume baseline at the closing tick's cumulative total", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100, 1_000_000);
    tracker.onTick(IST_0915_UTC_SECONDS + 300, 102, 1_000_700); // closes bar 1, opens bar 2

    const closedSecond = tracker.onTick(IST_0915_UTC_SECONDS + 600, 110, 1_000_900);

    // 1_000_900 - 1_000_700: the second bar must not inherit the first bar's
    // volume, and no traded quantity may be counted into two bars at once.
    expect(closedSecond?.volume).toBe(200);
  });

  it("keeps the forming bar's volume up to date on every tick, not only at close", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100, 5_000);
    tracker.onTick(IST_0915_UTC_SECONDS + 60, 101, 5_300);

    // Observable only through the closed bar, which is what gets persisted.
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 102, 5_300);
    expect(closed?.volume).toBe(300);
  });

  it("treats a tick with no volume_traded as no new volume rather than a reset to zero", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100, 2_000);
    tracker.onTick(IST_0915_UTC_SECONDS + 60, 101, 2_500);
    tracker.onTick(IST_0915_UTC_SECONDS + 120, 102); // LTP-shaped tick, no volume field

    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 103);

    expect(closed?.volume).toBe(500);
  });

  it("never reports a negative volume if the cumulative total goes backwards", () => {
    const tracker = new LiveCandleTracker(5);
    tracker.onTick(IST_0915_UTC_SECONDS, 100, 9_000);

    // A day rollover (or a malformed tick) resets volume_traded; clamping keeps
    // a nonsense negative bar out of the shared candle lake.
    const closed = tracker.onTick(IST_0915_UTC_SECONDS + 300, 102, 10);

    expect(closed?.volume).toBe(0);
  });
});
