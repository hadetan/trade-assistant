// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView, historyToChatMessages } from "../../src/renderer/ChatView";
import { installBridge } from "./testBridge";
import type { HistoryMessage, NarrativeEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

describe("ChatView", () => {
  it("submits an ai_assisted run with the session id, lens and a requestId, then streams tokens", async () => {
    let narrativeHandler: ((event: NarrativeEvent) => void) | undefined;
    const bridge = installBridge({
      onNarrative: vi.fn((handler) => {
        narrativeHandler = handler as (event: NarrativeEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        narrativeHandler?.({ requestId: params.requestId, chunk: "Infy " });
        narrativeHandler?.({ requestId: params.requestId, chunk: "constructive." });
        narrativeHandler?.({ requestId: params.requestId, done: true });
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

  it("seeds its transcript from initialMessages so a reopened session shows prior turns", () => {
    installBridge({ onNarrative: vi.fn(), runAnalysis: vi.fn() });
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier ask", structured_payload: null, created_at: "t0" },
      {
        role: "assistant",
        rendered_text: "earlier reply",
        structured_payload: { mode: "ai_assisted", verdict: { direction: "bearish", conviction: "low", reasoning: "x", cited_algo_ids: ["rsi"], verify_before_acting: "y" } },
        created_at: "t1",
      },
    ];
    render(<ChatView intentLens="selling" sessionId="sess-9" initialMessages={historyToChatMessages(history)} />);
    expect(screen.getByText(/earlier ask/)).toBeTruthy();
    expect(screen.getByText(/earlier reply/)).toBeTruthy();
    expect(screen.getByText(/bearish/i)).toBeTruthy();
  });

  it("shows an error when the run rejects", async () => {
    installBridge({ onNarrative: vi.fn(), runAnalysis: vi.fn().mockRejectedValue(new Error("claude down")) });
    render(<ChatView intentLens="selling" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/claude down/)).toBeTruthy();
  });
});
