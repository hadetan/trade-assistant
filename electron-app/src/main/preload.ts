import { contextBridge, ipcRenderer } from "electron";
import { buildRendererApi } from "./rendererApi";

const api = buildRendererApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  (channel, handler) => {
    ipcRenderer.on(channel, (_event, payload) => handler(payload));
  },
);

contextBridge.exposeInMainWorld("tradeAssistant", api);
