import type { DeterministicResponse } from "../services/analysis/deterministicResponseGenerator";
import type { InstrumentRef, Verdict } from "../services/analysis/contracts";
import type { InstrumentSelection } from "../services/analysis/analysisEnvelope";
import type { AlgoResultWire, ConfluenceWire } from "../services/sidecar/sidecarProtocol";
export type { IntentLens, Verdict } from "../services/analysis/contracts";
import type { IntentLens } from "../services/analysis/contracts";
export type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";
import type { SessionSummary, HistoryMessage, SessionDetail } from "../services/history/historyStore";
export type { ScanConfig, ScanIntervalMinutes } from "../services/history/historyStore";

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

export type { BenchmarkCadence, Outcome, DecisionPoint, BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";
import type { BenchmarkRunParams, BenchmarkResult } from "../services/benchmark/benchmarkRunner";

export interface LakeSymbolEntry {
  symbol: string;
  timeframe: string;
  source: string;
  fromTs: number;
  toTs: number;
  candleCount: number;
  horizon: Horizon; // derived from timeframe in the bridge
}

export type AnalysisMode = "engine_only" | "ai_assisted";

export type AnalysisRunParams =
  | { mode: "engine_only"; sessionId: string; instrument: InstrumentSelection; horizon: Horizon; intent_lens: IntentLens }
  | { mode: "ai_assisted"; sessionId: string; query: string; intent_lens: IntentLens; requestId: string };

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

export type TraceSource =
  | "sidecar"
  | "intake"
  | "options_greeks"
  | "technical_quant"
  | "position_risk"
  | "synthesis"
  | "narrative";

export type TraceKind = "started" | "toolCall" | "toolResult" | "token" | "done" | "error";

export interface TraceEvent {
  requestId: string;
  source: TraceSource;
  kind: TraceKind;
  detail?: string;
  at: string; // ISO 8601, stamped at emission time
}

// Main-process-only helper types (never sent over IPC): producers emit
// unstamped inputs; the concrete emitter adds requestId + at.
export type TraceEventInput = Pick<TraceEvent, "source" | "kind"> & { detail?: string };
export type TraceEmitter = (event: TraceEventInput) => void;

export type LoginResult = { status: "authenticated" } | { status: "error"; message: string };

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
  onTrace(handler: (event: TraceEvent) => void): void;
  login(): Promise<LoginResult>;
  searchInstruments(query: string): Promise<unknown>;
  runAnalysis(params: AnalysisRunParams): Promise<AnalysisResult>;
  createSession(mode: AnalysisMode): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
  listLakeSymbols(): Promise<LakeSymbolEntry[]>;
  runBenchmark(params: BenchmarkRunParams): Promise<BenchmarkResult>;
  copyBenchmarkResult(text: string): Promise<void>;
}

export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
    onTrace: (handler) => subscribe("analysis:trace", handler as (p: unknown) => void),
    login: () => invoke("kite:login") as Promise<LoginResult>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
    runAnalysis: (params) => invoke("analysis:run", params) as Promise<AnalysisResult>,
    createSession: (mode) => invoke("history:createSession", { mode }) as Promise<SessionSummary>,
    listSessions: () => invoke("history:listSessions") as Promise<SessionSummary[]>,
    getSession: (id) => invoke("history:getSession", { id }) as Promise<SessionDetail>,
    listLakeSymbols: () => invoke("benchmark:listLakeSymbols") as Promise<LakeSymbolEntry[]>,
    runBenchmark: (params) => invoke("benchmark:runBenchmark", params) as Promise<BenchmarkResult>,
    copyBenchmarkResult: (text) => invoke("benchmark:copyToClipboard", text) as Promise<void>,
  };
}

// SettingsApi/buildSettingsApi live in ./settingsApi.ts, not here: settingsPreload.ts
// and preload.ts are separate sandboxed Electron preload bundles, and Rollup
// extracts a shared chunk for any module both entries import from — which the
// sandboxed preload loader cannot require() (see settingsApi.ts's own note).
// Keeping this a type-only re-export (erased at build time) preserves the
// existing import path for renderer/type consumers without reintroducing that
// runtime dependency edge.
export type { SettingsApi } from "./settingsApi";
