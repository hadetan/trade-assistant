import type { AppStatus } from "./rendererApi";
import type { ScanConfig } from "../services/history/historyStore";

export interface SettingsApi {
  getScanConfig(): Promise<ScanConfig>;
  setScanConfig(config: ScanConfig): Promise<ScanConfig>;
  listWatchlist(): Promise<string[]>;
  addWatchlistSymbol(symbol: string): Promise<string[]>;
  removeWatchlistSymbol(symbol: string): Promise<string[]>;
  getAccountStatus(): Promise<AppStatus>;
  searchInstruments(query: string): Promise<unknown>;
}

export function buildSettingsApi(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): SettingsApi {
  return {
    getScanConfig: () => invoke("settings:getScanConfig") as Promise<ScanConfig>,
    setScanConfig: (config) => invoke("settings:setScanConfig", config) as Promise<ScanConfig>,
    listWatchlist: () => invoke("settings:listWatchlist") as Promise<string[]>,
    addWatchlistSymbol: (symbol) => invoke("settings:addWatchlistSymbol", { symbol }) as Promise<string[]>,
    removeWatchlistSymbol: (symbol) => invoke("settings:removeWatchlistSymbol", { symbol }) as Promise<string[]>,
    getAccountStatus: () => invoke("settings:getAccountStatus") as Promise<AppStatus>,
    searchInstruments: (query) => invoke("kite:searchInstruments", { query }),
  };
}
