export class KiteConfigError extends Error {}

export interface KiteFullConfig {
  mode: "full";
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

export interface KiteMcpOnlyConfig {
  mode: "mcpOnly";
  loginPort: number;
}

export type KiteConfig = KiteFullConfig | KiteMcpOnlyConfig;

const DEFAULT_LOGIN_PORT = 3000;

function parseLoginPort(env: NodeJS.ProcessEnv): number {
  const rawPort = env.KITE_LOGIN_PORT?.trim();
  const loginPort = rawPort ? Number(rawPort) : DEFAULT_LOGIN_PORT;
  if (!Number.isInteger(loginPort) || loginPort < 1 || loginPort > 65535) {
    throw new KiteConfigError(`KITE_LOGIN_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  return loginPort;
}

export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const loginPort = parseLoginPort(env);
  const apiKey = env.KITE_API_KEY?.trim();
  const apiSecret = env.KITE_API_SECRET?.trim();
  const hasKey = Boolean(apiKey);
  const hasSecret = Boolean(apiSecret);

  if (hasKey && hasSecret) {
    return { mode: "full", apiKey: apiKey!, apiSecret: apiSecret!, loginPort };
  }
  if (!hasKey && !hasSecret) {
    return { mode: "mcpOnly", loginPort };
  }
  const missing = hasKey ? "KITE_API_SECRET" : "KITE_API_KEY";
  throw new KiteConfigError(
    `${missing} is missing while the other Kite credential is set — set both for full mode, or neither for MCP-only mode`,
  );
}
