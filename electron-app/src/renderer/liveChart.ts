import { createChart, CandlestickSeries, type UTCTimestamp } from "lightweight-charts";
import type { CandleWire } from "../main/services/sidecar/sidecarProtocol";
import type { LiveTickWire } from "../main/services/market/liveSessionRunner";

export interface LiveChartHandle {
  applyTick(tick: LiveTickWire, intervalSeconds: number): void;
  applyClosedCandle(candle: CandleWire): void;
  dispose(): void;
}

export function createLiveChart(container: HTMLElement, initialCandles: CandleWire[]): LiveChartHandle {
  const chart = createChart(container, { autoSize: true });
  const candleSeries = chart.addSeries(CandlestickSeries, { priceLineVisible: false });

  candleSeries.setData(
    initialCandles.map((c) => ({
      time: c.ts as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );

  let forming: { ts: number; open: number; high: number; low: number; close: number } | null = null;

  return {
    applyTick(tick, intervalSeconds) {
      if (forming === null) {
        forming = { ts: tick.ts, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
      } else {
        const currentBucket = Math.floor(tick.ts / intervalSeconds) * intervalSeconds;
        const previousBucket = Math.floor(forming.ts / intervalSeconds) * intervalSeconds;
        if (currentBucket !== previousBucket) {
          forming = { ts: tick.ts, open: tick.price, high: tick.price, low: tick.price, close: tick.price };
        } else {
          forming.high = Math.max(forming.high, tick.price);
          forming.low = Math.min(forming.low, tick.price);
          forming.close = tick.price;
        }
      }
      candleSeries.update({
        time: forming.ts as UTCTimestamp,
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close,
      });
    },
    applyClosedCandle(candle) {
      candleSeries.update({
        time: candle.ts as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
      forming = null;
    },
    dispose() {
      chart.remove();
    },
  };
}
