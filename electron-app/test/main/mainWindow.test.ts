import { describe, expect, it } from "vitest";
import { mainWindowOptions } from "../../src/main/mainWindow";

describe("mainWindowOptions", () => {
  it("locks the security posture on for every window", () => {
    const options = mainWindowOptions("/abs/path/preload.js");

    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.preload).toBe("/abs/path/preload.js");
  });
});
