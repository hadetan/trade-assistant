import { randomUUID } from "node:crypto";
import type { SidecarSupervisor } from "./services/sidecar/sidecarSupervisor";
import type { KiteClient } from "./services/kite/kiteClient";
import type { AiAssistedProvider } from "./services/claude/provider";
import type { HistoryStore, ScanConfig } from "./services/history/historyStore";
import { resolveWatchlistInstrument } from "./services/kite/watchlistInstrumentResolver";
import { assembleEnvelope } from "./services/analysis/analysisEnvelope";
import type { AnalysisEnvelope, IntentLens } from "./services/analysis/contracts";
import { generateDeterministicResponse } from "./services/analysis/deterministicResponseGenerator";
import { horizonToFetchParams } from "./services/analysis/horizonFetchParams";
import type { AnalysisResult, Horizon } from "./ipc/rendererApi";

const SCAN_HORIZON: Horizon = "intraday";
const SCAN_INTENT_LENS: IntentLens = "buying";

export interface ScanSchedulerDeps {
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles" | "listWatchlist" | "evaluateScanGate">;
  getKite: () => KiteClient | null;
  provider: AiAssistedProvider;
  history: Pick<HistoryStore, "createSession" | "appendMessage" | "getClaudeSessionId" | "setClaudeSessionId">;
  notify: (title: string, body: string) => void;
  now?: () => Date;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

export interface ScanTriggerPayload {
  trigger: "proactive_scan";
  symbol: string;
  horizon: Horizon;
  intent_lens: IntentLens;
}

function describeScanTrigger(symbol: string): string {
  return `Proactive scan: ${symbol} · ${SCAN_HORIZON} · ${SCAN_INTENT_LENS}`;
}

export class ScanScheduler {
  private config: ScanConfig;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;

  constructor(private readonly deps: ScanSchedulerDeps, initialConfig: ScanConfig) {
    this.config = initialConfig;
    this.setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.restart();
  }

  getConfig(): ScanConfig {
    return this.config;
  }

  setConfig(config: ScanConfig): void {
    this.config = config;
    this.restart();
  }

  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  private restart(): void {
    this.stop();
    if (!this.config.enabled) return;
    this.timer = this.setIntervalFn(() => void this.tick(), this.config.intervalMinutes * 60_000);
  }

  async tick(): Promise<void> {
    // A tick slower than the interval (a large watchlist, a slow Kite call)
    // must not stack a second overlapping pass on the same symbols.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const kite = this.deps.getKite();
      // Not logged in to Kite today: wait for the next tick. The scheduler never
      // itself triggers a login flow (§8.3 keeps that user-initiated).
      if (!kite) return;
      const watchlist = await this.deps.sidecar.listWatchlist();
      // Sequential, not Promise.all: Kite's historical-data limit is 3 req/sec
      // (§5.1); one symbol fully processed before the next stays under it
      // without a dedicated rate limiter this phase doesn't need yet.
      for (const symbol of watchlist.symbols) {
        await this.tickOneSymbol(kite, symbol);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickOneSymbol(kite: KiteClient, symbol: string): Promise<void> {
    try {
      const instrument = await resolveWatchlistInstrument(kite, symbol);
      if (!instrument) {
        console.error(`scan: could not resolve a live instrument for watchlist symbol ${symbol}`);
        return;
      }
      const now = this.deps.now?.() ?? new Date();
      const { timeframe, from, to } = horizonToFetchParams(SCAN_HORIZON, now);
      const envelope = await assembleEnvelope(
        { kite, sidecar: this.deps.sidecar },
        { trigger: "proactive_scan", instrument, timeframe, horizon_requested: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS, from, to },
      );
      const gate = await this.deps.sidecar.evaluateScanGate(symbol, envelope.confluence);
      if (gate.decision === "NoChange") return;
      if (gate.decision === "WorthLook") {
        await this.recordWorthLook(symbol, envelope);
        return;
      }
      await this.recordWorthAiCall(symbol, envelope);
    } catch (error) {
      // One symbol's failure (a delisted instrument, a transient Kite error)
      // must not take the rest of this tick's watchlist down with it -- the same
      // per-unit isolation as the sidecar's own catch_unwind.
      console.error(`scan: tick failed for ${symbol}: ${(error as Error).message}`);
    }
  }

  private async recordWorthLook(symbol: string, envelope: AnalysisEnvelope): Promise<void> {
    const response = generateDeterministicResponse(envelope);
    const result: AnalysisResult = {
      mode: "engine_only",
      instrument: envelope.instrument,
      horizon: SCAN_HORIZON,
      response,
      algo_results: envelope.algo_results,
    };
    const session = this.deps.history.createSession("engine_only");
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "user",
      renderedText: describeScanTrigger(symbol),
      structuredPayload: { trigger: "proactive_scan", symbol, horizon: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS } satisfies ScanTriggerPayload,
    });
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "assistant",
      renderedText: response.text,
      structuredPayload: result,
    });
    this.deps.notify(`${symbol} — worth a look`, response.text.split("\n")[0]);
  }

  private async recordWorthAiCall(symbol: string, envelope: AnalysisEnvelope): Promise<void> {
    const session = this.deps.history.createSession("ai_assisted");
    this.deps.history.appendMessage({
      sessionId: session.id,
      role: "user",
      renderedText: describeScanTrigger(symbol),
      structuredPayload: { trigger: "proactive_scan", symbol, horizon: SCAN_HORIZON, intent_lens: SCAN_INTENT_LENS } satisfies ScanTriggerPayload,
    });
    const claudeSessionId = randomUUID();
    const { verdict, narrative } = await this.deps.provider.completeAiAssisted(envelope, {
      onNarrativeToken: () => {},
      claudeSessionId,
      resumeSession: false,
    });
    this.deps.history.setClaudeSessionId(session.id, claudeSessionId);
    const result: AnalysisResult = {
      mode: "ai_assisted",
      instrument: envelope.instrument,
      horizon: SCAN_HORIZON,
      intent_lens: SCAN_INTENT_LENS,
      verdict,
      narrative,
      algo_results: envelope.algo_results,
      confluence: envelope.confluence,
    };
    this.deps.history.appendMessage({ sessionId: session.id, role: "assistant", renderedText: narrative, structuredPayload: result });
    this.deps.notify(`${symbol} — AI take ready`, `${verdict.direction} (${verdict.conviction} conviction)`);
  }
}
