import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import type { AnalysisRunParams, AnalysisResult, LoginResult, NarrativeEvent } from "./rendererApi";
import type { KiteClient } from "../services/kite/kiteClient";
import type { KiteSession } from "../services/kite/kiteLogin";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import type { AiAssistedProvider } from "../services/claude/provider";
import type { HistoryStore } from "../services/history/historyStore";
import { assembleEnvelope } from "../services/analysis/analysisEnvelope";
import { generateDeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
import { looksLikeSessionExpiry } from "../services/kite/kiteSessionState";

export { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
export type { HorizonFetchParams } from "../services/analysis/horizonFetchParams";

export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  history: Pick<HistoryStore, "appendMessage">;
  now?: () => Date;
}

export function describeEngineOnlyQuery(params: Extract<AnalysisRunParams, { mode: "engine_only" }>): string {
  return `${params.instrument.symbol} · ${params.horizon} · ${params.intent_lens}`;
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
  const { timeframe, from, to } = horizonToFetchParams(params.horizon, now);
  const envelope = await assembleEnvelope(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      trigger: "reactive",
      instrument: params.instrument,
      timeframe,
      horizon_requested: params.horizon,
      intent_lens: params.intent_lens,
      from,
      to,
    },
  );
  const response = generateDeterministicResponse(envelope);
  const result: AnalysisResult = {
    mode: "engine_only",
    instrument: envelope.instrument,
    horizon: params.horizon,
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
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  now?: () => Date;
}

export async function runAiAssistedRequest(
  deps: AiAssistedRequestDeps,
  params: Extract<AnalysisRunParams, { mode: "ai_assisted" }>,
  sendNarrative: (event: NarrativeEvent) => void,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  try {
    deps.history.appendMessage({
      sessionId: params.sessionId,
      role: "user",
      renderedText: params.query,
      structuredPayload: params,
    });
    const intake = await deps.provider.intake(params.query);
    const { timeframe, from, to } = horizonToFetchParams(intake.horizon, now);
    const envelope = await assembleEnvelope(
      { kite: deps.kite, sidecar: deps.sidecar },
      {
        trigger: "reactive",
        instrument: intake.instrument,
        timeframe,
        horizon_requested: intake.horizon,
        intent_lens: params.intent_lens,
        from,
        to,
      },
    );
    const existingClaudeSessionId = deps.history.getClaudeSessionId(params.sessionId);
    const claudeSessionId = existingClaudeSessionId ?? randomUUID();
    const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
      researchNotes: intake.researchNotes,
      onNarrativeToken: (chunk) => sendNarrative({ requestId: params.requestId, chunk }),
      claudeSessionId,
      resumeSession: existingClaudeSessionId !== null,
    });
    // Persisted only after success: a failed first turn must never pin a
    // Claude-side session id that may not have materialized on disk (P5c§7.3).
    if (existingClaudeSessionId === null) {
      deps.history.setClaudeSessionId(params.sessionId, claudeSessionId);
    }
    sendNarrative({ requestId: params.requestId, done: true });
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
    });
    return result;
  } catch (error) {
    sendNarrative({ requestId: params.requestId, error: (error as Error).message });
    throw error;
  }
}

export interface AnalysisBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  login: () => Promise<LoginResult>;
  getSession: () => KiteSession | null;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  sendNarrative: (event: NarrativeEvent) => void;
  markNeedsLogin: () => void;
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
  deps.ipcMain.handle("analysis:run", (_event, params: AnalysisRunParams) => {
    const kite = requireSession(deps.getSession).kite;
    if (params.mode === "ai_assisted") {
      return guardSessionExpiry(
        deps.markNeedsLogin,
        runAiAssistedRequest(
          { kite, sidecar: deps.sidecar, provider: deps.provider, history: deps.history, now: deps.now },
          params,
          deps.sendNarrative,
        ),
      );
    }
    return guardSessionExpiry(
      deps.markNeedsLogin,
      runAnalysisRequest({ kite, sidecar: deps.sidecar, history: deps.history, now: deps.now }, params),
    );
  });
}
