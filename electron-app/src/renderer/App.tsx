import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView, readinessMessage } from "./AnalysisResult";
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
  CandleInterval,
  HistoryMessage,
  InstrumentSelection,
  IntentLens,
  ReadinessResult,
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
  const [readiness, setReadiness] = useState<Extract<ReadinessResult, { ok: false }> | null>(null);
  // `result` (below) is re-derived from `sessionDetail` on every render, so a
  // freshly-run analysis that comes back blocked and a stale stored blocked turn
  // from a prior visit are indistinguishable by `result.mode` alone. This flag is
  // the one place that distinction is tracked: true only when reopening found the
  // *last stored* turn blocked but a *fresh* check now passes, so the stale one
  // must not be replayed (P13§2 decision 4 applies to a leftover failure banner
  // exactly as much as a fresh one). Reset on every new analysis and every reopen.
  const [suppressStaleBlocked, setSuppressStaleBlocked] = useState(false);

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
    // Otherwise a failure from the previous session (login or analysis) stays on
    // screen and reads as if it just happened in the brand-new one.
    setLoginError(null);
    setAnalysisError(null);
    // Same reasoning as above, for the readiness banner: it's keyed off a
    // top-level state variable, not anything scoped to the old session, so a
    // stale blocked/closed banner would otherwise render on the new one too.
    setReadiness(null);
    setSuppressStaleBlocked(false);
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
    // arrive while the mode picker or benchmark view is showing in the content pane,
    // or while a prior session's login/analysis error is still on screen.
    setShowModePicker(false);
    setShowBenchmark(false);
    setLoginError(null);
    setAnalysisError(null);
    setReadiness(null);
    setSuppressStaleBlocked(false);
    const detail = await bridge().getSession(id);
    setSessionDetail(detail);
    setActiveSession({ id: detail.id, mode: detail.response_mode });
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const rawPayload = lastUserMessage.structured_payload as { intent_lens: IntentLens; trigger?: string };
      setIntentLens(rawPayload.intent_lens);
      // A scan-originated session's stored turn is a ScanTriggerPayload (`trigger`,
      // `symbol`, `horizon` -- no `mode`, no `instrument`, no `interval`), never an
      // AnalysisRunParams. Casting it to AnalysisRunParams would silently coerce
      // `payload.mode === "engine_only"` to false via `undefined`; checked here
      // explicitly instead so that can never look like an intentional skip by luck.
      // Building a scan-appropriate readiness recheck is out of scope (P13 design).
      if ("trigger" in rawPayload) return;
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      // The gate is re-evaluated as of right now, not replayed from whenever this
      // session was last open: data and market state both move (P13§2 decision 5).
      if (payload.mode === "engine_only") {
        try {
          // A session stored before this PR's horizon->interval rewrite has no
          // `interval` field at all; fall back rather than send `undefined` on.
          const interval = payload.interval ?? "5minute";
          const fresh = await bridge().checkReadiness({ instrument: payload.instrument, interval });
          setReadiness(fresh.ok ? null : fresh);
          const lastAssistantMessage = [...detail.messages].reverse().find((m) => m.role === "assistant");
          const storedResultWasBlocked =
            (lastAssistantMessage?.structured_payload as AnalysisResult | undefined)?.mode === "engine_only_blocked";
          setSuppressStaleBlocked(fresh.ok && storedResultWasBlocked);
        } catch (error) {
          setAnalysisError((error as Error).message);
        }
      }
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

  const onAnalyze = async (instrument: InstrumentSelection, interval: CandleInterval): Promise<void> => {
    if (!activeSession) return;
    setAnalysisError(null);
    setReadiness(null);
    setSuppressStaleBlocked(false);
    try {
      await bridge().runAnalysis({ mode: "engine_only", sessionId: activeSession.id, instrument, interval, intent_lens: intentLens });
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
              {analysisError && <Banner variant="error">{analysisError}</Banner>}
              {readiness && <Banner variant="info">{readinessMessage(readiness)}</Banner>}
              {!readiness && result && !(suppressStaleBlocked && result.mode === "engine_only_blocked") && (
                <AnalysisResultView result={result} history={history} />
              )}
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
