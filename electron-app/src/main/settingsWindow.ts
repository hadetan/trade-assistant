import type { BrowserWindowConstructorOptions } from "electron";

export function settingsWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 480,
    height: 640,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
