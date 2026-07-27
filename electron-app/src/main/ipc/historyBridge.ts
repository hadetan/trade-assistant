import type { IpcMain } from "electron";
import type { HistoryStore } from "../services/history/historyStore";
import type { AnalysisMode } from "./rendererApi";

export interface HistoryBridgeDeps {
  ipcMain: Pick<IpcMain, "handle">;
  history: Pick<HistoryStore, "createSession" | "listSessions" | "getSession">;
}

export function registerHistoryBridge(deps: HistoryBridgeDeps): void {
  deps.ipcMain.handle("history:createSession", (_event, args: { mode: AnalysisMode }) =>
    deps.history.createSession(args.mode),
  );
  deps.ipcMain.handle("history:listSessions", () => deps.history.listSessions());
  deps.ipcMain.handle("history:getSession", (_event, args: { id: string }) => {
    const detail = deps.history.getSession(args.id);
    if (!detail) throw new Error(`unknown session ${args.id}`);
    return detail;
  });
}
