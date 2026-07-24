import { app } from "electron";
import { createApp } from "./bootstrap";

const runtime = createApp();

app.whenReady().then(() => {
  runtime.start();
});

app.on("window-all-closed", () => {
  runtime.stop();
  if (process.platform !== "darwin") app.quit();
});
