import type { DeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import type { InstrumentRef } from "../services/analysis/contracts";
import type { AlgoResultWire } from "../services/sidecar/sidecarProtocol";

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

export interface InstrumentSelection {
  symbol: string;
  exchange: string;
  segment: string;
  instrumentToken: string;
}

export interface AnalysisRunParams {
  instrument: InstrumentSelection;
  horizon: Horizon;
}

export interface AnalysisResult {
  mode: "engine_only";
  instrument: InstrumentRef;
  horizon: Horizon;
  response: DeterministicResponse;
  algo_results: AlgoResultWire[];
}

export type LoginResult = { status: "authenticated" } | { status: "error"; message: string };

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
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
    login: () => invoke("kite:login") as Promise<LoginResult>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
  };
}
