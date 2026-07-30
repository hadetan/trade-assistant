import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BenchmarkResult, DecisionPoint, Outcome } from "../main/ipc/rendererApi";
import type { CandleWire } from "../main/services/sidecar/sidecarProtocol";

const OUTCOME_TOKEN: Record<Outcome, string> = {
  correct: "--bullish",
  incorrect: "--bearish",
  neutral: "--neutral",
};

export interface BenchmarkChartHandle {
  dispose(): void;
}

export function createBenchmarkChart(
  container: HTMLElement,
  result: BenchmarkResult,
  onSelect: (point: DecisionPoint | null) => void,
): BenchmarkChartHandle {
  const chart = createChart(container, { autoSize: true });

  const candleSeries = chart.addSeries(CandlestickSeries);
  candleSeries.setData(
    result.candles.map((c: CandleWire) => ({
      time: c.ts as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );

  const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "volume" });
  volumeSeries.setData(result.candles.map((c: CandleWire) => ({ time: c.ts as UTCTimestamp, value: c.volume })));

  // Canvas fillStyle needs a resolved color, not a var() reference — reading the
  // computed style off the chart's own container is what lets a marker's color
  // track the app's current theme (P10§3.1's unified bullish/bearish/neutral palette)
  // instead of a palette hardcoded independently of tokens.css.
  const outcomeColor = (outcome: Outcome): string =>
    getComputedStyle(container).getPropertyValue(OUTCOME_TOKEN[outcome]).trim();

  function markerFor(point: DecisionPoint): SeriesMarker<Time> {
    const bullish = point.direction === "bullish";
    const bearish = point.direction === "bearish";
    return {
      time: point.ts as UTCTimestamp,
      position: bullish ? "belowBar" : bearish ? "aboveBar" : "inBar",
      color: outcomeColor(point.outcome),
      shape: bullish ? "arrowUp" : bearish ? "arrowDown" : "circle",
    };
  }

  createSeriesMarkers(candleSeries, result.decisionPoints.map(markerFor));

  const byTime = new Map<number, DecisionPoint>(result.decisionPoints.map((p) => [p.ts, p]));
  chart.subscribeClick((param) => {
    const time = param.time as number | undefined;
    onSelect(time === undefined ? null : byTime.get(time) ?? null);
  });

  return {
    dispose(): void {
      chart.remove();
    },
  };
}
