import type { InstrumentSelection } from "../main/ipc/rendererApi";

interface RawInstrument {
  tradingsymbol?: string;
  symbol?: string;
  exchange?: string;
  segment?: string;
  instrument_token?: number | string;
}

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

// The live search_instruments call can come back three ways: a flat array, a
// Kite REST-style `{data:[...]}` envelope, or the MCP SDK's own
// `{content:[{type:'text', text:'...'}]}` CallToolResult shape (the text
// itself being either of the first two forms, JSON-encoded).
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

export function parseInstruments(raw: unknown): InstrumentSelection[] {
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
