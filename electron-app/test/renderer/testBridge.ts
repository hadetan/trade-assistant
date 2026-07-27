import { vi } from "vitest";
import type { RendererApi } from "../../src/main/ipc/rendererApi";

export function installBridge(overrides: Partial<RendererApi> = {}): RendererApi {
  const bridge: RendererApi = {
    getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null }),
    onBanner: vi.fn(),
    onNarrative: vi.fn(),
    login: vi.fn().mockResolvedValue({ status: "authenticated" }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [] }),
    runAnalysis: vi.fn(),
    ...overrides,
  };
  (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant = bridge;
  return bridge;
}
