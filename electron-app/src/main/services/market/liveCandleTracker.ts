export interface LiveCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const IST_OFFSET_SECONDS = 5.5 * 60 * 60;

// Bucket start = floor(minutes-since-IST-midnight / intervalMinutes) *
// intervalMinutes, converted back to a unix-seconds timestamp. This matches
// how Kite's own historical 5/10/15-minute bars are aligned -- wall-clock
// marks from midnight IST, not offsets relative to the 09:15 session open --
// so a live-built candle's timestamp lines up with the already-persisted
// historical candles preceding it in the same chart.
function bucketStart(ts: number, intervalSeconds: number): number {
  const istSeconds = ts + IST_OFFSET_SECONDS;
  const secondsSinceIstMidnight = istSeconds % 86400;
  const bucketOffsetWithinDay = Math.floor(secondsSinceIstMidnight / intervalSeconds) * intervalSeconds;
  return ts - (secondsSinceIstMidnight - bucketOffsetWithinDay);
}

export class LiveCandleTracker {
  private readonly intervalSeconds: number;
  private forming: LiveCandle | null = null;

  constructor(intervalMinutes: number) {
    this.intervalSeconds = intervalMinutes * 60;
  }

  onTick(ts: number, price: number): LiveCandle | null {
    const bucket = bucketStart(ts, this.intervalSeconds);

    if (this.forming === null) {
      this.forming = { ts: bucket, open: price, high: price, low: price, close: price };
      return null;
    }

    if (this.forming.ts === bucket) {
      this.forming.high = Math.max(this.forming.high, price);
      this.forming.low = Math.min(this.forming.low, price);
      this.forming.close = price;
      return null;
    }

    const closed = this.forming;
    this.forming = { ts: bucket, open: price, high: price, low: price, close: price };
    return closed;
  }
}
