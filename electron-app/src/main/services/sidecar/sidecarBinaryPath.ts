import path from "node:path";

export function resolveSidecarBinaryPath({
  isPackaged,
  resourcesPath,
  platform,
  envOverride,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  envOverride?: string;
}): string {
  if (envOverride) return envOverride;
  if (isPackaged) {
    return path.join(resourcesPath, "sidecar-bin", platform === "win32" ? "sidecar.exe" : "sidecar");
  }
  return path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar");
}
