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

const OUTCOME_COLOR: Record<Outcome, string> = {
  correct: "#26a69a",
  incorrect: "#ef5350",
  neutral: "#9e9e9e",
};

export interface BenchmarkChartHandle {
  dispose(): void;
}

function markerFor(point: DecisionPoint): SeriesMarker<Time> {
  const bullish = point.direction === "bullish";
  const bearish = point.direction === "bearish";
  return {
    time: point.ts as UTCTimestamp,
    position: bullish ? "belowBar" : bearish ? "aboveBar" : "inBar",
    color: OUTCOME_COLOR[point.outcome],
    shape: bullish ? "arrowUp" : bearish ? "arrowDown" : "circle",
  };
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
