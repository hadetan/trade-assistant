import { app } from "electron";
import { createApp } from "./bootstrap";
import { shouldQuitOnAllWindowsClosed } from "./appLifecycle";

const runtime = createApp();
let isQuitting = false;

app.whenReady().then(() => {
  runtime.start();
});

app.on("before-quit", () => {
  isQuitting = true;
  runtime.stop();
});

app.on("window-all-closed", () => {
  if (shouldQuitOnAllWindowsClosed({ isQuitting, scanningEnabled: runtime.isScanningEnabled(), platform: process.platform })) {
    app.quit();
  }
});

app.on("activate", () => {
  runtime.showMainWindow();
});
