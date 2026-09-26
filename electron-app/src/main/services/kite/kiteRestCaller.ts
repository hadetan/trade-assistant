import type { McpToolCaller } from "./kiteClient";
import type { KiteInstrumentMaster } from "./kiteInstrumentMaster";

export interface KiteRestCallerDeps {
  apiKey: string;
  accessToken: string;
  instrumentMaster: Pick<KiteInstrumentMaster, "search">;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function createKiteRestCaller(deps: KiteRestCallerDeps): McpToolCaller {
  const baseUrl = deps.baseUrl ?? "https://api.kite.trade";
  const fetchFn = deps.fetchFn ?? fetch;
  const authHeaders = {
    Authorization: `token ${deps.apiKey}:${deps.accessToken}`,
    "X-Kite-Version": "3",
  };

  async function getJson(pathname: string, query?: Record<string, string | string[]>): Promise<unknown> {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    const response = await fetchFn(url, { headers: authHeaders });
    const body = await response.json();
    if (!response.ok) {
      // error_type/message are Kite Connect's own documented error envelope
      // shape; embedding error_type verbatim keeps kiteSessionState.ts's
      // looksLikeSessionExpiry matching with zero changes to that file (it
      // already regexes for "tokenexception").
      const errorType = (body as { error_type?: string })?.error_type ?? "unknown";
      const message = (body as { message?: string })?.message ?? response.statusText;
      throw new Error(`Kite API error (${response.status} ${errorType}): ${message}`);
    }
    return body;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      switch (name) {
        case "search_instruments":
          return { data: await deps.instrumentMaster.search(String(args.query)) };
        case "get_historical_data":
          return getJson(`/instruments/historical/${args.instrument_token}/${args.interval}`, {
            from: String(args.from),
            to: String(args.to),
          });
        case "get_quotes":
          return getJson("/quote", { i: args.instruments as string[] });
        case "get_ohlc":
          return getJson("/quote/ohlc", { i: args.instruments as string[] });
        case "get_ltp":
          return getJson("/quote/ltp", { i: args.instruments as string[] });
        case "get_margins":
          return getJson("/user/margins");
        case "get_holdings":
          return getJson("/portfolio/holdings");
        case "get_positions":
          return getJson("/portfolio/positions");
        case "get_profile":
          return getJson("/user/profile");
        case "get_gtts":
          return getJson("/gtt/triggers");
        default:
          throw new Error(`kiteRestCaller: unsupported tool "${name}"`);
      }
    },
  };
}
