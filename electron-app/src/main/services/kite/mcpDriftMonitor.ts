import { KITE_WRITE_TOOL_NAMES } from "./kiteClient";

// Baseline pinned from the tool names enumerated in the design doc's §4/§5.1.
// The design observed 24 tools live on 2026-07-18; this list names the 22 that
// are documented by name. Step: capture the live tools/list and append any
// additional names it returns (see Task 5 Step 6), so the monitor's baseline
// reflects the real remote surface rather than only the documented subset.
export const EXPECTED_KITE_TOOLS: readonly string[] = [
  "login",
  "get_quotes",
  "get_ltp",
  "get_ohlc",
  "get_historical_data",
  "search_instruments",
  "get_profile",
  "get_margins",
  "get_holdings",
  "get_positions",
  "get_mf_holdings",
  "get_orders",
  "get_trades",
  "get_order_history",
  "get_order_trades",
  "get_gtts",
  ...KITE_WRITE_TOOL_NAMES,
];

export interface DriftResult {
  added: string[];
  removed: string[];
  hasDrift: boolean;
}

export interface ToolListing {
  listTools(): Promise<string[]>;
}

export function diffToolList(liveToolNames: string[]): DriftResult {
  const expected = new Set<string>(EXPECTED_KITE_TOOLS);
  const live = new Set(liveToolNames);
  const added = liveToolNames.filter((name) => !expected.has(name)).sort();
  const removed = [...expected].filter((name) => !live.has(name)).sort();
  return { added, removed, hasDrift: added.length > 0 || removed.length > 0 };
}

export async function checkKiteToolDrift(listing: ToolListing): Promise<DriftResult> {
  return diffToolList(await listing.listTools());
}
