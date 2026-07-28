import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSidecarBinaryPath } from "../../../../src/main/services/sidecar/sidecarBinaryPath";

describe("resolveSidecarBinaryPath", () => {
  it("resolves a packaged darwin build to resources/sidecar-bin/sidecar with no .exe", () => {
    const resourcesPath = "/Applications/Trade Assistant.app/Contents/Resources";
    expect(resolveSidecarBinaryPath({ isPackaged: true, resourcesPath, platform: "darwin" })).toBe(
      path.join(resourcesPath, "sidecar-bin", "sidecar"),
    );
  });

  it("resolves a packaged win32 build to resources/sidecar-bin/sidecar.exe", () => {
    const resourcesPath = "/Applications/Trade Assistant.app/Contents/Resources";
    expect(resolveSidecarBinaryPath({ isPackaged: true, resourcesPath, platform: "win32" })).toBe(
      path.join(resourcesPath, "sidecar-bin", "sidecar.exe"),
    );
  });

  it("resolves an unpackaged build to today's dev debug path (asserting only the tail, so it is checkout-location-independent)", () => {
    const result = resolveSidecarBinaryPath({ isPackaged: false, resourcesPath: "/unused", platform: "darwin" });
    expect(result.endsWith(path.join("rust-core", "target", "debug", "sidecar"))).toBe(true);
  });

  it("returns the env override unconditionally, short-circuiting both the packaged and unpackaged branches", () => {
    for (const isPackaged of [true, false]) {
      expect(
        resolveSidecarBinaryPath({ envOverride: "/custom/sidecar", isPackaged, resourcesPath: "/x", platform: "win32" }),
      ).toBe("/custom/sidecar");
    }
  });
});
