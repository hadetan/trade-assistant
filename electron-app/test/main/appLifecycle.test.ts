import { describe, expect, it } from "vitest";
import { shouldQuitOnAllWindowsClosed } from "../../src/main/appLifecycle";

describe("shouldQuitOnAllWindowsClosed", () => {
  it("always quits when a quit is already in progress, regardless of platform or scanning", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: true, scanningEnabled: false, platform })).toBe(true);
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: true, scanningEnabled: true, platform })).toBe(true);
    }
  });

  it("stays alive on every platform while scanning is enabled and no quit is in progress", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: true, platform })).toBe(false);
    }
  });

  it("with scanning off and no quit, quits on Windows/Linux but stays alive on macOS", () => {
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "win32" })).toBe(true);
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "linux" })).toBe(true);
    expect(shouldQuitOnAllWindowsClosed({ isQuitting: false, scanningEnabled: false, platform: "darwin" })).toBe(false);
  });
});
