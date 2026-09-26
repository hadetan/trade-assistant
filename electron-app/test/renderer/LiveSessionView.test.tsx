// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSessionView } from "../../src/renderer/LiveSessionView";
import { createLiveChart } from "../../src/renderer/liveChart";

vi.mock("../../src/renderer/liveChart", () => ({
  createLiveChart: vi.fn(() => ({ applyTick: vi.fn(), applyClosedCandle: vi.fn(), dispose: vi.fn() })),
}));

afterEach(cleanup);

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    startLiveSession: vi.fn().mockResolvedValue(undefined),
    stopLiveSession: vi.fn().mockResolvedValue(undefined),
    onLiveTick: vi.fn(() => vi.fn()),
    onLiveCandleClose: vi.fn(() => vi.fn()),
    onLiveStatus: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

// Captures both the handler the view registers and the unsubscribe it gets back.
function capturingSubscription<T>() {
  const handlers: ((payload: T) => void)[] = [];
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  const subscribe = vi.fn((handler: (payload: T) => void) => {
    handlers.push(handler);
    const unsubscribe = vi.fn();
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  });
  return { handlers, unsubscribes, subscribe };
}

const BASE_RESULT = {
  mode: "engine_only" as const,
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  interval: "5minute" as const,
  response: {
    direction: "bullish" as const,
    conviction: "high" as const,
    text: "Overall read: bullish.",
    confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
  },
  algo_results: [],
  initialCandles: [],
};

const SESSION_PROPS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
  initialCandles: [],
  initialConfluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
  baseResult: BASE_RESULT,
};

describe("LiveSessionView", () => {
  it("calls startLiveSession on mount with the session's params", () => {
    const bridge = fakeBridge();
    render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    expect(bridge.startLiveSession).toHaveBeenCalledWith({
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: SESSION_PROPS.instrument,
      interval: "5minute",
      baseResult: BASE_RESULT,
    });
  });

  it("calls stopLiveSession on unmount", () => {
    const bridge = fakeBridge();
    const { unmount } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    unmount();

    expect(bridge.stopLiveSession).toHaveBeenCalledTimes(1);
  });

  it("renders no prose text anywhere -- chart container and verdict meter only", () => {
    const bridge = fakeBridge();
    const { container } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    // The verdict meter itself asserts zero text content elsewhere (VerdictMeter.test.tsx);
    // this asserts the view as a whole adds nothing on top of it (no headings, no captions).
    // The connection-status dot is deliberately exempt: it labels the websocket,
    // not the market call, which is what the "no prose" rule is about.
    const statusBar = container.querySelector(".live-session-status");
    const textNodes = Array.from(container.querySelectorAll("*")).filter(
      (el) =>
        !statusBar?.contains(el) &&
        el.children.length === 0 &&
        el.textContent &&
        el.textContent.trim().length > 0,
    );
    expect(textNodes).toHaveLength(0);
  });

  it("re-renders the verdict meter's fill width after a live:candleClose event fires", () => {
    let candleCloseHandler: ((payload: { candle: unknown; confluence: { weighted_vote: number } }) => void) | undefined;
    const bridge = fakeBridge({
      onLiveCandleClose: vi.fn((handler) => {
        candleCloseHandler = handler;
        return vi.fn();
      }),
    });
    const { container } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    const fillBefore = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fillBefore.style.width).toBe("0%");

    act(() => {
      candleCloseHandler?.({
        candle: { ts: 1_758_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        confluence: { bullish_count: 3, bearish_count: 0, neutral_count: 0, weighted_vote: 0.8 },
      } as never);
    });

    const fillAfter = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fillAfter.style.width).toBe("40%");
  });

  it("does not let a stale tick/candleClose/status handler from a torn-down session touch the new chart (Finding 2)", () => {
    const tick = capturingSubscription<unknown>();
    const candleClose = capturingSubscription<unknown>();
    const status = capturingSubscription<unknown>();
    const { handlers: tickHandlers } = tick;
    const { handlers: candleCloseHandlers } = candleClose;
    const { handlers: statusHandlers } = status;
    const bridge = fakeBridge({
      onLiveTick: tick.subscribe,
      onLiveCandleClose: candleClose.subscribe,
      onLiveStatus: status.subscribe,
    });

    const { rerender } = render(<LiveSessionView {...SESSION_PROPS} sessionId="s1" bridge={bridge} />);
    const firstChart = vi.mocked(createLiveChart).mock.results[0].value as {
      applyTick: ReturnType<typeof vi.fn>;
      applyClosedCandle: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };

    // Switching sessionId re-runs the mount effect: cleanup tears down chart A
    // (registering its `disposed` flag) before chart B's handlers are registered.
    rerender(<LiveSessionView {...SESSION_PROPS} sessionId="s2" bridge={bridge} />);
    const secondChart = vi.mocked(createLiveChart).mock.results[1].value as {
      applyTick: ReturnType<typeof vi.fn>;
      applyClosedCandle: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };

    expect(firstChart.dispose).toHaveBeenCalledTimes(1);
    expect(tickHandlers).toHaveLength(2);
    expect(candleCloseHandlers).toHaveLength(2);
    expect(statusHandlers).toHaveLength(2);

    const [staleTick, staleCandleClose, staleStatus] = [tickHandlers[0], candleCloseHandlers[0], statusHandlers[0]];

    expect(() => {
      staleTick({ ts: 1, price: 100 });
      staleCandleClose({ candle: { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }, confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: -0.5 } });
      staleStatus("connected");
    }).not.toThrow();

    // The stale handlers must be permanent no-ops -- neither the disposed chart A
    // nor the live chart B should have been touched by them.
    expect(firstChart.applyTick).not.toHaveBeenCalled();
    expect(firstChart.applyClosedCandle).not.toHaveBeenCalled();
    expect(secondChart.applyTick).not.toHaveBeenCalled();
    expect(secondChart.applyClosedCandle).not.toHaveBeenCalled();
  });

  it("unsubscribes all three IPC listeners on unmount, not just flipping the disposed flag", () => {
    const tick = capturingSubscription<unknown>();
    const candleClose = capturingSubscription<unknown>();
    const status = capturingSubscription<unknown>();
    const bridge = fakeBridge({
      onLiveTick: tick.subscribe,
      onLiveCandleClose: candleClose.subscribe,
      onLiveStatus: status.subscribe,
    });

    const { unmount } = render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);
    unmount();

    expect(tick.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(candleClose.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(status.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("reflects each live:status value in the connection indicator", () => {
    const status = capturingSubscription<string>();
    const bridge = fakeBridge({ onLiveStatus: status.subscribe });
    render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    expect(screen.getByText("Live")).toBeTruthy();

    act(() => status.handlers[0]("reconnecting"));
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();

    act(() => status.handlers[0]("error"));
    expect(screen.getByText("Disconnected")).toBeTruthy();

    act(() => status.handlers[0]("connected"));
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("shows the Reconnect button only in the error state", () => {
    const status = capturingSubscription<string>();
    const bridge = fakeBridge({ onLiveStatus: status.subscribe });
    render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();

    act(() => status.handlers[0]("reconnecting"));
    expect(screen.queryByRole("button", { name: /^reconnect$/i })).toBeNull();

    act(() => status.handlers[0]("error"));
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();

    act(() => status.handlers[0]("connected"));
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });

  it("clicking Reconnect re-starts the live session with the same params", () => {
    const status = capturingSubscription<string>();
    const bridge = fakeBridge({ onLiveStatus: status.subscribe });
    render(<LiveSessionView {...SESSION_PROPS} bridge={bridge} />);

    act(() => status.handlers[0]("error"));
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));

    expect(bridge.startLiveSession).toHaveBeenCalledTimes(2);
    expect(bridge.startLiveSession).toHaveBeenNthCalledWith(2, {
      sessionId: "s1",
      assistantMessageId: "m1",
      instrument: SESSION_PROPS.instrument,
      interval: "5minute",
      baseResult: BASE_RESULT,
    });
  });
});
