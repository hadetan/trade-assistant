import { describe, expect, it, vi } from "vitest";
import { registerSettingsBridge } from "../../../src/main/ipc/settingsBridge";

function harness(deps: {
  history: { getScanConfig: ReturnType<typeof vi.fn>; setScanConfig: ReturnType<typeof vi.fn> };
  scanScheduler: { setConfig: ReturnType<typeof vi.fn> };
  sidecar: { listWatchlist: ReturnType<typeof vi.fn>; addWatchlistSymbol: ReturnType<typeof vi.fn>; removeWatchlistSymbol: ReturnType<typeof vi.fn> };
  getStatus: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
  registerSettingsBridge({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn as never) } as never,
    history: deps.history as never,
    scanScheduler: deps.scanScheduler as never,
    sidecar: deps.sidecar as never,
    getStatus: deps.getStatus,
  });
  return handlers;
}

describe("registerSettingsBridge", () => {
  it("returns the current config for settings:getScanConfig", () => {
    const config = { enabled: false, intervalMinutes: 15 };
    const handlers = harness({
      history: { getScanConfig: vi.fn().mockReturnValue(config), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn(),
    });
    expect(handlers.get("settings:getScanConfig")!(null, undefined)).toBe(config);
  });

  it("settings:setScanConfig persists, applies to the scheduler, and returns the freshly-read config", () => {
    const setScanConfig = vi.fn();
    const getScanConfig = vi.fn().mockReturnValue({ enabled: true, intervalMinutes: 30 });
    const setConfig = vi.fn();
    const handlers = harness({
      history: { getScanConfig, setScanConfig },
      scanScheduler: { setConfig },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn(),
    });
    const result = handlers.get("settings:setScanConfig")!(null, { enabled: true, intervalMinutes: 30 });
    expect(setScanConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 30 });
    expect(setConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 30 });
    expect(result).toEqual({ enabled: true, intervalMinutes: 30 });
  });

  it("unwraps .symbols from the sidecar for list/add/remove", async () => {
    const handlers = harness({
      history: { getScanConfig: vi.fn(), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: {
        listWatchlist: vi.fn().mockResolvedValue({ type: "watchlist", id: 1, symbols: ["NSE:INFY"] }),
        addWatchlistSymbol: vi.fn().mockResolvedValue({ type: "watchlist", id: 2, symbols: ["NSE:INFY", "NSE:TCS"] }),
        removeWatchlistSymbol: vi.fn().mockResolvedValue({ type: "watchlist", id: 3, symbols: [] }),
      },
      getStatus: vi.fn(),
    });
    expect(await handlers.get("settings:listWatchlist")!(null, undefined)).toEqual(["NSE:INFY"]);
    expect(await handlers.get("settings:addWatchlistSymbol")!(null, { symbol: "NSE:TCS" })).toEqual(["NSE:INFY", "NSE:TCS"]);
    expect(await handlers.get("settings:removeWatchlistSymbol")!(null, { symbol: "NSE:INFY" })).toEqual([]);
  });

  it("returns the status object for settings:getAccountStatus", () => {
    const status = { sidecar: "up", kiteSession: "authenticated", driftWarning: null };
    const handlers = harness({
      history: { getScanConfig: vi.fn(), setScanConfig: vi.fn() },
      scanScheduler: { setConfig: vi.fn() },
      sidecar: { listWatchlist: vi.fn(), addWatchlistSymbol: vi.fn(), removeWatchlistSymbol: vi.fn() },
      getStatus: vi.fn().mockReturnValue(status),
    });
    expect(handlers.get("settings:getAccountStatus")!(null, undefined)).toBe(status);
  });
});
