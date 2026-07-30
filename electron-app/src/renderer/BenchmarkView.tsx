import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultCadenceForHorizon, defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { EmptyState } from "./ui/EmptyState";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import { BarChart3, Copy } from "./ui/icons";
import "./BenchmarkView.css";
import type { BenchmarkCadence, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

type BenchmarkApi = Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">;

function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fromDate(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
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
    const handle = createBenchmarkChart(container, result, setSelected);
    return () => handle.dispose();
  }, [result]);

  return (
    <div className="benchmark-results">
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
  const [selected, setSelected] = useState<LakeSymbolEntry | null>(null);
  const [cadence, setCadence] = useState<BenchmarkCadence>({ mode: "session_close" });
  const [manual, setManual] = useState(false);
  const [everyN, setEveryN] = useState(5);
  const [lookaheadBars, setLookaheadBars] = useState(5);
  const [fromTs, setFromTs] = useState(0);
  const [toTs, setToTs] = useState(0);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listLakeSymbols().then(setEntries);
  }, [api]);

  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setManual(false);
    setCadence(defaultCadenceForHorizon(entry.horizon));
    setLookaheadBars(defaultLookaheadForHorizon(entry.horizon));
    setFromTs(entry.fromTs);
    setToTs(entry.toTs);
    setResult(null);
  };

  const onToggleManual = (checked: boolean): void => {
    setManual(checked);
    if (!selected) return;
    setCadence(checked ? { mode: "manual", everyN } : defaultCadenceForHorizon(selected.horizon));
  };

  const onRun = async (): Promise<void> => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const effectiveCadence: BenchmarkCadence = manual ? { mode: "manual", everyN } : cadence;
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        cadence: effectiveCadence,
        lookaheadBars,
        fromTs,
        toTs,
      });
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (entries === null) {
    return (
      <div className="benchmark-loading">
        <Spinner /> Loading lake…
      </div>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={BarChart3} message="No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3)." />;
  }
  if (result) return <ResultsView api={api} result={result} />;

  return (
    <div className="benchmark">
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
            <p>
              Cadence: <strong>{manual ? "manual" : cadence.mode}</strong>
            </p>
            <div className="segmented-control" role="group" aria-label="Cadence mode">
              <Button type="button" variant={!manual ? "primary" : "secondary"} size="sm" aria-pressed={!manual} onClick={() => onToggleManual(false)}>
                Auto
              </Button>
              <Button type="button" variant={manual ? "primary" : "secondary"} size="sm" aria-pressed={manual} onClick={() => onToggleManual(true)}>
                Manual every-N override
              </Button>
            </div>
            {manual && (
              <label className="benchmark-field">
                Every N bars
                <TextField type="number" min={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} />
              </label>
            )}
            <label className="benchmark-field">
              Lookahead bars
              <TextField type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
            </label>
            <label className="benchmark-field">
              From
              <TextField type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(fromTs)} onChange={(e) => setFromTs(fromDate(e.target.value))} />
            </label>
            <label className="benchmark-field">
              To
              <TextField type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(toTs)} onChange={(e) => setToTs(fromDate(e.target.value))} />
            </label>
            <Button type="submit" disabled={running}>
              {running && <Spinner size={14} />} {running ? "Running…" : "Run benchmark"}
            </Button>
            {error && <Banner variant="error">{error}</Banner>}
          </form>
        </Card>
      )}
    </div>
  );
}
