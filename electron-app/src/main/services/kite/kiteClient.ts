export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface HistoricalDataParams {
  instrumentToken: string;
  interval: string;
  from: string;
  to: string;
}

// The complete allowlist of Kite MCP tools this app may call. Task 5/6 and the
// tests below assert none of KITE_WRITE_TOOL_NAMES ever appears among these
// values, so a future edit here can never silently reopen a write path.
export const KITE_READ_TOOL_NAMES = {
  searchInstruments: "search_instruments",
  getHistoricalData: "get_historical_data",
  getQuotes: "get_quotes",
  getOHLC: "get_ohlc",
  getLTP: "get_ltp",
  getMargins: "get_margins",
  getHoldings: "get_holdings",
  getPositions: "get_positions",
  getProfile: "get_profile",
  getGtts: "get_gtts",
  login: "login",
} as const;

export const KITE_WRITE_TOOL_NAMES = [
  "place_order",
  "modify_order",
  "cancel_order",
  "place_gtt_order",
  "modify_gtt_order",
  "delete_gtt_order",
] as const;

export interface KiteClientOptions {
  onResponse?: (response: unknown) => void;
}

export class KiteClient {
  private readonly caller: McpToolCaller;
  private readonly onResponse?: (response: unknown) => void;

  // Declared as an arrow-function field (not a `method() {}` shorthand) so it
  // stays an own property of each instance rather than landing on
  // KiteClient.prototype — the exact-11-method-set test in kiteClient.test.ts
  // enumerates prototype own-properties and must see only the 11 read tools.
  private readonly call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await this.caller.callTool(name, args);
    this.onResponse?.(response);
    return response;
  };

  constructor(caller: McpToolCaller, options: KiteClientOptions = {}) {
    this.caller = caller;
    this.onResponse = options.onResponse;
  }

  searchInstruments(query: string): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.searchInstruments, { query });
  }

  getHistoricalData(params: HistoricalDataParams): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getHistoricalData, {
      instrument_token: params.instrumentToken,
      interval: params.interval,
      from: params.from,
      to: params.to,
    });
  }

  getQuotes(instruments: string[]): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getQuotes, { instruments });
  }

  getOHLC(instruments: string[]): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getOHLC, { instruments });
  }

  getLTP(instruments: string[]): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getLTP, { instruments });
  }

  getMargins(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getMargins, {});
  }

  getHoldings(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getHoldings, {});
  }

  getPositions(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getPositions, {});
  }

  getProfile(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getProfile, {});
  }

  getGtts(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.getGtts, {});
  }

  login(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.login, {});
  }
}
