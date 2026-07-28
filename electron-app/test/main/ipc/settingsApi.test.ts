import { describe, expect, it, vi } from "vitest";
import { buildSettingsApi } from "../../../src/main/ipc/settingsApi";

describe("buildSettingsApi", () => {
  it("routes each Settings channel to the right ipc name", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const api = buildSettingsApi(invoke);

    await api.getScanConfig();
    expect(invoke).toHaveBeenCalledWith("settings:getScanConfig");

    await api.setScanConfig({ enabled: true, intervalMinutes: 30 });
    expect(invoke).toHaveBeenCalledWith("settings:setScanConfig", { enabled: true, intervalMinutes: 30 });

    await api.listWatchlist();
    expect(invoke).toHaveBeenCalledWith("settings:listWatchlist");

    await api.addWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:addWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.removeWatchlistSymbol("NSE:INFY");
    expect(invoke).toHaveBeenCalledWith("settings:removeWatchlistSymbol", { symbol: "NSE:INFY" });

    await api.getAccountStatus();
    expect(invoke).toHaveBeenCalledWith("settings:getAccountStatus");

    await api.searchInstruments("infy");
    expect(invoke).toHaveBeenCalledWith("kite:searchInstruments", { query: "infy" });
  });
});
