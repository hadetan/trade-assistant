import http from "node:http";
import { describe, expect, it } from "vitest";
import { captureOAuthCallback } from "../../../../src/main/services/kite/kiteMcpOAuthCallback";

function fireCallback(port: number, query: string): void {
  http.get(`http://127.0.0.1:${port}/callback${query}`, (res) => res.resume());
}

describe("captureOAuthCallback", () => {
  it("resolves { code, state } from a real loopback callback", async () => {
    const result = await captureOAuthCallback({
      port: 0,
      onListening: (port) => fireCallback(port, "?code=AUTH_CODE&state=xyz"),
    });
    expect(result).toEqual({ code: "AUTH_CODE", state: "xyz" });
  });

  it("rejects when the callback carries an OAuth error param", async () => {
    await expect(
      captureOAuthCallback({ port: 0, onListening: (port) => fireCallback(port, "?error=access_denied") }),
    ).rejects.toThrow(/access_denied/);
  });

  it("404s a stray request and keeps listening until the real callback arrives", async () => {
    let strayStatus = 0;
    const result = await captureOAuthCallback({
      port: 0,
      onListening: (port) => {
        http.get(`http://127.0.0.1:${port}/favicon.ico`, (stray) => {
          strayStatus = stray.statusCode ?? 0;
          stray.resume();
          fireCallback(port, "?code=LATE_CODE&state=zzz");
        });
      },
    });
    expect(strayStatus).toBe(404);
    expect(result).toEqual({ code: "LATE_CODE", state: "zzz" });
  });

  it("rejects and stops listening when the signal aborts", async () => {
    const controller = new AbortController();
    const promise = captureOAuthCallback({
      port: 0,
      signal: controller.signal,
      onListening: () => controller.abort(),
    });
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
