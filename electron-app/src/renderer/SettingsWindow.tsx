import { useEffect, useState } from "react";
import type { AppStatus, InstrumentSelection, ScanConfig, ScanIntervalMinutes } from "../main/ipc/rendererApi";
import { settingsBridge } from "./settingsBridge";
import { parseInstruments } from "./instrumentParsing";

const INTERVAL_OPTIONS: ScanIntervalMinutes[] = [5, 15, 30, 60];
const SEARCH_DEBOUNCE_MS = 300;

export function SettingsWindow(): JSX.Element {
  const [config, setConfig] = useState<ScanConfig>({ enabled: false, intervalMinutes: 15 });
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);

  useEffect(() => {
    void settingsBridge().getScanConfig().then(setConfig);
    void settingsBridge().listWatchlist().then(setWatchlist);
    void settingsBridge().getAccountStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const parsed = parseInstruments(await settingsBridge().searchInstruments(query));
      if (!cancelled) setResults(parsed);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const applyConfig = async (next: ScanConfig): Promise<void> => {
    setConfig(next);
    await settingsBridge().setScanConfig(next);
  };

  return (
    <section className="settings">
      <fieldset>
        <legend>Proactive scanning</legend>
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => void applyConfig({ ...config, enabled: event.target.checked })}
          />
          Enable proactive scanning
        </label>
        <label>
          Interval
          <select
            aria-label="scan interval"
            value={config.intervalMinutes}
            onChange={(event) => void applyConfig({ ...config, intervalMinutes: Number(event.target.value) as ScanIntervalMinutes })}
          >
            {INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Watchlist</legend>
        <input
          aria-label="instrument search"
          placeholder="Search instrument"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="results">
          {results.map((instrument) => (
            <li key={instrument.instrumentToken}>
              <button type="button" onClick={async () => setWatchlist(await settingsBridge().addWatchlistSymbol(instrument.symbol))}>
                Add {instrument.symbol}
              </button>
            </li>
          ))}
        </ul>
        <ul className="watchlist">
          {watchlist.map((symbol) => (
            <li key={symbol}>
              {symbol}
              <button type="button" onClick={async () => setWatchlist(await settingsBridge().removeWatchlistSymbol(symbol))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Account status</legend>
        <div>Sidecar: {status?.sidecar ?? "…"}</div>
        <div>Kite session: {status?.kiteSession ?? "…"}</div>
        {status?.driftWarning && <div className="warning">{status.driftWarning}</div>}
      </fieldset>
    </section>
  );
}
