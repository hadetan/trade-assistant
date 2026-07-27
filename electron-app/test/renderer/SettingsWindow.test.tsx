// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsWindow } from "../../src/renderer/SettingsWindow";
import type { SettingsApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

function installSettingsBridge(overrides: Partial<SettingsApi> = {}): SettingsApi {
  const api: SettingsApi = {
    getScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    setScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    listWatchlist: vi.fn().mockResolvedValue([]),
    addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]),
    removeWatchlistSymbol: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }] }),
    ...overrides,
  };
  (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings = api;
  return api;
}

describe("SettingsWindow", () => {
  it("toggling the scan checkbox calls setScanConfig with the flipped enabled", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const checkbox = await screen.findByLabelText(/enable proactive scanning/i);
    fireEvent.click(checkbox);
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 15 });
  });

  it("changing the interval select calls setScanConfig with the new intervalMinutes", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const select = await screen.findByLabelText(/scan interval/i);
    fireEvent.change(select, { target: { value: "30" } });
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: false, intervalMinutes: 30 });
  });

  it("typing a query searches and renders results; clicking Add re-renders the watchlist from the returned array", async () => {
    const api = installSettingsBridge({ addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]) });
    render(<SettingsWindow />);
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    const addButton = await screen.findByText("Add NSE:INFY");
    fireEvent.click(addButton);
    expect(api.addWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
    await waitFor(() => expect(screen.getByText("Remove")).toBeTruthy());
  });

  it("clicking Remove calls removeWatchlistSymbol", async () => {
    const api = installSettingsBridge({ listWatchlist: vi.fn().mockResolvedValue(["NSE:INFY"]), removeWatchlistSymbol: vi.fn().mockResolvedValue([]) });
    render(<SettingsWindow />);
    const removeButton = await screen.findByText("Remove");
    fireEvent.click(removeButton);
    expect(api.removeWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
  });

  it("renders the account status fields from getAccountStatus", async () => {
    installSettingsBridge();
    render(<SettingsWindow />);
    expect(await screen.findByText(/Sidecar: up/)).toBeTruthy();
    expect(await screen.findByText(/Kite session: authenticated/)).toBeTruthy();
  });
});
