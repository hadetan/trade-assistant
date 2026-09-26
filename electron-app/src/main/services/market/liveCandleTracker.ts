export interface LiveCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  // Kite's full-mode `volume_traded` is the running total for the whole trading
  // day, not a per-tick delta, so a bar's own volume is the rise in that total
  // since the bar opened. Both are tracked: the baseline the forming bar opened
  // at, and the last reading seen (so a tick with no volume_traded at all reads
  // as "no new volume" rather than a reset to zero, which would go negative).
  private openingCumulativeVolume = 0;
  private lastCumulativeVolume = 0;

  constructor(intervalMinutes: number) {
    this.intervalSeconds = intervalMinutes * 60;
  }

  onTick(ts: number, price: number, cumulativeVolume?: number): LiveCandle | null {
    const bucket = bucketStart(ts, this.intervalSeconds);
    const cumulative = cumulativeVolume ?? this.lastCumulativeVolume;
    this.lastCumulativeVolume = cumulative;

    if (this.forming === null) {
      this.openingCumulativeVolume = cumulative;
      this.forming = { ts: bucket, open: price, high: price, low: price, close: price, volume: 0 };
      return null;
    }

    const volumeSoFar = Math.max(0, cumulative - this.openingCumulativeVolume);

    if (this.forming.ts === bucket) {
      this.forming.high = Math.max(this.forming.high, price);
      this.forming.low = Math.min(this.forming.low, price);
      this.forming.close = price;
      this.forming.volume = volumeSoFar;
      return null;
    }

    const closed = this.forming;
    closed.volume = volumeSoFar;
    this.openingCumulativeVolume = cumulative;
    this.forming = { ts: bucket, open: price, high: price, low: price, close: price, volume: 0 };
    return closed;
  }
}
