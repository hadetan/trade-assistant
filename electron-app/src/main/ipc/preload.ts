import { contextBridge, ipcRenderer } from "electron";
import { buildRendererApi } from "./rendererApi";

const api = buildRendererApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  (channel, handler) => {
    const wrapped = (_event: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.off(channel, wrapped);
    };
  },
);

contextBridge.exposeInMainWorld("tradeAssistant", api);
