import { app, BrowserWindow } from "electron";
import path from "node:path";
import { mainWindowOptions } from "./mainWindow";

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(path.join(__dirname, "preload.js")));
  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return window;
}

app.whenReady().then(() => {
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
