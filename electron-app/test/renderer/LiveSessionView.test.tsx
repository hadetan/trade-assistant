// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
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
    onLiveTick: vi.fn(),
    onLiveCandleClose: vi.fn(),
    onLiveStatus: vi.fn(),
    ...overrides,
  };
}

const SESSION_PROPS = {
  sessionId: "s1",
  assistantMessageId: "m1",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  interval: "5minute" as const,
  initialCandles: [],
  initialConfluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
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
    const textNodes = Array.from(container.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && el.textContent && el.textContent.trim().length > 0,
    );
    expect(textNodes).toHaveLength(0);
  });

  it("re-renders the verdict meter's fill width after a live:candleClose event fires", () => {
    let candleCloseHandler: ((payload: { candle: unknown; confluence: { weighted_vote: number } }) => void) | undefined;
    const bridge = fakeBridge({
      onLiveCandleClose: vi.fn((handler) => {
        candleCloseHandler = handler;
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
    const tickHandlers: Array<(tick: unknown) => void> = [];
    const candleCloseHandlers: Array<(payload: unknown) => void> = [];
    const statusHandlers: Array<(status: unknown) => void> = [];
    const bridge = fakeBridge({
      onLiveTick: vi.fn((handler) => tickHandlers.push(handler)),
      onLiveCandleClose: vi.fn((handler) => candleCloseHandlers.push(handler)),
      onLiveStatus: vi.fn((handler) => statusHandlers.push(handler)),
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
});
