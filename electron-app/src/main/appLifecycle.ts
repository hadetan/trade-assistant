export function shouldQuitOnAllWindowsClosed(params: {
  isQuitting: boolean;
  scanningEnabled: boolean;
  platform: NodeJS.Platform;
}): boolean {
  if (params.isQuitting) return true;
  if (params.scanningEnabled) return false;
  return params.platform !== "darwin";
}
