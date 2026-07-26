import type { RendererApi } from "../main/ipc/rendererApi";

export function bridge(): RendererApi {
  return (window as unknown as { tradeAssistant: RendererApi }).tradeAssistant;
}
