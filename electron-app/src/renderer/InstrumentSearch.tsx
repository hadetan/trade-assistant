import { useEffect, useState } from "react";
import type { Horizon, InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";

function bridge(): RendererApi {
  return (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant;
}

interface RawInstrument {
  tradingsymbol?: string;
  symbol?: string;
  exchange?: string;
  segment?: string;
  instrument_token?: number | string;
}

export function parseInstruments(raw: unknown): InstrumentSelection[] {
  const list = (raw as { data?: unknown })?.data ?? raw;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry: RawInstrument) => {
      const tradingsymbol = String(entry.tradingsymbol ?? entry.symbol ?? "");
      const exchange = String(entry.exchange ?? "");
      return {
        symbol: exchange && tradingsymbol ? `${exchange}:${tradingsymbol}` : tradingsymbol,
        exchange,
        segment: String(entry.segment ?? ""),
        instrumentToken: String(entry.instrument_token ?? ""),
      };
    })
    .filter((instrument) => instrument.symbol.length > 0);
}

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
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchError(null);
      try {
        setResults(parseInstruments(await bridge().searchInstruments(query)));
      } catch (error) {
        setSearchError((error as Error).message);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
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
