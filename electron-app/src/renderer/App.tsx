import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import { ChatView, historyToChatMessages } from "./ChatView";
import { BenchmarkView } from "./BenchmarkView";
import { AppShell } from "./AppShell";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import { MessageSquare, LogIn } from "./ui/icons";
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
  const [showBenchmark, setShowBenchmark] = useState(false);
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

  // "New session" (renamed from "New Chat", P10§4.2) is now always visible in the
  // sidebar rather than gated behind a dedicated Home screen, so it must reset
  // every other top-level view flag itself instead of relying on them already
  // being false.
  const onNewSession = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowBenchmark(false);
    setShowModePicker(true);
    void bridge().listSessions().then(setSessions);
  };

  const onOpenBenchmark = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowModePicker(false);
    setShowBenchmark(true);
  };

  const onSelectMode = async (mode: AnalysisMode): Promise<void> => {
    const session = await bridge().createSession(mode);
    setSessions((prev) => [session, ...prev]);
    setSessionDetail(null);
    setActiveSession({ id: session.id, mode });
    setShowModePicker(false);
  };

  const onOpenSession = async (id: string): Promise<void> => {
    // The sidebar (and its history rows) is now always visible, so a click here can
    // arrive while the mode picker or benchmark view is showing in the content pane.
    setShowModePicker(false);
    setShowBenchmark(false);
    const detail = await bridge().getSession(id);
    setSessionDetail(detail);
    setActiveSession({ id: detail.id, mode: detail.response_mode });
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      setIntentLens(payload.intent_lens);
    }
  };

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const loginResult = await bridge().login();
    setLoggingIn(false);
    if (loginResult.status === "authenticated") {
      setStatus(await bridge().getStatus());
      setBanners((prev) => prev.filter((banner) => banner.kind !== "kiteLogin"));
    } else {
      setLoginError(loginResult.message);
    }
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
    <AppShell
      status={status}
      banners={banners}
      sessions={sessions}
      activeSessionId={activeSession?.id ?? null}
      benchmarkActive={showBenchmark}
      onNewSession={onNewSession}
      onOpenSession={(id) => void onOpenSession(id)}
      onOpenBenchmark={onOpenBenchmark}
    >
      {activeSession === null && showModePicker && <ModePicker onSelect={(mode) => void onSelectMode(mode)} />}
      {activeSession === null && showBenchmark && <BenchmarkView api={bridge()} />}
      {activeSession === null && !showModePicker && !showBenchmark && (
        <div className="app-empty-state-wrap">
          <EmptyState icon={MessageSquare} message="Select New session to start, or reopen a session from the sidebar." />
        </div>
      )}

      {activeSession !== null && !authenticated && (
        <div className="app-empty-state-wrap">
          <div className="kite-login-prompt">
            <LogIn className="kite-login-icon" size={40} aria-hidden="true" />
            <p className="kite-login-message">Connect your Kite account to fetch live quotes and run analysis.</p>
            <Button className="kite-login-button" onClick={() => void onLogin()} disabled={loggingIn}>
              {loggingIn && <Spinner size={16} />} {loggingIn ? "Logging in…" : "Login to Kite"}
            </Button>
            {loginError && <Banner variant="error">{loginError}</Banner>}
          </div>
        </div>
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
            <ChatView
              intentLens={intentLens}
              sessionId={activeSession.id}
              initialMessages={historyToChatMessages(sessionDetail?.messages ?? [])}
            />
          )}
        </>
      )}
    </AppShell>
  );
}
