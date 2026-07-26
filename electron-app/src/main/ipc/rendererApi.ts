import type { DeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import type { InstrumentRef, Verdict } from "../services/analysis/contracts";
import type { InstrumentSelection } from "../services/analysis/analysisEnvelope";
import type { AlgoResultWire, ConfluenceWire } from "../services/sidecar/sidecarProtocol";
export type { IntentLens } from "../services/analysis/contracts";
import type { IntentLens } from "../services/analysis/contracts";

export type { InstrumentSelection } from "../services/analysis/analysisEnvelope";

export type SidecarStatus = "up" | "down" | "restarting";
export type KiteSessionStatus = "authenticated" | "needsLogin" | "unknown";

export interface AppStatus {
  sidecar: SidecarStatus;
  kiteSession: KiteSessionStatus;
  driftWarning: string | null;
}

export type BannerKind = "kiteLogin" | "mcpDrift" | "sidecarDown";

export interface BannerEvent {
  kind: BannerKind;
  message: string;
}

export type Horizon = "intraday" | "positional";
export type AnalysisMode = "engine_only" | "ai_assisted";

export type AnalysisRunParams =
  | { mode: "engine_only"; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens }
  | { mode: "ai_assisted"; query: string; intent_lens: IntentLens; requestId: string };

export type AnalysisResult =
  | {
      mode: "engine_only";
      instrument: InstrumentRef;
      horizon: Horizon;
      response: DeterministicResponse;
      algo_results: AlgoResultWire[];
    }
  | {
      mode: "ai_assisted";
      instrument: InstrumentRef;
      horizon: Horizon;
      intent_lens: IntentLens;
      verdict: Verdict;
      narrative: string;
      algo_results: AlgoResultWire[];
      confluence: ConfluenceWire;
    };

export interface NarrativeEvent {
  requestId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
}

export type LoginResult = { status: "authenticated" } | { status: "error"; message: string };

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  onNarrative(handler: (event: NarrativeEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
}

export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
    onNarrative: (handler) => subscribe("analysis:narrative", handler as (payload: unknown) => void),
    login: () => invoke("kite:login") as Promise<LoginResult>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
  };
}
