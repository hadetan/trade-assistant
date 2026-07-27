import type { IpcMain } from "electron";
import type { AnalysisRunParams, AnalysisResult, LoginResult, NarrativeEvent } from "./rendererApi";
import type { KiteClient } from "../services/kite/kiteClient";
import type { KiteSession } from "../services/kite/kiteLogin";
import type { SidecarSupervisor } from "../services/sidecar/sidecarSupervisor";
import type { AiAssistedProvider } from "../services/claude/provider";
import { assembleEnvelope } from "../services/analysis/analysisEnvelope";
import { generateDeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
import { looksLikeSessionExpiry } from "../services/kite/kiteSessionState";

export { horizonToFetchParams } from "../services/analysis/horizonFetchParams";
export type { HorizonFetchParams } from "../services/analysis/horizonFetchParams";

export interface RunAnalysisDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  now?: () => Date;
}

export async function runAnalysisRequest(
  deps: RunAnalysisDeps,
  params: Extract<AnalysisRunParams, { mode: "engine_only" }>,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
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
  return {
    mode: "engine_only",
    instrument: envelope.instrument,
    horizon: params.horizon,
    response,
    algo_results: envelope.algo_results,
  };
}

export interface AiAssistedRequestDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
  provider: AiAssistedProvider;
  now?: () => Date;
}

export async function runAiAssistedRequest(
  deps: AiAssistedRequestDeps,
  params: Extract<AnalysisRunParams, { mode: "ai_assisted" }>,
  sendNarrative: (event: NarrativeEvent) => void,
): Promise<AnalysisResult> {
  const now = deps.now?.() ?? new Date();
  try {
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
    const { verdict, narrative } = await deps.provider.completeAiAssisted(envelope, {
      researchNotes: intake.researchNotes,
      onNarrativeToken: (chunk) => sendNarrative({ requestId: params.requestId, chunk }),
    });
    sendNarrative({ requestId: params.requestId, done: true });
    return {
      mode: "ai_assisted",
      instrument: envelope.instrument,
      horizon: intake.horizon,
      intent_lens: params.intent_lens,
      verdict,
      narrative,
      algo_results: envelope.algo_results,
      confluence: envelope.confluence,
    };
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
        runAiAssistedRequest({ kite, sidecar: deps.sidecar, provider: deps.provider, now: deps.now }, params, deps.sendNarrative),
      );
    }
    return guardSessionExpiry(
      deps.markNeedsLogin,
      runAnalysisRequest({ kite, sidecar: deps.sidecar, now: deps.now }, params),
    );
  });
}
