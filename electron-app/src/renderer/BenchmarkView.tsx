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
import type { AlgorithmEntry, BenchmarkProgress, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

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

function progressLabel(algoId: string | null, progress: BenchmarkProgress | null): string {
  if (progress?.phase === "backfill") {
    return `Backfilling history — ${progress.index}/${progress.total} days`;
  }
  return `${algoId} — bar ${progress ? progress.index : 0}/${progress ? progress.total : "…"}`;
}

function InsufficientHistory({ result }: { result: BenchmarkResult }): JSX.Element {
  const { have, need, reason } = result.insufficientHistory ?? { have: 0, need: 0, reason: "symbol_history" as const };
  // Two different facts, two different sentences: the walk can tell "this
  // symbol has no rows this far back" from "the archive answered nothing at
  // all", and saying the first when the second happened is a lie about the
  // user's symbol (decision (xviii)).
  if (reason === "archive_unreachable") {
    return (
      <Banner variant="warning">
        Could not reach far enough back into the NSE archive for {result.params.symbol} — collected {have} of the{" "}
        {need} days {result.params.algoId} needs before the archive stopped answering. It may not cover this far back.
      </Banner>
    );
  }
  return (
    <Banner variant="info">
      {result.params.symbol} has {have} days of real listed history; {result.params.algoId} needs {need}. Nothing to
      benchmark over.
    </Banner>
  );
}

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
    // Open the first decision point's explanation up front -- the popover only
    // otherwise appears on a chart-marker click, an interaction nothing in the UI
    // hints at, which made a run's result look unexplained even though the model's
    // own forecast text was there all along.
    setSelected(result.decisionPoints[0] ?? null);
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
      {result.decisionPoints.length > 0 && (
        <p className="benchmark-chart-hint">Click a marker on the chart to see what the algorithm predicted for that bar.</p>
      )}
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const setupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Without a .catch() here, a rejection leaves entries/algorithms null forever --
    // the view is stuck on the loading spinner with no indication anything failed.
    api
      .listLakeSymbols()
      .then(setEntries)
      .catch((e) => setLoadError((e as Error).message));
    api
      .listAlgorithms()
      .then(setAlgorithms)
      .catch((e) => setLoadError((e as Error).message));
    api.onBenchmarkProgress(setProgress);
  }, [api]);

  // The setup card renders below the full lake-entry list inside a scrolling pane,
  // so on a long list a click can land off-screen with no visible change.
  useEffect(() => {
    // jsdom (unit tests) doesn't implement scrollIntoView -- guard rather than crash.
    if (selected && typeof setupRef.current?.scrollIntoView === "function") {
      setupRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selected]);

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

  if (loadError) {
    return <Banner variant="error">Failed to load benchmark data: {loadError}</Banner>;
  }
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
          <span>{progressLabel(selectedAlgoId, progress)}</span>
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
        result.insufficientHistory ? (
          <InsufficientHistory result={result} />
        ) : (
          <ResultsView api={api} result={result} />
        )
      ) : (
        <>
          <h2>Benchmark</h2>
          <ul className="benchmark-picker">
            {entries.map((entry) => (
              <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
                <button
                  type="button"
                  className={`benchmark-picker-item${selected === entry ? " benchmark-picker-item-selected" : ""}`}
                  aria-pressed={selected === entry}
                  onClick={() => onSelectEntry(entry)}
                >
                  {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div ref={setupRef}>
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
