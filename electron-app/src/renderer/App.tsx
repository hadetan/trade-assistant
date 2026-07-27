import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import { ChatView, historyToChatMessages } from "./ChatView";
import { HomeScreen } from "./HomeScreen";
import { bridge } from "./bridge";
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisRunParams,
  AppStatus,
  BannerEvent,
  HistoryMessage,
  Horizon,
  InstrumentSelection,
  IntentLens,
  SessionDetail,
  SessionSummary,
} from "../main/ipc/rendererApi";

interface ActiveSession {
  id: string;
  mode: AnalysisMode;
}

function deriveEngineOnlyView(detail: SessionDetail | null): { result?: AnalysisResult; history: HistoryMessage[] } {
  const messages = detail?.messages ?? [];
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIndex === -1) return { history: messages };
  return {
    result: messages[lastAssistantIndex].structured_payload as AnalysisResult,
    history: messages.filter((_, index) => index !== lastAssistantIndex),
  };
}

export function App(): JSX.Element {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showModePicker, setShowModePicker] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [intentLens, setIntentLens] = useState<IntentLens>("buying");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    void bridge().getStatus().then(setStatus);
    void bridge().listSessions().then(setSessions);
    bridge().onBanner((banner) => {
      setBanners((prev) => [...prev, banner]);
      // markNeedsLogin only emits the banner, not a status update; re-fetch here to avoid stale
      // authenticated state after a real Kite session expiry.
      if (banner.kind === "kiteLogin") void bridge().getStatus().then(setStatus);
    });
  }, []);

  const onNewChat = (): void => setShowModePicker(true);

  const onSelectMode = async (mode: AnalysisMode): Promise<void> => {
    const session = await bridge().createSession(mode);
    setSessions((prev) => [session, ...prev]);
    setSessionDetail(null);
    setActiveSession({ id: session.id, mode });
    setShowModePicker(false);
  };

  const onOpenSession = async (id: string): Promise<void> => {
    const detail = await bridge().getSession(id);
    setSessionDetail(detail);
    setActiveSession({ id: detail.id, mode: detail.response_mode });
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      setIntentLens(payload.intent_lens);
    }
  };

  const onBackToHome = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    void bridge().listSessions().then(setSessions);
  };

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const loginResult = await bridge().login();
    setLoggingIn(false);
    if (loginResult.status === "authenticated") setStatus(await bridge().getStatus());
    else setLoginError(loginResult.message);
  };

  const onAnalyze = async (instrument: InstrumentSelection, horizon: Horizon): Promise<void> => {
    if (!activeSession) return;
    setAnalysisError(null);
    try {
      await bridge().runAnalysis({ mode: "engine_only", sessionId: activeSession.id, instrument, horizon, intent_lens: intentLens });
      setSessionDetail(await bridge().getSession(activeSession.id));
    } catch (error) {
      setAnalysisError((error as Error).message);
    }
  };

  const authenticated = status?.kiteSession === "authenticated";
  const { result, history } = deriveEngineOnlyView(sessionDetail);

  return (
    <main className="app">
      <h1>Trade Assistant</h1>
      <div className="status">
        {status ? `sidecar: ${status.sidecar} | kite: ${status.kiteSession}` : "Loading…"}
      </div>
      {activeSession !== null && (
        <button type="button" onClick={onBackToHome}>
          Home
        </button>
      )}
      <ul className="banners">
        {banners.map((banner, index) => (
          <li key={index}>
            [{banner.kind}] {banner.message}
          </li>
        ))}
      </ul>

      {activeSession === null && !showModePicker && (
        <HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={onOpenSession} />
      )}
      {activeSession === null && showModePicker && <ModePicker onSelect={onSelectMode} />}

      {activeSession !== null && !authenticated && (
        <>
          {activeSession.mode === "ai_assisted" && (
            <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
          )}
          <button type="button" onClick={onLogin} disabled={loggingIn}>
            {loggingIn ? "Logging in…" : "Login to Kite"}
          </button>
          {loginError && <div className="error">{loginError}</div>}
        </>
      )}

      {activeSession !== null && authenticated && (
        <>
          <IntentLensSelector value={intentLens} onChange={setIntentLens} />
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <div className="error">{analysisError}</div>}
              {result && <AnalysisResultView result={result} history={history} />}
            </>
          ) : (
            <>
              <p className="banner-hint">AI-Assisted needs the claude CLI authenticated — run `claude auth login`.</p>
              <ChatView
                intentLens={intentLens}
                sessionId={activeSession.id}
                initialMessages={historyToChatMessages(sessionDetail?.messages ?? [])}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
