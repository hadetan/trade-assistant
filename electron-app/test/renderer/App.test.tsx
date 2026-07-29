// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { installBridge } from "./testBridge";

afterEach(cleanup);

async function startEngineOnlyChat(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
  fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
}

describe("App", () => {
  it("renders the status line from the bridge", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByText(/sidecar: up \| kite: needsLogin/)).toBeTruthy();
  });

  it("shows Home first and lists existing sessions from the bridge", async () => {
    installBridge({
      listSessions: vi.fn().mockResolvedValue([
        { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "how is infy" },
      ]),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /new chat/i })).toBeTruthy();
    expect(await screen.findByText("how is infy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /engine-only/i })).toBeNull();
  });

  it("shows the Login button after New Chat + mode, and no analysis form", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("creates a session with the picked mode on New Chat", async () => {
    const bridge = installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    await waitFor(() => expect(bridge.createSession).toHaveBeenCalledWith("ai_assisted"));
  });

  it("gates the login button behind Home + mode picker, then reflects authenticated status", async () => {
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    expect(screen.queryByRole("button", { name: /login to kite/i })).toBeNull();
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite: authenticated/)).toBeTruthy();
  });

  it("clears the kiteLogin banner once login succeeds", async () => {
    let bannerHandler: ((banner: { kind: string; message: string }) => void) | undefined;
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        // The banner's own reactive re-fetch (App.tsx's onBanner handler) consumes
        // this second value before the login button is ever clicked.
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      onBanner: vi.fn((handler) => {
        bannerHandler = handler;
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    await waitFor(() => expect(bannerHandler).toBeTruthy());

    bannerHandler?.({ kind: "kiteLogin", message: "Kite needs login today." });
    expect(await screen.findByText(/kite needs login today/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite: authenticated/)).toBeTruthy();
    expect(screen.queryByText(/kite needs login today/i)).toBeNull();
  });

  it("runs an Engine-Only analysis with the session id and chosen intent lens", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        horizon: "positional",
        response: { direction: "bullish", conviction: "high", text: "Overall read: bullish.", confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } },
        algo_results: [],
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByLabelText(/selling stance/i));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
        sessionId: "session-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
        intent_lens: "selling",
      }),
    );
  });

  it("shows an error message when analysis fails instead of failing silently", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockRejectedValue(new Error("sidecar unreachable")),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(await screen.findByText(/sidecar unreachable/)).toBeTruthy();
  });

  it("reopens an ai_assisted session, replays its transcript, and seeds the last-used lens", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "ai_assisted",
        messages: [
          { role: "user", rendered_text: "prior ask", structured_payload: { mode: "ai_assisted", sessionId: "s7", query: "prior ask", intent_lens: "selling", requestId: "r0" }, created_at: "t0" },
          { role: "assistant", rendered_text: "prior reply", structured_payload: { mode: "ai_assisted" }, created_at: "t1" },
        ],
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    expect(await screen.findByText(/prior reply/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/selling stance/i) as HTMLInputElement).checked).toBe(true));
  });

  it("continues a reopened ai_assisted session with the same session id", async () => {
    const runAnalysis = vi.fn().mockResolvedValue({
      mode: "ai_assisted",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon: "positional",
      intent_lens: "selling",
      verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "x" },
      narrative: "fresh reply",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      runAnalysis,
      listSessions: vi.fn().mockResolvedValue([{ id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" }]),
      getSession: vi.fn().mockResolvedValue({ id: "s7", response_mode: "ai_assisted", messages: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    fireEvent.change(await screen.findByLabelText(/ask about an instrument/i), { target: { value: "next turn" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(runAnalysis).toHaveBeenCalledTimes(1));
    expect((runAnalysis.mock.calls[0][0] as { sessionId: string }).sessionId).toBe("s7");
  });

  it("shows the AI-Assisted chat input after New Chat + AI-Assisted + login", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    expect(await screen.findByLabelText(/ask about an instrument/i)).toBeTruthy();
  });
});
