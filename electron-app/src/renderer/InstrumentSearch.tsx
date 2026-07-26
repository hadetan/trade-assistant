import { useEffect, useState } from "react";
import type { Horizon, InstrumentSelection } from "../main/ipc/rendererApi";
import { bridge } from "./bridge";
import { parseInstruments } from "./instrumentParsing";

export { parseInstruments };

export interface InstrumentSearchProps {
  onSubmit: (instrument: InstrumentSelection, horizon: Horizon) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function InstrumentSearch({ onSubmit }: InstrumentSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [selected, setSelected] = useState<InstrumentSelection | null>(null);
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    // A new query invalidates whatever was selected under the old one — the
    // Analyze button must never submit an instrument that no longer matches
    // what's on screen.
    setSelected(null);
    if (query.trim().length < 2) {
      setResults([]);
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

  return (
    <section className="analysis-form">
      <input
        aria-label="instrument search"
        placeholder="Search instrument"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searchError && <div className="error">{searchError}</div>}
      <ul className="results">
        {results.map((instrument) => (
          <li key={instrument.instrumentToken}>
            <button type="button" onClick={() => setSelected(instrument)}>
              {instrument.symbol}
            </button>
          </li>
        ))}
      </ul>
      <fieldset>
        <legend>Horizon</legend>
        <label>
          <input type="radio" name="horizon" checked={horizon === "intraday"} onChange={() => setHorizon("intraday")} />
          Intraday
        </label>
        <label>
          <input type="radio" name="horizon" checked={horizon === "positional"} onChange={() => setHorizon("positional")} />
          Positional
        </label>
      </fieldset>
      <button type="button" disabled={!selected} onClick={() => selected && onSubmit(selected, horizon)}>
        Analyze {selected ? selected.symbol : ""}
      </button>
    </section>
  );
}
