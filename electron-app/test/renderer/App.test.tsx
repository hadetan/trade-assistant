// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { installBridge } from "./testBridge";

afterEach(cleanup);

describe("App", () => {
  it("renders the status line from the bridge", async () => {
    installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    expect(await screen.findByText(/sidecar: up \| kite: needsLogin/)).toBeTruthy();
  });

  it("shows the Login button before authentication and no analysis form", async () => {
    installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("gates the login button behind the mode picker, then reflects authenticated status", async () => {
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    expect(screen.queryByRole("button", { name: /login to kite/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite: authenticated/)).toBeTruthy();
  });

  it("shows the returned error message when login fails", async () => {
    installBridge({ login: vi.fn().mockResolvedValue({ status: "error", message: "no session" }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    expect(await screen.findByText(/no session/)).toBeTruthy();
  });

  it("runs an Engine-Only analysis with the chosen intent lens", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        horizon: "positional",
        response: {
          direction: "bullish",
          conviction: "high",
          text: "Overall read: bullish.",
          confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
        },
        algo_results: [],
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    fireEvent.click(screen.getByLabelText(/selling stance/i));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
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
    fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(await screen.findByText(/sidecar unreachable/)).toBeTruthy();
  });

  it("shows the AI-Assisted chat input after choosing AI-Assisted and logging in", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    expect(await screen.findByLabelText(/ask about an instrument/i)).toBeTruthy();
    expect(screen.getByText(/claude auth login/i)).toBeTruthy();
  });
});
