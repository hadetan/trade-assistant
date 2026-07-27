import type { KiteClient } from "./kiteClient";
import type { InstrumentSelection } from "../analysis/analysisEnvelope";

interface RawInstrument {
  tradingsymbol?: string;
  symbol?: string;
  exchange?: string;
  segment?: string;
  instrument_token?: number | string;
}

export function parseWatchlistSymbol(symbol: string): { exchange: string; tradingsymbol: string } | null {
  const separatorIndex = symbol.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === symbol.length - 1) return null;
  return { exchange: symbol.slice(0, separatorIndex), tradingsymbol: symbol.slice(separatorIndex + 1) };
}

// Deliberately duplicated from renderer/instrumentParsing.ts (parseInstruments):
// that file lives under the `renderer` build target and this under `main`, two
// separate electron-vite targets. Mirroring the small pure parser at the
// boundary is the same precedent ConfluenceWire follows against ScorecardSummary,
// not an accidental fork.
function textContentPayload(raw: unknown): unknown {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const textPart = content.find(
    (part): part is { type: string; text: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
  );
  if (!textPart) return undefined;
  try {
    return JSON.parse(textPart.text);
  } catch {
    return undefined;
  }
}

function extractInstrumentList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const withData = (raw as { data?: unknown })?.data;
  if (Array.isArray(withData)) return withData;
  const parsed = textContentPayload(raw);
  if (Array.isArray(parsed)) return parsed;
  const parsedData = (parsed as { data?: unknown })?.data;
  if (Array.isArray(parsedData)) return parsedData;
  return [];
}

function extractInstrumentCandidates(raw: unknown): InstrumentSelection[] {
  return extractInstrumentList(raw)
    .map((entry) => {
      const row = entry as RawInstrument | null | undefined;
      const tradingsymbol = String(row?.tradingsymbol ?? row?.symbol ?? "");
      const exchange = String(row?.exchange ?? "");
      return {
        symbol: exchange && tradingsymbol ? `${exchange}:${tradingsymbol}` : tradingsymbol,
        exchange,
        segment: String(row?.segment ?? ""),
        instrumentToken: String(row?.instrument_token ?? ""),
      };
    })
    .filter((instrument) => instrument.symbol.length > 0 && instrument.instrumentToken.length > 0);
}

// Called fresh on every scan tick (§5.1) — F&O instrument_token values recycle
// across expiries, so the resolved InstrumentSelection must never be cached or
// persisted between calls; only the bare watchlist symbol string is durable.
export async function resolveWatchlistInstrument(
  kite: Pick<KiteClient, "searchInstruments">,
  symbol: string,
): Promise<InstrumentSelection | null> {
  const parsed = parseWatchlistSymbol(symbol);
  if (!parsed) return null;
  const raw = await kite.searchInstruments(parsed.tradingsymbol);
  const candidates = extractInstrumentCandidates(raw);
  return candidates.find((candidate) => candidate.symbol === symbol) ?? null;
}
