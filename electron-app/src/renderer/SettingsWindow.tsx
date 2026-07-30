import { useEffect, useState } from "react";
import type { AppStatus, InstrumentSelection, KiteSessionStatus, ScanConfig, ScanIntervalMinutes, SidecarStatus } from "../main/ipc/rendererApi";
import { settingsBridge } from "./settingsBridge";
import { parseInstruments } from "./instrumentParsing";
import { Card } from "./ui/Card";
import { Switch } from "./ui/Switch";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { StatusDot } from "./ui/StatusDot";
import type { StatusDotTone } from "./ui/StatusDot";
import { Banner } from "./ui/Banner";
import "./SettingsWindow.css";

const INTERVAL_OPTIONS: ScanIntervalMinutes[] = [5, 15, 30, 60];
const SEARCH_DEBOUNCE_MS = 300;

function sidecarTone(status: SidecarStatus | undefined): StatusDotTone {
  if (status === "up") return "done";
  if (status === "restarting") return "running";
  return "error";
}

function kiteTone(status: KiteSessionStatus | undefined): StatusDotTone {
  if (status === "authenticated") return "done";
  if (status === "needsLogin") return "running";
  return "error";
}

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
      <Card className="settings-section">
        <h3>Proactive scanning</h3>
        <Switch
          checked={config.enabled}
          onChange={(checked) => void applyConfig({ ...config, enabled: checked })}
          label="Enable proactive scanning"
        />
        <label className="settings-field">
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
      </Card>

      <Card className="settings-section">
        <h3>Watchlist</h3>
        <TextField
          variant="search"
          aria-label="instrument search"
          placeholder="Search instrument"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {results.length > 0 && (
          <ul className="results">
            {results.map((instrument) => (
              <li key={instrument.instrumentToken}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => setWatchlist(await settingsBridge().addWatchlistSymbol(instrument.symbol))}
                >
                  Add {instrument.symbol}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="watchlist">
          {watchlist.map((symbol) => (
            <Badge
              key={symbol}
              tone="neutral"
              onRemove={async () => setWatchlist(await settingsBridge().removeWatchlistSymbol(symbol))}
              removeLabel={`Remove ${symbol}`}
            >
              {symbol}
            </Badge>
          ))}
        </div>
      </Card>

      <Card className="settings-section">
        <h3>Account status</h3>
        <StatusDot tone={sidecarTone(status?.sidecar)} label={`Sidecar: ${status?.sidecar ?? "…"}`} />
        <StatusDot tone={kiteTone(status?.kiteSession)} label={`Kite session: ${status?.kiteSession ?? "…"}`} />
        {status?.driftWarning && <Banner variant="warning">{status.driftWarning}</Banner>}
      </Card>
    </section>
  );
}
