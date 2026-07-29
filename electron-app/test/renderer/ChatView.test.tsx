// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView, historyToChatMessages } from "../../src/renderer/ChatView";
import { installBridge } from "./testBridge";
import type { HistoryMessage, TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("ChatView", () => {
  it("submits an ai_assisted run with the session id, lens and a requestId, then streams narrative tokens", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    const bridge = installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "Infy ", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "constructive.", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "done", at: "t" });
        return {
          mode: "ai_assisted",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
          horizon: "positional",
          intent_lens: "buying",
          verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
          narrative: "Infy constructive.",
          algo_results: [],
          confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
        };
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "how is infy" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(bridge.runAnalysis).toHaveBeenCalledTimes(1));
    const params = (bridge.runAnalysis as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      mode: string;
      sessionId: string;
      query: string;
      intent_lens: string;
      requestId: string;
    };
    expect(params).toMatchObject({ mode: "ai_assisted", sessionId: "sess-9", query: "how is infy", intent_lens: "buying" });
    expect(typeof params.requestId).toBe("string");
    expect(await screen.findByText(/Infy constructive\./)).toBeTruthy();
    expect(await screen.findByText(/bullish/i)).toBeTruthy();
  });

  it("ignores trace events for a stale requestId and never folds non-token events into the bubble text", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: "stale-request", source: "narrative", kind: "token", detail: "SHOULD NOT APPEAR", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "real text", at: "t" });
        // Never resolves: this test only inspects the bubble text streamed before completion.
        return new Promise(() => {});
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("real text")).toBeTruthy();
    expect(screen.queryByText(/SHOULD NOT APPEAR/)).toBeNull();
  });

  it("seeds its transcript from initialMessages so a reopened session shows prior turns", () => {
    installBridge();
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier ask", structured_payload: null, trace: null, created_at: "t0" },
      {
        role: "assistant",
        rendered_text: "earlier reply",
        structured_payload: { mode: "ai_assisted", verdict: { direction: "bearish", conviction: "low", reasoning: "x", cited_algo_ids: ["rsi"], verify_before_acting: "y" } },
        trace: null,
        created_at: "t1",
      },
    ];
    render(<ChatView intentLens="selling" sessionId="sess-9" initialMessages={historyToChatMessages(history)} />);
    expect(screen.getByText(/earlier ask/)).toBeTruthy();
    expect(screen.getByText(/earlier reply/)).toBeTruthy();
    expect(screen.getByText(/bearish/i)).toBeTruthy();
  });

  it("shows an error when the run rejects", async () => {
    installBridge({ runAnalysis: vi.fn().mockRejectedValue(new Error("claude down")) });
    render(<ChatView intentLens="selling" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/claude down/)).toBeTruthy();
  });

  it("renders an Agent Activity panel once trace events arrive, live and open by default", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        // Never resolves: only the live trace panel is under test here.
        return new Promise(() => {});
      }),
    });
    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("Agent activity")).toBeTruthy();
    expect(await screen.findByText("Intake")).toBeTruthy();
  });

  it("wires the theme toggle onto the chat-view root and flips data-theme on click", () => {
    installBridge();
    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    const section = document.querySelector(".chat-view") as HTMLElement;
    expect(section.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(section.getAttribute("data-theme")).toBe("light");
  });
});

describe("historyToChatMessages", () => {
  it("maps a null trace to an empty array and marks replayed assistant turns live: false", () => {
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace: null, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ role: "assistant", trace: [], live: false });
  });

  it("carries a persisted trace array through onto the reconstructed assistant message", () => {
    const trace: TraceEvent[] = [{ requestId: "r0", source: "intake", kind: "started", at: "t0" }];
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ trace, live: false });
  });
});
