import { describe, expect, it } from "vitest";
import { encodeRequest } from "../../../../src/main/services/sidecar/sidecarProtocol";
import type {
  ComputeResponseWire,
  ScanGateResponseWire,
  WatchlistResponseWire,
} from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("ComputeResponseWire (widened AlgoResultWire)", () => {
  it("decodes all nine AlgoOutput fields from a sidecar compute line", () => {
    const line = JSON.stringify({
      type: "compute",
      id: 7,
      algo_results: [
        {
          algo_id: "rsi",
          symbol: "NSE:INFY",
          timeframe: "day",
          horizon: "positional",
          direction: "Bullish",
          magnitude: 0.42,
          confidence: 0.61,
          evidence: ["RSI 62 > 50"],
          computed_at: "2026-07-24T00:00:00+00:00",
        },
      ],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });

    const decoded = JSON.parse(line) as ComputeResponseWire;
    const first = decoded.algo_results[0];

    expect(first.algo_id).toBe("rsi");
    expect(first.symbol).toBe("NSE:INFY");
    expect(first.timeframe).toBe("day");
    expect(first.horizon).toBe("positional");
    expect(first.direction).toBe("Bullish");
    expect(first.magnitude).toBe(0.42);
    expect(first.confidence).toBe(0.61);
    expect(first.evidence).toEqual(["RSI 62 > 50"]);
    expect(first.computed_at).toBe("2026-07-24T00:00:00+00:00");
  });
});

describe("watchlist + scan-gate wire shapes", () => {
  it("encodes the four new request tags on a single newline-terminated line", () => {
    expect(encodeRequest({ type: "add_watchlist_symbol", id: 1, symbol: "NSE:INFY" })).toBe(
      '{"type":"add_watchlist_symbol","id":1,"symbol":"NSE:INFY"}\n',
    );
    expect(encodeRequest({ type: "remove_watchlist_symbol", id: 2, symbol: "NSE:INFY" })).toBe(
      '{"type":"remove_watchlist_symbol","id":2,"symbol":"NSE:INFY"}\n',
    );
    expect(encodeRequest({ type: "list_watchlist", id: 3 })).toBe('{"type":"list_watchlist","id":3}\n');
    expect(
      encodeRequest({
        type: "evaluate_scan_gate",
        id: 4,
        symbol: "NSE:INFY",
        confluence: { bullish_count: 5, bearish_count: 2, neutral_count: 10, weighted_vote: 0.12 },
      }),
    ).toContain('"type":"evaluate_scan_gate"');
  });

  it("decodes the two new response tags", () => {
    const watchlist = JSON.parse('{"type":"watchlist","id":7,"symbols":["NSE:INFY"]}') as WatchlistResponseWire;
    expect(watchlist.type).toBe("watchlist");
    expect(watchlist.symbols).toEqual(["NSE:INFY"]);
    const gate = JSON.parse('{"type":"scan_gate","id":10,"decision":"WorthLook"}') as ScanGateResponseWire;
    expect(gate.decision).toBe("WorthLook");
  });
});
