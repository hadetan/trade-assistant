export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

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
  if (!apiKey || !apiSecret) {
    throw new KiteConfigError(
      "KITE_API_KEY and KITE_API_SECRET are both required — register a Kite Connect developer app " +
        "at developers.kite.trade (₹500/month) and set both in electron-app/.env. There is no fallback mode.",
    );
  }
  return { apiKey, apiSecret, loginPort };
}
