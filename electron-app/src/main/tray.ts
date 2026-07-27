import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";
import path from "node:path";

export interface TrayDeps {
  showMainWindow: () => void;
  showSettingsWindow: () => void;
  quit: () => void;
  iconPath?: string;
}

const DEFAULT_ICON_PATH = path.join(__dirname, "..", "..", "resources", "icons", "trayIconTemplate.png");

export function buildTrayMenuTemplate(
  deps: Pick<TrayDeps, "showMainWindow" | "showSettingsWindow" | "quit">,
): MenuItemConstructorOptions[] {
  return [
    { label: "Show", click: () => deps.showMainWindow() },
    { label: "Settings", click: () => deps.showSettingsWindow() },
    { type: "separator" },
    { label: "Quit", click: () => deps.quit() },
  ];
}

export function createTray(deps: TrayDeps): Tray {
  const icon = nativeImage.createFromPath(deps.iconPath ?? DEFAULT_ICON_PATH);
  const tray = new Tray(icon);
  tray.setToolTip("Trade Assistant");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(deps)));
  tray.on("click", () => deps.showMainWindow());
  return tray;
}
