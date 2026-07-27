import { describe, expect, it } from "vitest";
import { settingsWindowOptions } from "../../src/main/settingsWindow";

describe("settingsWindowOptions", () => {
  it("locks the same security posture as the main window and threads the preload", () => {
    const options = settingsWindowOptions("/abs/path/settingsPreload.js");
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.preload).toBe("/abs/path/settingsPreload.js");
  });
});
