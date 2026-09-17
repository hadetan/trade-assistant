import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import type {
  AnalysisRunParams,
  AnalysisResult,
  LoginResult,
  TraceEmitter,
  TraceEvent,
  ReadinessResult,
  ReadinessCheckParams,
  KiteSessionStatus,
} from "./rendererApi";
import type { KiteClient } from "../services/kite/kiteClient";
import type { KiteSession } from "../services/kite/kiteLogin";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import type { SidecarProgressWire } from "../services/sidecar/sidecarProtocol";
import type { AiAssistedProvider } from "../services/claude/provider";
import type { HistoryStore } from "../services/history/historyStore";
import { assembleEnvelope } from "../services/analysis/analysisEnvelope";
import { assembleWarmedEnvelope } from "../services/analysis/warmedEnvelope";
import { checkEngineOnlyReadiness } from "../services/market/readinessGate";
import { generateDeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
import { looksLikeSessionExpiry } from "../services/kite/kiteSessionState";

export { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
export type { HorizonFetchParams } from "../services/analysis/horizonFetchParams";

export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms">;
  history: Pick<HistoryStore, "appendMessage">;
  checkReadiness: typeof checkEngineOnlyReadiness;
  assembleEnvelope: typeof assembleWarmedEnvelope;
  kiteStatus: () => KiteSessionStatus;
  now?: () => Date;
}

export function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string {
  return `${params.instrument.symbol} · ${params.interval} · ${params.intent_lens}`;
}

export function describeReadiness(readiness: Extract<ReadinessResult, { ok: false }>): string {
  switch (readiness.reason) {
    case "kite_not_connected":
      return "Connect your Kite account to fetch live candles.";
    case "insufficient_history":
      return `Warming up history: ${readiness.have} of ${readiness.need} candles so far.`;
    case "market_closed":
      return `NSE is closed. Trading resumes ${new Date(readiness.nextOpenAt * 1000).toISOString()}.`;
  }
}

export async function runAnalysisRequest(
  deps: RunAnalysisDeps,
  params: Extract<AnalysisRunParams, { mode: "engine_only" }>,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "user",
    renderedText: describeEngineOnlyQuery(params),
    structuredPayload: params,
  });

  const instrumentRef = {
    symbol: params.instrument.symbol,
    exchange: params.instrument.exchange,
    segment: params.instrument.segment,
    kite_token_asof: params.instrument.instrumentToken,
  };

  const readiness = await deps.checkReadiness(
    { kiteStatus: deps.kiteStatus, kite: deps.kite, sidecar: deps.sidecar },
    {
      symbol: params.instrument.symbol,
      instrumentToken: params.instrument.instrumentToken,
      interval: params.interval,
      now,
    },
  );
  if (!readiness.ok) {
    const blocked: AnalysisResult = {
      mode: "engine_only_blocked",
      instrument: instrumentRef,
      interval: params.interval,
      readiness,
    };
    // Persisted like any other assistant turn, so reopening the session replays
    // what blocked it before the gate re-runs against right now (P13§7).
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "assistant",
      renderedText: describeReadiness(readiness),
      structuredPayload: blocked,
    });
    return blocked;
  }

  const envelope = await deps.assembleEnvelope(
    { sidecar: deps.sidecar },
    {
      trigger: "reactive",
      instrument: params.instrument,
      interval: params.interval,
      intent_lens: params.intent_lens,
    },
    readiness.warmed,
  );
  const response = generateDeterministicResponse(envelope);
  const result: AnalysisResult = {
    mode: "engine_only",
    instrument: envelope.instrument,
    interval: params.interval,
    response,
    algo_results: envelope.algo_results,
  };
  // If assembleEnvelope throws, this second write never runs — the user
  // message is left orphaned with no assistant reply, matching ordinary
  // chat-app behavior for a failed turn rather than retracting what was
  // actually asked (P5c§7.2).
  deps.history.appendMessage({
    sessionId: params.sessionId,
    role: "assistant",
    renderedText: response.text,
    structuredPayload: result,
  });
  return result;
}

export interface AiAssistedRequestDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "on" | "off">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  now?: () => Date;
}

export async function runAiAssistedRequest(
  deps: AiAssistedRequestDeps,
  params: Extract<AnalysisRunParams, { mode: "ai_assisted" }>,
  sendTrace: (event: TraceEvent) => void,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  const traceEvents: TraceEvent[] = [];
  const emit: TraceEmitter = (input) => {
    const event: TraceEvent = { requestId: params.requestId, at: (deps.now?.() ?? new Date()).toISOString(), ...input };
    traceEvents.push(event);
    sendTrace(event);
  };

  const ownedSidecarIds = new Set<number>();
  const onProgress = (p: SidecarProgressWire): void => {
    if (!ownedSidecarIds.has(p.id)) return;
    emit({ source: "sidecar", kind: p.status === "running" ? "started" : "done", detail: p.step });
  };

  try {
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "user",
      renderedText: params.query,
      structuredPayload: params,
    });
    const intake = await deps.provider.intake(params.query, { onTrace: emit });
    const { timeframe, from, to } = horizonToFetchParams(intake.horizon, now);

    deps.sidecar.on("progress", onProgress);
    let envelope;
    try {
      envelope = await assembleEnvelope(
        { kite: deps.kite, sidecar: deps.sidecar },
        {
          trigger: "reactive",
          instrument: intake.instrument,
          timeframe,
          horizon_requested: intake.horizon,
          intent_lens: params.intent_lens,
          from,
          to,
          onComputeId: (id) => ownedSidecarIds.add(id),
          onTrace: emit,
        },
      );
    } finally {
      deps.sidecar.off("progress", onProgress);
      ownedSidecarIds.clear();
    }

    const existingClaudeSessionId = deps.history.getClaudeSessionId(params.sessionId);
    const claudeSessionId = existingClaudeSessionId ?? randomUUID();
    const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
      researchNotes: intake.researchNotes,
      onTrace: emit,
      claudeSessionId,
      resumeSession: existingClaudeSessionId !== null,
    });
    // Persisted only after success: a failed first turn must never pin a
    // Claude-side session id that may not have materialized on disk (P5c§7.3).
    if (existingClaudeSessionId === null) {
      deps.history.setClaudeSessionId(params.sessionId, claudeSessionId);
    }
    const result: AnalysisResult = {
      mode: "ai_assisted",
      instrument: envelope.instrument,
      horizon: intake.horizon,
      intent_lens: params.intent_lens,
      verdict,
      narrative,
      algo_results: envelope.algo_results,
      confluence: envelope.confluence,
    };
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "assistant",
      renderedText: narrative,
      structuredPayload: result,
      trace: traceEvents,
    });
    return result;
  } catch (error) {
    // No generic run-level trace push here: every step with a TraceSource
    // (sidecar compute, each persona, the narrative streamer) already
    // emitted its own attributed error before this rethrow (P9A§12).
    throw error;
  }
}

export interface AnalysisBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  login: () => Promise<LoginResult>;
  getSession: () => KiteSession | null;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "readLakeCandles" | "listAlgorithms" | "on" | "off">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  sendTrace: (event: TraceEvent) => void;
  markNeedsLogin: () => void;
  kiteStatus: () => KiteSessionStatus;
  now?: () => Date;
}

function requireSession(getSession: () => KiteSession | null): KiteSession {
  const session = getSession();
  if (!session) throw new Error("not logged in to Kite");
  return session;
}

// A thrown Error at this point has already lost the structured MCP response
// classifyKiteResponse works from; this only re-arms the needs-login banner
// when the error's own message happens to carry a recognizable marker, so it
// never fires markNeedsLogin() on an ordinary network/sidecar failure.
function guardSessionExpiry<T>(markNeedsLogin: () => void, promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    if (looksLikeSessionExpiry(error)) markNeedsLogin();
    throw error;
  });
}

export function registerAnalysisBridge(deps: AnalysisBridgeDeps): void {
  deps.ipcMain.handle("kite:login", () => deps.login());
  deps.ipcMain.handle("kite:searchInstruments", (_event, args: { query: string }) =>
    guardSessionExpiry(deps.markNeedsLogin, requireSession(deps.getSession).kite.searchInstruments(args.query)),
  );
  deps.ipcMain.handle("analysis:checkReadiness", (_event, args: ReadinessCheckParams): Promise<ReadinessResult> =>
    checkEngineOnlyReadiness(
      { kiteStatus: deps.kiteStatus, kite: deps.getSession()?.kite ?? null, sidecar: deps.sidecar },
      {
        symbol: args.instrument.symbol,
        instrumentToken: args.instrument.instrumentToken,
        interval: args.interval,
        now: deps.now?.() ?? new Date(),
      },
    ),
  );
  deps.ipcMain.handle("analysis:run", (_event, params: AnalysisRunParams) => {
    const kite = requireSession(deps.getSession).kite;
    if (params.mode === "ai_assisted") {
      return guardSessionExpiry(
        deps.markNeedsLogin,
        runAiAssistedRequest(
          { kite, sidecar: deps.sidecar, provider: deps.provider, history: deps.history, now: deps.now },
          params,
          deps.sendTrace,
        ),
      );
    }
    return guardSessionExpiry(
      deps.markNeedsLogin,
      runAnalysisRequest(
        {
          kite,
          sidecar: deps.sidecar,
          history: deps.history,
          checkReadiness: checkEngineOnlyReadiness,
          assembleEnvelope: assembleWarmedEnvelope,
          kiteStatus: deps.kiteStatus,
          now: deps.now,
        },
        params,
      ),
    );
  });
}
