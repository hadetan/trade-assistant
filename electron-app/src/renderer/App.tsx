import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import { ChatView } from "./ChatView";
import { bridge } from "./bridge";
import type {
  AnalysisMode,
  AnalysisResult,
  AppStatus,
  BannerEvent,
  Horizon,
  InstrumentSelection,
  IntentLens,
} from "../main/ipc/rendererApi";

export function App(): JSX.Element {
  const [mode, setMode] = useState<AnalysisMode | null>(null);
  const [intentLens, setIntentLens] = useState<IntentLens>("buying");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const onAnalyze = async (instrument: InstrumentSelection, horizon: Horizon): Promise<void> => {
    setAnalysisError(null);
    setResult(null);
    try {
      setResult(await bridge().runAnalysis({ mode: "engine_only", instrument, horizon, intent_lens: intentLens }));
    } catch (error) {
      setAnalysisError((error as Error).message);
    }
  };

  useEffect(() => {
    void bridge()
      .getStatus()
      .then(setStatus);
    bridge().onBanner((banner) => {
      setBanners((prev) => [...prev, banner]);
      // markNeedsLogin only pushes this banner — it never re-pushes status —
      // so without this, `authenticated` (derived from `status` below) would
      // stay stuck on its last value after a real mid-session expiry.
      if (banner.kind === "kiteLogin") {
        void bridge()
          .getStatus()
          .then(setStatus);
      }
    });
  }, []);

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const loginResult = await bridge().login();
    setLoggingIn(false);
    if (loginResult.status === "authenticated") setStatus(await bridge().getStatus());
    else setLoginError(loginResult.message);
  };

  const authenticated = status?.kiteSession === "authenticated";

  return (
    <main className="app">
      <h1>Trade Assistant</h1>
      <div className="status">
        {status ? `sidecar: ${status.sidecar} | kite: ${status.kiteSession}` : "Loading…"}
      </div>
      <ul className="banners">
        {banners.map((banner, index) => (
          <li key={index}>
            [{banner.kind}] {banner.message}
          </li>
        ))}
      </ul>

      {mode === null && <ModePicker onSelect={setMode} />}

      {mode !== null && !authenticated && (
        <>
          {mode === "ai_assisted" && (
            <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
          )}
          <button type="button" onClick={onLogin} disabled={loggingIn}>
            {loggingIn ? "Logging in…" : "Login to Kite"}
          </button>
          {loginError && <div className="error">{loginError}</div>}
        </>
      )}

      {mode !== null && authenticated && (
        <>
          <IntentLensSelector value={intentLens} onChange={setIntentLens} />
          {mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <div className="error">{analysisError}</div>}
              {result && <AnalysisResultView result={result} />}
            </>
          ) : (
            <>
              <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
              <ChatView intentLens={intentLens} />
            </>
          )}
        </>
      )}
    </main>
  );
}
