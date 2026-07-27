import { contextBridge, ipcRenderer } from "electron";
import { buildSettingsApi } from "./rendererApi";

const api = buildSettingsApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("tradeAssistantSettings", api);
