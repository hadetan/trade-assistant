// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { installBridge } from "./testBridge";

afterEach(cleanup);

async function startEngineOnlyChat(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
  fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
}

describe("App", () => {
  it("renders the sidecar/Kite status from the bridge", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByText(/sidecar up/i)).toBeTruthy();
    expect(screen.getByText(/kite needsLogin/i)).toBeTruthy();
  });

  it("shows New session and lists existing sessions from the bridge, with no mode picker yet", async () => {
    installBridge({
      listSessions: vi.fn().mockResolvedValue([
        { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "how is infy" },
      ]),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /new session/i })).toBeTruthy();
    expect(await screen.findByText("how is infy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /engine-only/i })).toBeNull();
  });

  it("shows the Login button after New session + mode, and no analysis form", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("creates a session with the picked mode on New session", async () => {
    const bridge = installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    await waitFor(() => expect(bridge.createSession).toHaveBeenCalledWith("ai_assisted"));
  });

  it("gates the login button behind New session + mode picker, then reflects authenticated status", async () => {
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
    expect(await screen.findByText(/kite authenticated/i)).toBeTruthy();
  });

  it("clears the kiteLogin banner once login succeeds", async () => {
    let bannerHandler: ((banner: { kind: string; message: string }) => void) | undefined;
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
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
    expect(await screen.findByText(/kite authenticated/i)).toBeTruthy();
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
        interval: "5minute",
        response: { direction: "bullish", conviction: "high", text: "Overall read: bullish.", confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } },
        algo_results: [],
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByLabelText(/selling stance/i));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /15-minute/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
        sessionId: "session-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "15minute",
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
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(await screen.findByText(/sidecar unreachable/)).toBeTruthy();
  });

  it("clears a prior analysis error when New session is chosen so it doesn't bleed into the next session", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(screen.queryByText(/sidecar unreachable/)).toBeNull();
  });

  it("clears a prior session's login error when another history row is opened", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" },
      ]),
      login: vi.fn().mockResolvedValue({ status: "error", message: "kite login failed" }),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    expect(await screen.findByText(/kite login failed/i)).toBeTruthy();

    fireEvent.click(await screen.findByText("prior ask"));
    await waitFor(() => expect(screen.queryByText(/kite login failed/i)).toBeNull());
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

  it("shows the AI-Assisted chat input after New session + AI-Assisted + login", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    expect(await screen.findByLabelText(/ask about an instrument/i)).toBeTruthy();
  });

  it("renders the blocked reason and no analysis result when a run is gated", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only_blocked",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        interval: "5minute",
        readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
      }),
      getSession: vi.fn().mockResolvedValue({
        id: "session-1",
        response_mode: "engine_only",
        messages: [
          {
            role: "assistant",
            rendered_text: "blocked",
            structured_payload: {
              mode: "engine_only_blocked",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
              interval: "5minute",
              readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
            },
          },
        ],
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(await screen.findByText(/180 of 256 candles/i)).toBeTruthy();
    expect(bridge.runAnalysis).toHaveBeenCalled();
  });

  it("re-runs the readiness gate fresh when an existing engine_only session is reopened", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "engine_only", created_at: "x", last_active_at: "x", preview: "NSE:INFY" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "engine_only",
        messages: [
          {
            role: "user",
            rendered_text: "NSE:INFY · 5minute · buying",
            structured_payload: {
              mode: "engine_only",
              sessionId: "s7",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
              interval: "5minute",
              intent_lens: "buying",
            },
          },
        ],
      }),
      checkReadiness: vi.fn().mockResolvedValue({ ok: false, reason: "kite_not_connected" }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));

    await waitFor(() =>
      expect(bridge.checkReadiness).toHaveBeenCalledWith({
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        interval: "5minute",
      }),
    );
    expect(await screen.findByText(/connect your kite account/i)).toBeTruthy();
  });

  it("shows a visible error instead of failing silently when checkReadiness rejects on reopen", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "engine_only", created_at: "x", last_active_at: "x", preview: "NSE:INFY" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "engine_only",
        messages: [
          {
            role: "user",
            rendered_text: "NSE:INFY · 5minute · buying",
            structured_payload: {
              mode: "engine_only",
              sessionId: "s7",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
              interval: "5minute",
              intent_lens: "buying",
            },
          },
        ],
      }),
      checkReadiness: vi.fn().mockRejectedValue(new Error("kite session expired")),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));

    expect(await screen.findByText(/kite session expired/i)).toBeTruthy();
  });

  it("does not replay a stale blocked message once a reopened session's fresh readiness check passes", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s8", response_mode: "engine_only", created_at: "x", last_active_at: "x", preview: "NSE:INFY" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s8",
        response_mode: "engine_only",
        messages: [
          {
            role: "user",
            rendered_text: "NSE:INFY · 5minute · buying",
            structured_payload: {
              mode: "engine_only",
              sessionId: "s8",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
              interval: "5minute",
              intent_lens: "buying",
            },
          },
          {
            role: "assistant",
            rendered_text: "blocked",
            structured_payload: {
              mode: "engine_only_blocked",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
              interval: "5minute",
              readiness: { ok: false, reason: "market_closed", nextOpenAt: 1_790_000_000 },
            },
          },
        ],
      }),
      // The session was blocked when last stored; reopening it now finds the market open.
      checkReadiness: vi.fn().mockResolvedValue({ ok: true }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));

    await waitFor(() => expect(screen.queryByText(/nse is closed/i)).toBeNull());
    expect(screen.queryByText(/nse is closed/i)).toBeNull();
  });

  it("does not suppress a fresh blocked result from a brand-new analysis after a stale-blocked reopen", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({
        id: "s9",
        response_mode: "engine_only",
        messages: [
          {
            role: "user",
            rendered_text: "NSE:INFY · 5minute · buying",
            structured_payload: {
              mode: "engine_only",
              sessionId: "s9",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
              interval: "5minute",
              intent_lens: "buying",
            },
          },
          {
            role: "assistant",
            rendered_text: "blocked",
            structured_payload: {
              mode: "engine_only_blocked",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
              interval: "5minute",
              readiness: { ok: false, reason: "market_closed", nextOpenAt: 1_790_000_000 },
            },
          },
        ],
      })
      // After the reopen, a brand-new analysis is run; the session detail refetched
      // by onAnalyze reflects a fresh (different reason) blocked result.
      .mockResolvedValue({
        id: "s9",
        response_mode: "engine_only",
        messages: [
          {
            role: "assistant",
            rendered_text: "fresh blocked",
            structured_payload: {
              mode: "engine_only_blocked",
              instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
              interval: "5minute",
              readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
            },
          },
        ],
      });

    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s9", response_mode: "engine_only", created_at: "x", last_active_at: "x", preview: "NSE:INFY (reopen)" },
      ]),
      getSession,
      // The session was blocked when last stored; reopening it now finds the market
      // open, so the stale "market closed" message is suppressed on reopen.
      checkReadiness: vi.fn().mockResolvedValue({ ok: true }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only_blocked",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        interval: "5minute",
        readiness: { ok: false, reason: "insufficient_history", have: 180, need: 256 },
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY \(reopen\)/ }));
    await waitFor(() => expect(screen.queryByText(/nse is closed/i)).toBeNull());

    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(await screen.findByText(/180 of 256 candles/i)).toBeTruthy();
  });
});
