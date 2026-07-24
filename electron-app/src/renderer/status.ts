const api = (window as unknown as { tradeAssistant: import("../main/ipc/rendererApi").RendererApi }).tradeAssistant;

async function render(): Promise<void> {
  const status = await api.getStatus();
  const el = document.getElementById("status");
  if (el) el.textContent = `sidecar: ${status.sidecar} | kite: ${status.kiteSession}`;
}

api.onBanner((banner) => {
  const el = document.getElementById("banners");
  if (!el) return;
  const line = document.createElement("div");
  line.textContent = `[${banner.kind}] ${banner.message}`;
  el.appendChild(line);
});

render();
