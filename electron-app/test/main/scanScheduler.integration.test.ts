import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanScheduler, type ScanSchedulerDeps } from "../../src/main/scanScheduler";
import { HistoryStore } from "../../src/main/services/history/historyStore";
import { historicalResponse } from "../fixtures/sidecarFixtures";

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-scan-"));
  tempDirs.push(dir);
  return path.join(dir, "history.sqlite3");
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function computeResult() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "5minute", horizon: "intraday", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-27T00:00:00+00:00" },
    ],
    confluence: { bullish_count: 8, bearish_count: 1, neutral_count: 2, weighted_vote: 0.5 },
  };
}

function makeDeps(history: HistoryStore, decision: "WorthLook" | "WorthAiCall"): ScanSchedulerDeps {
  const kite = {
    searchInstruments: vi.fn(async (q: string) => ({ data: [{ tradingsymbol: q, exchange: "NSE", segment: "NSE", instrument_token: 408065 }] })),
    getHistoricalData: vi.fn(async () => historicalResponse()),
  };
  const sidecar = {
    compute: vi.fn(async () => computeResult()),
    persistCandles: vi.fn(async (_s: string, _t: string, candles: { length: number }) => ({ type: "persist_candles" as const, id: 1, written: candles.length })),
    listWatchlist: vi.fn(async () => ({ type: "watchlist" as const, id: 1, symbols: ["NSE:INFY"] })),
    evaluateScanGate: vi.fn(async () => ({ type: "scan_gate" as const, id: 1, decision })),
  };
  const provider = {
    intake: vi.fn(),
    completeAiAssisted: vi.fn(async () => ({
      verdict: { direction: "bullish", conviction: "high", reasoning: "r", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
      narrative: "Infy looks constructive.",
    })),
  };
  return {
    sidecar: sidecar as unknown as ScanSchedulerDeps["sidecar"],
    getKite: () => kite as unknown as ReturnType<ScanSchedulerDeps["getKite"]>,
    provider: provider as unknown as ScanSchedulerDeps["provider"],
    history,
    notify: vi.fn(),
    now: () => new Date("2026-07-27T10:00:00Z"),
    setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
    clearIntervalFn: () => {},
  };
}

describe("ScanScheduler composed with a real HistoryStore", () => {
  it("a WorthLook tick persists a real engine_only session with a proactive_scan trigger", async () => {
    const history = new HistoryStore({ path: tempDbPath() });
    const scheduler = new ScanScheduler(makeDeps(history, "WorthLook"), history.getScanConfig());
    await scheduler.tick();

    const sessions = history.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].response_mode).toBe("engine_only");
    const detail = history.getSession(sessions[0].id);
    expect(detail?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0].structured_payload).toEqual({ trigger: "proactive_scan", symbol: "NSE:INFY", horizon: "intraday", intent_lens: "buying" });
    history.close();
  });

  it("a WorthAiCall tick persists a real ai_assisted session and pins a claude_session_id", async () => {
    const history = new HistoryStore({ path: tempDbPath() });
    const scheduler = new ScanScheduler(makeDeps(history, "WorthAiCall"), history.getScanConfig());
    await scheduler.tick();

    const sessions = history.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].response_mode).toBe("ai_assisted");
    expect(history.getClaudeSessionId(sessions[0].id)).not.toBeNull();
    history.close();
  });
});
