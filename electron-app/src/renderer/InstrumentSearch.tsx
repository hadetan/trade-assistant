import { useEffect, useState } from "react";
import type { Horizon, InstrumentSelection } from "../main/ipc/rendererApi";
import { bridge } from "./bridge";
import { parseInstruments } from "./instrumentParsing";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import "./InstrumentSearch.css";

export { parseInstruments };

export interface InstrumentSearchProps {
  onSubmit: (instrument: InstrumentSelection, horizon: Horizon) => void | Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;
const HORIZON_LABEL: Record<Horizon, string> = { intraday: "Intraday", positional: "Positional" };
const HORIZONS: Horizon[] = ["intraday", "positional"];

export function InstrumentSearch({ onSubmit }: InstrumentSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [selected, setSelected] = useState<InstrumentSelection | null>(null);
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    // A new query invalidates whatever was selected under the old one — the
    // Analyze button must never submit an instrument that no longer matches
    // what's on screen.
    setSelected(null);
    if (query.trim().length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchError(null);
      try {
        const parsed = parseInstruments(await bridge().searchInstruments(query));
        if (!cancelled) setResults(parsed);
      } catch (error) {
        if (!cancelled) setSearchError((error as Error).message);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const onAnalyzeClick = async (): Promise<void> => {
    if (!selected || running) return;
    setRunning(true);
    try {
      await onSubmit(selected, horizon);
    } catch {
      // A run failure is the caller's own state to own and surface (App renders it
      // via a Banner keyed off its analysisError) — this catch exists only so a
      // rejected onSubmit never escapes as an unhandled rejection from this
      // fire-and-forget onClick handler.
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="analysis-form">
      <TextField
        variant="search"
        aria-label="instrument search"
        placeholder="Search instrument"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searchError && <Banner variant="error">{searchError}</Banner>}
      {results.length > 0 && (
        <ul className="instrument-results">
          {results.map((instrument) => (
            <li key={instrument.instrumentToken}>
              <button
                type="button"
                className={`instrument-result${selected?.instrumentToken === instrument.instrumentToken ? " instrument-result-selected" : ""}`}
                onClick={() => setSelected(instrument)}
              >
                {instrument.symbol}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="horizon-toggle" role="group" aria-label="Horizon">
        {HORIZONS.map((value) => (
          <Button
            key={value}
            variant={horizon === value ? "primary" : "secondary"}
            size="sm"
            aria-pressed={horizon === value}
            onClick={() => setHorizon(value)}
          >
            {HORIZON_LABEL[value]}
          </Button>
        ))}
      </div>
      <Button disabled={!selected || running} onClick={() => void onAnalyzeClick()}>
        {running && <Spinner size={14} />} Analyze {selected ? selected.symbol : ""}
      </Button>
    </section>
  );
}
