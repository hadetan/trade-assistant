import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { captureRequestToken, computeKiteChecksum, exchangeAccessToken } from "./kiteOAuth";

describe("kiteOAuth", () => {
  it("computes the SHA-256 checksum of api_key + request_token + api_secret", () => {
    expect(computeKiteChecksum("api_key_123", "req_token_456", "api_secret_789")).toBe(
      "418ae5b66b62dd350659ba76f255776f36c668bd16a5fe31924a261b717e8e72",
    );
  });

  it("opens the login URL in the system browser and resolves with the captured request_token", async () => {
    const openExternal = vi.fn((url: string) => {
      const target = new URL(url);
      const port = Number(target.searchParams.get("port"));
      http.get(`http://127.0.0.1:${port}/callback?request_token=abc123&action=login&status=success`, (res) => {
        res.resume();
      });
    });

    const token = await captureRequestToken({
      port: 0,
      loginUrl: "https://kite.zerodha.com/connect/login?v=3&api_key=api_key_123",
      openExternal,
    });

    expect(token).toBe("abc123");
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("posts the checksum-signed form to the session/token endpoint", async () => {
    const postForm = vi.fn().mockResolvedValue({ data: { access_token: "at_999" } });
    const result = await exchangeAccessToken({
      apiKey: "api_key_123",
      apiSecret: "api_secret_789",
      requestToken: "req_token_456",
      postForm,
    });

    expect(postForm).toHaveBeenCalledWith("https://api.kite.trade/session/token", {
      api_key: "api_key_123",
      request_token: "req_token_456",
      checksum: "418ae5b66b62dd350659ba76f255776f36c668bd16a5fe31924a261b717e8e72",
    });
    expect(result).toEqual({ data: { access_token: "at_999" } });
  });
});
