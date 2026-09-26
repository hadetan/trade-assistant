import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" })).toEqual({
      apiKey: "k",
      apiSecret: "s",
      loginPort: 3000,
    });
  });

  it("throws KiteConfigError when both credentials are absent", () => {
    expect(() => loadKiteConfig({})).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({})).toThrow(/KITE_API_KEY and KITE_API_SECRET are both required/);
  });

  it("throws KiteConfigError when only KITE_API_KEY is present", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(KiteConfigError);
  });

  it("throws KiteConfigError when only KITE_API_SECRET is present", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(KiteConfigError);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
