import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env into full mode", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ mode: "full", apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 in full mode when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" })).toEqual({
      mode: "full",
      apiKey: "k",
      apiSecret: "s",
      loginPort: 3000,
    });
  });

  it("returns mcpOnly mode without throwing when both credentials are absent (the crash fix)", () => {
    expect(loadKiteConfig({})).toEqual({ mode: "mcpOnly", loginPort: 3000 });
  });

  it("honours KITE_LOGIN_PORT in mcpOnly mode", () => {
    expect(loadKiteConfig({ KITE_LOGIN_PORT: "4100" })).toEqual({ mode: "mcpOnly", loginPort: 4100 });
  });

  it("throws KiteConfigError naming the missing secret when only KITE_API_KEY is present", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(/KITE_API_SECRET is missing/);
  });

  it("throws KiteConfigError naming the missing key when only KITE_API_SECRET is present", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(/KITE_API_KEY is missing/);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
