import type { SettingsApi } from "../main/ipc/rendererApi";

export function settingsBridge(): SettingsApi {
  return (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings;
}
