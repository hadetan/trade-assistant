import { describe, expect, it, vi } from "vitest";
import {
  parseWatchlistSymbol,
  resolveWatchlistInstrument,
} from "../../../../src/main/services/kite/watchlistInstrumentResolver";

describe("parseWatchlistSymbol", () => {
  it("splits a well-formed exchange:tradingsymbol", () => {
    expect(parseWatchlistSymbol("NSE:INFY")).toEqual({ exchange: "NSE", tradingsymbol: "INFY" });
  });

  it("rejects malformed inputs", () => {
    expect(parseWatchlistSymbol("NOEXCHANGE")).toBeNull();
    expect(parseWatchlistSymbol(":INFY")).toBeNull();
    expect(parseWatchlistSymbol("NSE:")).toBeNull();
    expect(parseWatchlistSymbol("")).toBeNull();
  });
});

describe("resolveWatchlistInstrument", () => {
  it("picks the exact (exchange, tradingsymbol) match out of a multi-result response", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({
        data: [
          { tradingsymbol: "INFY", exchange: "BSE", segment: "BSE", instrument_token: 111 },
          { tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 },
        ],
      }),
    };
    const instrument = await resolveWatchlistInstrument(kite, "NSE:INFY");
    expect(kite.searchInstruments).toHaveBeenCalledWith("INFY");
    expect(instrument).toEqual({ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" });
  });

  it("parses the MCP CallToolResult text-content shape", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify([{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }]) }],
      }),
    };
    expect((await resolveWatchlistInstrument(kite, "NSE:INFY"))?.instrumentToken).toBe("408065");
  });

  it("returns null when no candidate's (exchange, tradingsymbol) matches", async () => {
    const kite = {
      searchInstruments: vi.fn().mockResolvedValue({ data: [{ tradingsymbol: "INFY", exchange: "BSE", segment: "BSE", instrument_token: 111 }] }),
    };
    expect(await resolveWatchlistInstrument(kite, "NSE:INFY")).toBeNull();
  });

  it("returns null for a malformed symbol without calling Kite", async () => {
    const kite = { searchInstruments: vi.fn() };
    expect(await resolveWatchlistInstrument(kite, "NOEXCHANGE")).toBeNull();
    expect(kite.searchInstruments).not.toHaveBeenCalled();
  });
});
