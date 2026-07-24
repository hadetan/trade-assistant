import { describe, expect, it } from "vitest";
import { EXPECTED_KITE_TOOLS, checkKiteToolDrift, diffToolList } from "../../../../src/main/services/kite/mcpDriftMonitor";

describe("mcpDriftMonitor", () => {
  it("reports no drift when the live list matches the pinned baseline exactly", () => {
    const result = diffToolList([...EXPECTED_KITE_TOOLS]);
    expect(result.hasDrift).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("flags a newly-appearing tool as drift", () => {
    const result = diffToolList([...EXPECTED_KITE_TOOLS, "place_basket_order"]);
    expect(result.hasDrift).toBe(true);
    expect(result.added).toEqual(["place_basket_order"]);
  });

  it("flags a disappearing tool as drift", () => {
    const shrunk = [...EXPECTED_KITE_TOOLS].filter((name) => name !== "get_quotes");
    const result = diffToolList(shrunk);
    expect(result.hasDrift).toBe(true);
    expect(result.removed).toEqual(["get_quotes"]);
  });

  it("runs against an injected listing without needing an authenticated session", async () => {
    const listing = { listTools: async () => [...EXPECTED_KITE_TOOLS] };
    const result = await checkKiteToolDrift(listing);
    expect(result.hasDrift).toBe(false);
  });
});
