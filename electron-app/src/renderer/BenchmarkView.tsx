import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultCadenceForHorizon, defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
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
  if (points.length === 0) return <div className="benchmark-summary">0 decision points — nothing to score.</div>;
  const hitRateLabel = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
  return (
    <div className="benchmark-summary">
      {correct} correct / {incorrect} incorrect / {neutral} neutral · hit-rate {hitRateLabel}
    </div>
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
      <button type="button" onClick={() => void api.copyBenchmarkResult(JSON.stringify(result))}>
        Copy raw result
      </button>
      <div className="benchmark-chart" ref={chartRef} />
      {selected && (
        <aside className="benchmark-popover">
          <h3>
            {selected.direction} ({selected.conviction} conviction) — {selected.outcome}
          </h3>
          <p>
            {selected.closeAtFrontier} → {selected.closeAtLookahead} ({(selected.realizedReturn * 100).toFixed(2)}%)
          </p>
          <p>algos: {selected.algoResults.map((r) => r.algo_id).join(", ")}</p>
          <MessageMarkdown text={selected.responseText} />
        </aside>
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

  if (entries === null) return <div className="benchmark">Loading lake…</div>;
  if (entries.length === 0) {
    return <div className="benchmark">No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3).</div>;
  }
  if (result) return <ResultsView api={api} result={result} />;

  return (
    <div className="benchmark">
      <h2>Benchmark</h2>
      <ul className="benchmark-picker">
        {entries.map((entry) => (
          <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
            <button type="button" onClick={() => onSelectEntry(entry)}>
              {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
            </button>
          </li>
        ))}
      </ul>

      {selected && (
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
          <label>
            <input type="checkbox" checked={manual} onChange={(e) => onToggleManual(e.target.checked)} /> Manual every-N override
          </label>
          {manual && (
            <label>
              Every N bars
              <input type="number" min={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} />
            </label>
          )}
          <label>
            Lookahead bars
            <input type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
          </label>
          <label>
            From
            <input type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(fromTs)} onChange={(e) => setFromTs(fromDate(e.target.value))} />
          </label>
          <label>
            To
            <input type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(toTs)} onChange={(e) => setToTs(fromDate(e.target.value))} />
          </label>
          <button type="submit" disabled={running}>
            {running ? "Running…" : "Run benchmark"}
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      )}
    </div>
  );
}
