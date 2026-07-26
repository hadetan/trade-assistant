import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" }).loginPort).toBe(3000);
  });

  it("throws KiteConfigError when KITE_API_KEY is missing", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(/KITE_API_KEY is missing/);
  });

  it("throws KiteConfigError when KITE_API_SECRET is empty", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "   " })).toThrow(/KITE_API_SECRET is missing/);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
