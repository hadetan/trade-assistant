import { describe, expect, it, vi } from "vitest";
import { extractKiteLoginUrl, pollForKiteLogin } from "../../../../src/main/services/kite/kiteMcpLoginFlow";
import type { KiteClient } from "../../../../src/main/services/kite/kiteClient";

describe("extractKiteLoginUrl", () => {
  it("extracts the login URL from the live response's markdown-linked text", () => {
    const response = {
      content: [
        {
          type: "text",
          text: 'provide the user with this login link: [Login to Kite](https://mcp.kite.trade/authorize?session_id=abc%7C123)\n\nmore text',
        },
      ],
    };
    expect(extractKiteLoginUrl(response)).toBe("https://mcp.kite.trade/authorize?session_id=abc%7C123");
  });

  it("extracts a bare (non-markdown) login URL", () => {
    const response = {
      content: [{ type: "text", text: "copy and paste it into their browser: https://mcp.kite.trade/authorize?session_id=xyz" }],
    };
    expect(extractKiteLoginUrl(response)).toBe("https://mcp.kite.trade/authorize?session_id=xyz");
  });

  it("throws when the response has no content array", () => {
    expect(() => extractKiteLoginUrl({})).toThrow(/no content/);
  });

  it("throws when no content part has text", () => {
    expect(() => extractKiteLoginUrl({ content: [{ type: "image" }] })).toThrow(/no text content/);
  });

  it("throws when the text has no login URL", () => {
    expect(() => extractKiteLoginUrl({ content: [{ text: "please try again later" }] })).toThrow(/did not include a login URL/);
  });
});

function fakeKite(): KiteClient {
  return { getProfile: vi.fn() } as unknown as KiteClient;
}

describe("pollForKiteLogin", () => {
  it("resolves immediately when the first verification succeeds, without delaying", async () => {
    const kite = fakeKite();
    const verifyLogin = vi.fn().mockResolvedValue(true);
    const delayFn = vi.fn().mockResolvedValue(undefined);

    await pollForKiteLogin({ kite, verifyLogin, delayFn, pollIntervalMs: 10, pollTimeoutMs: 100 });

    expect(verifyLogin).toHaveBeenCalledTimes(1);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("retries with a delay between attempts until verification succeeds", async () => {
    const kite = fakeKite();
    const verifyLogin = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const delayFn = vi.fn().mockResolvedValue(undefined);

    await pollForKiteLogin({ kite, verifyLogin, delayFn, pollIntervalMs: 10, pollTimeoutMs: 100 });

    expect(verifyLogin).toHaveBeenCalledTimes(3);
    expect(delayFn).toHaveBeenCalledTimes(2);
    expect(delayFn).toHaveBeenCalledWith(10);
  });

  it("throws a clear timeout error when verification never succeeds within the attempt budget", async () => {
    const kite = fakeKite();
    const verifyLogin = vi.fn().mockResolvedValue(false);
    const delayFn = vi.fn().mockResolvedValue(undefined);

    await expect(pollForKiteLogin({ kite, verifyLogin, delayFn, pollIntervalMs: 10, pollTimeoutMs: 30 })).rejects.toThrow(
      /Kite login/i,
    );
    // pollTimeoutMs 30 / pollIntervalMs 10 -> 3 attempts, 2 delays (no delay after the last attempt)
    expect(verifyLogin).toHaveBeenCalledTimes(3);
    expect(delayFn).toHaveBeenCalledTimes(2);
  });

  it("uses the default verifyLogin (kite.getProfile, isError-checked) when none is injected", async () => {
    const kite = { getProfile: vi.fn().mockResolvedValue({ isError: true }) } as unknown as KiteClient;
    const delayFn = vi.fn().mockResolvedValue(undefined);

    await expect(pollForKiteLogin({ kite, delayFn, pollIntervalMs: 1, pollTimeoutMs: 1 })).rejects.toThrow(/Kite login/i);
    expect(kite.getProfile).toHaveBeenCalled();
  });
});
