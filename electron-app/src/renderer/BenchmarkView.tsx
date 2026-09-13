import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { EmptyState } from "./ui/EmptyState";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import { BarChart3, Copy } from "./ui/icons";
import "./BenchmarkView.css";
import type { AlgorithmEntry, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

type BenchmarkApi = Pick<
  RendererApi,
  "listLakeSymbols" | "listAlgorithms" | "runBenchmark" | "cancelBenchmark" | "copyBenchmarkResult" | "onBenchmarkProgress"
>;

function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fromDate(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

const DAY_SECONDS = 86_400;

function SummaryStrip({ points }: { points: DecisionPoint[] }): JSX.Element {
  const { correct, incorrect, neutral, hitRate } = summarize(points);
  if (points.length === 0) {
    return <Card className="benchmark-summary">0 decision points — nothing to score.</Card>;
  }
  const hitRateLabel = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
  return (
    <Card className="benchmark-summary">
      <Badge tone="bullish">{correct} correct</Badge>
      <Badge tone="bearish">{incorrect} incorrect</Badge>
      <Badge tone="neutral">{neutral} neutral</Badge>
      <span className="benchmark-summary-hitrate">hit-rate {hitRateLabel}</span>
    </Card>
  );
}

function ResultsView({ api, result }: { api: BenchmarkApi; result: BenchmarkResult }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<DecisionPoint | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;
    const handle = createBenchmarkChart(container, result, setSelected);
    return () => handle.dispose();
  }, [result]);

  return (
    <div className="benchmark-results">
      {result.cancelled && <Banner variant="info">Cancelled — partial results</Banner>}
      <SummaryStrip points={result.decisionPoints} />
      <Button variant="ghost" onClick={() => void api.copyBenchmarkResult(JSON.stringify(result))}>
        <Copy size={14} aria-hidden="true" /> Copy raw result
      </Button>
      <div className="benchmark-chart" ref={chartRef} />
      {selected && (
        <Card className="benchmark-popover">
          <h3>
            {selected.direction} ({selected.conviction} conviction) — {selected.outcome}
          </h3>
          <p>
            {selected.closeAtFrontier} → {selected.closeAtLookahead} ({(selected.realizedReturn * 100).toFixed(2)}%)
          </p>
          <p>algos: {selected.algoResults.map((r) => r.algo_id).join(", ")}</p>
          <MessageMarkdown text={selected.responseText} />
        </Card>
      )}
    </div>
  );
}

export function BenchmarkView({ api }: { api: BenchmarkApi }): JSX.Element {
  const [entries, setEntries] = useState<LakeSymbolEntry[] | null>(null);
  const [algorithms, setAlgorithms] = useState<AlgorithmEntry[] | null>(null);
  const [selected, setSelected] = useState<LakeSymbolEntry | null>(null);
  const [selectedAlgoId, setSelectedAlgoId] = useState<string | null>(null);
  const [lookaheadBars, setLookaheadBars] = useState(5);
  const [date, setDate] = useState("");
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);

  useEffect(() => {
    void api.listLakeSymbols().then(setEntries);
    void api.listAlgorithms().then(setAlgorithms);
    api.onBenchmarkProgress(setProgress);
  }, [api]);

  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setLookaheadBars(defaultLookaheadForHorizon(entry.horizon));
    setDate(toDate(entry.fromTs));
    setResult(null);
  };

  const onRun = async (): Promise<void> => {
    if (!selected || !selectedAlgoId) return;
    const dayStart = fromDate(date);
    if (!date || Number.isNaN(dayStart)) {
      setError("Pick a date before running.");
      return;
    }
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        algoId: selectedAlgoId,
        lookaheadBars,
        fromTs: dayStart,
        toTs: dayStart + DAY_SECONDS,
      });
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const onStop = (): void => {
    void api.cancelBenchmark();
  };

  if (entries === null || algorithms === null) {
    return (
      <div className="benchmark-loading">
        <Spinner /> Loading lake…
      </div>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={BarChart3} message="No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3)." />;
  }

  return (
    <div className="benchmark">
      {running && (
        <Card className="benchmark-progress-pill">
          <span>
            {selectedAlgoId} — bar {progress ? progress.index : 0}/{progress ? progress.total : "…"}
          </span>
          <div className="benchmark-progress-bar">
            <div
              className="benchmark-progress-bar-fill"
              style={{ width: progress && progress.total > 0 ? `${(progress.index / progress.total) * 100}%` : "0%" }}
            />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onStop}>
            Stop
          </Button>
        </Card>
      )}
      {result ? (
        <ResultsView api={api} result={result} />
      ) : (
        <>
          <h2>Benchmark</h2>
          <ul className="benchmark-picker">
            {entries.map((entry) => (
              <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
                <button type="button" className="benchmark-picker-item" onClick={() => onSelectEntry(entry)}>
                  {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <Card>
              <form
                className="benchmark-setup"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onRun();
                }}
              >
                <p>
                  Horizon: <strong>{selected.horizon}</strong> (derived from timeframe)
                </p>
                <fieldset className="benchmark-algo-picker">
                  <legend>Algorithm</legend>
                  {algorithms.map((algo) => (
                    <Button
                      key={algo.id}
                      type="button"
                      variant={selectedAlgoId === algo.id ? "primary" : "secondary"}
                      size="sm"
                      aria-pressed={selectedAlgoId === algo.id}
                      onClick={() => setSelectedAlgoId(algo.id)}
                    >
                      {algo.id} · {algo.cost === "slow" ? "slow (ML forecaster)" : "fast"}
                    </Button>
                  ))}
                </fieldset>
                <label className="benchmark-field">
                  Lookahead bars
                  <TextField type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
                </label>
                <label className="benchmark-field">
                  Date
                  <TextField
                    type="date"
                    required
                    min={toDate(selected.fromTs)}
                    max={toDate(selected.toTs)}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={running || !selectedAlgoId}>
                  {running && <Spinner size={14} />} {running ? "Running…" : "Run benchmark"}
                </Button>
                {error && <Banner variant="error">{error}</Banner>}
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
