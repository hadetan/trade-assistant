import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KiteClient } from "../src/main/services/kite/kiteClient";
import { SidecarSupervisor } from "../src/main/services/sidecar/sidecarSupervisor";
import { fetchAndArchive } from "../src/main/services/kite/historicalDataArchive";

const SIDECAR = path.resolve(__dirname, "..", "..", "rust-core", "target", "debug", "sidecar");

// Recorded Kite get_historical_data payload shape (array-of-arrays candles).
// No live Kite account needed: the read wrapper's callTool is stubbed with a
// recorded response, and the real Rust binary does the persist + compute.
function recordedKite(): KiteClient {
  const closes = Array.from({ length: 20 }, (_v, i) => 100 + i);
  const candles = closes.map((close, i) => [
    `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00+0530`,
    close - 1,
    close + 1,
    close - 2,
    close,
    1000 + i,
  ]);
  return new KiteClient({ callTool: async () => ({ data: { candles } }) });
}

describe.skipIf(!existsSync(SIDECAR))("end-to-end: fetch -> archive -> compute", () => {
  it("persists live-shaped candles and returns confluence from the real sidecar", async () => {
    const lake = mkdtempSync(path.join(tmpdir(), "ta-e2e-"));
    const supervisor = new SidecarSupervisor({ binaryPath: SIDECAR, lakeRoot: lake });
    supervisor.start();

    try {
      const archived = await fetchAndArchive(
        { kite: recordedKite(), sidecar: supervisor },
        { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-20" },
      );

      expect(archived.persisted).toBe(20);

      const compute = await supervisor.compute("NSE:INFY", "day", archived.closes);
      expect(compute.type).toBe("compute");
      expect(compute.algo_results.length).toBeGreaterThan(0);
      expect(compute.algo_results.some((r) => r.algo_id === "rsi")).toBe(true);
      expect(Number.isNaN(compute.confluence.weighted_vote)).toBe(false);
    } finally {
      await supervisor.stop();
    }
  });
});
