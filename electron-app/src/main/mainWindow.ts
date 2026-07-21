import type { BrowserWindowConstructorOptions } from "electron";

export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 900,
    height: 640,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}
