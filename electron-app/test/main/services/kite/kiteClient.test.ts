import { describe, expect, it, vi } from "vitest";
import { KiteClient, KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../../../../src/main/services/kite/kiteClient";

const EXPECTED_METHODS = [
  "getGtts",
  "getHistoricalData",
  "getHoldings",
  "getLTP",
  "getMargins",
  "getOHLC",
  "getPositions",
  "getProfile",
  "getQuotes",
  "login",
  "searchInstruments",
];

function methodNames(): string[] {
  return Object.getOwnPropertyNames(KiteClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
}

describe("KiteClient safety allowlist", () => {
  it("exposes exactly the eleven read-tool methods and no others", () => {
    expect(methodNames()).toEqual(EXPECTED_METHODS);
  });

  it("exposes no method whose name matches any write/GTT-write tool", () => {
    const forbiddenMethodNames = ["placeOrder", "modifyOrder", "cancelOrder", "placeGttOrder", "modifyGttOrder", "deleteGttOrder"];
    for (const forbidden of forbiddenMethodNames) {
      expect(methodNames()).not.toContain(forbidden);
    }
  });

  it("maps no method to a write MCP tool name", () => {
    const mappedToolNames = Object.values(KITE_READ_TOOL_NAMES);
    for (const writeTool of KITE_WRITE_TOOL_NAMES) {
      expect(mappedToolNames).not.toContain(writeTool);
    }
  });

  it("calls the correct read tool name for each method", async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const client = new KiteClient({ callTool });

    await client.getQuotes(["NSE:INFY"]);
    expect(callTool).toHaveBeenCalledWith("get_quotes", { instruments: ["NSE:INFY"] });

    await client.getHistoricalData({ instrumentToken: "408065", interval: "day", from: "2026-01-01", to: "2026-01-10" });
    expect(callTool).toHaveBeenLastCalledWith("get_historical_data", {
      instrument_token: "408065",
      interval: "day",
      from: "2026-01-01",
      to: "2026-01-10",
    });
  });

  it("invokes the onResponse callback with the raw response after a successful call", async () => {
    const response = { data: { user_id: "AB1234" } };
    const callTool = vi.fn().mockResolvedValue(response);
    const onResponse = vi.fn();
    const client = new KiteClient({ callTool }, { onResponse });

    const result = await client.getProfile();

    expect(onResponse).toHaveBeenCalledWith(response);
    expect(result).toBe(response);
  });

  it("works without an onResponse callback", async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const client = new KiteClient({ callTool });

    await expect(client.getMargins()).resolves.toEqual({ ok: true });
  });
});
