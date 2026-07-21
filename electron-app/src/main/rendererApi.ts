export type SidecarStatus = "up" | "down" | "restarting";
export type KiteSessionStatus = "authenticated" | "needsLogin" | "unknown";

export interface AppStatus {
  sidecar: SidecarStatus;
  kiteSession: KiteSessionStatus;
  driftWarning: string | null;
}

export type BannerKind = "kiteLogin" | "mcpDrift" | "sidecarDown";

export interface BannerEvent {
  kind: BannerKind;
  message: string;
}

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  onBanner(handler: (banner: BannerEvent) => void): void;
}

export function buildRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, handler: (payload: unknown) => void) => void,
): RendererApi {
  return {
    getStatus: () => invoke("status:get") as Promise<AppStatus>,
    onBanner: (handler) => subscribe("banner:push", handler as (payload: unknown) => void),
  };
}
