import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRunner } from "../../../../src/main/services/market/liveSessionRunner";

// Stands in for the warm-up history already sitting in the shared "kite" lake
// partition: the runner must hand *this* to compute(), not just the one bar
// that closed, or rust-core's required_lookback filter drops every algorithm.
// Deliberately smaller than LAKE_HISTORY.length (60): the runner must bound
// the lake read down to this many bars before calling compute(), matching
// analyze-time's assembleWarmedEnvelope window sizing exactly.
const REQUIRED_BARS = 20;

const LAKE_HISTORY = Array.from({ length: 60 }, (_, index) => ({
  ts: 1_758_000_000 + index * 300,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100.5 + index,
  volume: 1_000 + index,
}));

function baseDeps() {
  // Every handler ever registered, kept indefinitely so a test can still fire a
  // handler the runner has since unsubscribed (the generation guard must keep
  // those inert too). The unsubscribe spies are what prove the removal happened.
  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const tickUnsubscribes: ReturnType<typeof vi.fn>[] = [];
  const connectionUnsubscribes: ReturnType<typeof vi.fn>[] = [];
  const ticker = {
    subscribe: vi.fn(),
    onTick: vi.fn((h: (ticks: unknown[]) => void) => {
      tickHandlers.push(h);
      const unsubscribe = vi.fn();
      tickUnsubscribes.push(unsubscribe);
      return unsubscribe;
    }),
    onConnectionChange: vi.fn(() => {
      const unsubscribe = vi.fn();
      connectionUnsubscribes.push(unsubscribe);
      return unsubscribe;
    }),
  };
  const sidecar = {
    persistCandles: vi.fn().mockResolvedValue({ type: "persist_candles", id: 1, written: 1 }),
    readLakeCandles: vi.fn().mockResolvedValue({ type: "lake_candles", id: 3, candles: LAKE_HISTORY }),
    // Sized so requiredBarsFor resolves to REQUIRED_BARS (20), well under
    // LAKE_HISTORY's 60 -- proves the runner bounds the lake read before
    // handing it to compute(), not just that some array reaches compute().
    listAlgorithms: vi.fn().mockResolvedValue({
      type: "algorithms",
      id: 4,
      algorithms: [{ id: "rsi", cost: "fast", required_lookback: REQUIRED_BARS }],
    }),
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
    tickUnsubscribes,
    connectionUnsubscribes,
    ticker,
    sidecar,
    history,
    sendTick,
    sendCandleClose,
    sendStatus,
    deps: { ticker, sidecar, history, sendTick, sendCandleClose, sendStatus },
  };
}

const BASE_RESULT = {
  mode: "engine_only" as const,
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  interval: "5minute" as const,
  response: {
    direction: "bullish" as const,
    conviction: "high" as const,
    text: "Overall read: bullish.",
    confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
  },
  algo_results: [
    {
      algo_id: "rsi",
      symbol: "NSE:INFY",
      timeframe: "5minute",
      horizon: "intraday",
      direction: "bullish",
      magnitude: 0.7,
      confidence: 0.8,
      evidence: ["analyze-time"],
      computed_at: "2026-09-26T09:15:00Z",
    },
  ],
  initialCandles: [],
};

const START_PARAMS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
  baseResult: BASE_RESULT,
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
    tickHandlers[0]([
      { instrument_token: 408065, last_price: 100, volume_traded: 1_000_000, exchange_timestamp: "2026-09-26T09:15:00+05:30" },
    ]);
    tickHandlers[0]([
      { instrument_token: 408065, last_price: 102, volume_traded: 1_000_450, exchange_timestamp: "2026-09-26T09:20:00+05:30" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the async close handler settle

    expect(order).toEqual(["persist", "compute", "history"]);
    expect(sidecar.persistCandles).toHaveBeenCalledWith(
      "NSE:INFY",
      "5minute",
      // volume is the delta in Kite's day-cumulative volume_traded, never a
      // hardcoded 0 -- this writes the lake partition every later analysis and
      // every volume-sensitive algorithm reads from.
      [expect.objectContaining({ open: 100, close: 100, volume: 450 })],
      "kite",
    );
    // The runner reads the whole accumulated lake history back -- with a
    // single candle rust-core's lookback filter qualifies zero algorithms and
    // the verdict meter would sit at neutral forever -- but must then bound it
    // down to requiredBars before calling compute(), the same window analyze-time's
    // assembleWarmedEnvelope uses, or path-dependent indicators (Wilder smoothing,
    // GARCH, MA state) disagree across window sizes and the verdict meter jumps
    // for reasons unrelated to the market.
    expect(sidecar.readLakeCandles).toHaveBeenCalledWith("NSE:INFY", "5minute", "kite");
    expect(sidecar.compute).toHaveBeenCalledWith(
      "NSE:INFY",
      "5minute",
      "intraday",
      LAKE_HISTORY.slice(LAKE_HISTORY.length - REQUIRED_BARS),
    );
    expect((sidecar.compute.mock.calls[0][3] as unknown[]).length).toBe(REQUIRED_BARS);
    // A complete AnalysisResult, not a bare {algo_results, confluence}: App.tsx
    // reads this row back as one on reopen.
    expect(history.updateMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      messageId: "m1",
      renderedText: "Overall read: bullish.",
      structuredPayload: {
        ...BASE_RESULT,
        algo_results: [],
        response: {
          ...BASE_RESULT.response,
          confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
        },
      },
    });
    expect(sendCandleClose).toHaveBeenCalledWith({
      candle: expect.objectContaining({ open: 100, close: 100 }),
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 0.3 },
    });
  });

  it("stop() unsubscribes and further ticks are ignored", () => {
    const { deps, tickHandlers, tickUnsubscribes, connectionUnsubscribes, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.stop();

    // The listener is actually off the ticker, not merely inert: the ticker
    // outlives every session, so a generation guard alone leaks one tick and
    // one connection handler per start() for the life of the process.
    expect(tickUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(connectionUnsubscribes[0]).toHaveBeenCalledTimes(1);

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    expect(sendTick).not.toHaveBeenCalled();
  });

  it("stop() is idempotent and does not re-run an already-spent unsubscribe", () => {
    const { deps, tickUnsubscribes, connectionUnsubscribes } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.stop();
    runner.stop();

    expect(tickUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(connectionUnsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("starting a new session while one is running stops the previous one first", () => {
    const { deps, tickHandlers, tickUnsubscribes, connectionUnsubscribes, sendTick } = baseDeps();
    const runner = createLiveSessionRunner(deps);
    runner.start(START_PARAMS);
    runner.start({ ...START_PARAMS, sessionId: "s2", assistantMessageId: "m2" });

    expect(tickUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(connectionUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(tickUnsubscribes[1]).not.toHaveBeenCalled();

    tickHandlers[0]([{ instrument_token: 408065, last_price: 999, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);
    tickHandlers[1]([{ instrument_token: 408065, last_price: 111, exchange_timestamp: "2026-09-26T09:15:00+05:30" }]);

    // Only the second (current) session's tick handler is live; the first
    // session's handler was registered before stop() but the runner's
    // internal "active session" guard drops ticks routed to a stale handler.
    expect(sendTick).toHaveBeenCalledTimes(1);
    expect(sendTick).toHaveBeenCalledWith({ ts: expect.any(Number), price: 111 });
  });
});
