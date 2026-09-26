import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRunner } from "../../../../src/main/services/market/liveSessionRunner";

function baseDeps() {
  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const ticker = {
    subscribe: vi.fn(),
    onTick: vi.fn((h: (ticks: unknown[]) => void) => tickHandlers.push(h)),
    onConnectionChange: vi.fn(),
  };
  const sidecar = {
    persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 1 }),
    compute: vi.fn().mockResolvedValue({
      type: "compute",
      id: 2,
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.5 },
    }),
  };
  const history = { updateMessage: vi.fn() };
  const sendTick = vi.fn();
  const sendCandleClose = vi.fn();
  const sendStatus = vi.fn();

  return {
    tickHandlers,
    ticker,
    sidecar,
    history,
    sendTick,
    sendCandleClose,
    sendStatus,
    deps: { ticker, sidecar, history, sendTick, sendCandleClose, sendStatus },
  };
}

const START_PARAMS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
};

describe("createLiveSessionRunner", () => {
  it("start() subscribes the ticker to the instrument token in full mode and wires connection status", () => {
    const { deps, ticker, sendStatus } = baseDeps();
    const runner = createLiveSessionRunner(deps);

    runner.start(START_PARAMS);

    expect(ticker.subscribe).toHaveBeenCalledWith([408065], "full");
    expect(ticker.onConnectionChange).toHaveBeenCalled();
    const statusHandler = ticker.onConnectionChange.mock.calls[0][0] as (s: string) => void;
    statusHandler("reconnecting");
    expect(sendStatus).toHaveBeenCalledWith("reconnecting");
  });

  it("forwards every tick's price/timestamp via sendTick", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);

    tickHandlers[0]([{ instrument_token: 408065, last_price: 101.5, exchange_timestamp: "2026-09-26T09:15:03+05:30" }]);

    expect(sendTick).toHaveBeenCalledWith({ ts: expect.any(Number), price: 101.5 });
  });

  it("on a closed candle, persists it, recomputes, updates history, and pushes the result -- in that order", async () => {
    const { deps, tickHandlers, sidecar, history, sendCandleClose } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);

    const order: string[] = [];
    sidecar.persistCandles.mockImplementation(async () => {
      order.push("persist");
      return { type: "persist_candles", id: 1, written: 1 };
    });
    sidecar.compute.mockImplementation(async () => {
      order.push("compute");
      return {
        type: "compute",
        id: 2,
        algo_results: [],
        confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
      };
    });
    history.updateMessage.mockImplementation(() => order.push("history"));

    // First tick opens the forming candle; a tick ~5 minutes later closes it.
    tickHandlers[0]([{ instrument_token: 408065, last_price: 100, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);
    tickHandlers[0]([{ instrument_token: 408065, last_price: 102, exchange_timestamp: "2026-09-26T09:20:00+05:30" }]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the async close handler settle

    expect(order).toEqual(["persist", "compute", "history"]);
    expect(sidecar.persistCandles).toHaveBeenCalledWith(
      "NSE:INFY",
      "5minute",
      [expect.objectContaining({ open: 100, close: 100 })],
      "kite",
    );
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "5minute", "intraday", [
      expect.objectContaining({ open: 100, close: 100 }),
    ]);
    expect(history.updateMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      renderedText: "",
      structuredPayload: {
        algo_results: [],
        confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
      },
    });
    expect(sendCandleClose).toHaveBeenCalledWith({
      candle: expect.objectContaining({ open: 100, close: 100 }),
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
    });
  });

  it("stop() unsubscribes and further ticks are ignored", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.stop();

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    expect(sendTick).not.toHaveBeenCalled();
  });

  it("starting a new session while one is running stops the previous one first", () => {
    const { deps, tickHandlers, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.start({ ...START_PARAMS, sessionId: "s2", assistantMessageId: "m2" });

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);
    tickHandlers[1]([{ instrument_token: 408065, last_price: 111, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    // Only the second (current) session's tick handler is live; the first
    // session's handler was registered before stop() but the runner's
    // internal "active session" guard drops ticks routed to a stale handler.
    expect(sendTick).toHaveBeenCalledTimes(1);
    expect(sendTick).toHaveBeenCalledWith({ ts: expect.any(Number), price: 111 });
  });
});
