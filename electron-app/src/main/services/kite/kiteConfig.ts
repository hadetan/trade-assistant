export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

const DEFAULT_LOGIN_PORT = 3000;

export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const apiKey = env.KITE_API_KEY?.trim();
  if (!apiKey) {
    throw new KiteConfigError("KITE_API_KEY is missing — create electron-app/.env from .env.example");
  }
  const apiSecret = env.KITE_API_SECRET?.trim();
  if (!apiSecret) {
    throw new KiteConfigError("KITE_API_SECRET is missing — create electron-app/.env from .env.example");
  }
  const rawPort = env.KITE_LOGIN_PORT?.trim();
  const loginPort = rawPort ? Number(rawPort) : DEFAULT_LOGIN_PORT;
  if (!Number.isInteger(loginPort) || loginPort < 0) {
    throw new KiteConfigError(`KITE_LOGIN_PORT must be a non-negative integer, got "${rawPort}"`);
  }
  return { apiKey, apiSecret, loginPort };
}
