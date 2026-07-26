export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

const DEFAULT_LOGIN_PORT = 3000;

function requireEnv(env: NodeJS.ProcessEnv, name: "KITE_API_KEY" | "KITE_API_SECRET"): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new KiteConfigError(`${name} is missing — create electron-app/.env from .env.example`);
  }
  return value;
}

export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const apiKey = requireEnv(env, "KITE_API_KEY");
  const apiSecret = requireEnv(env, "KITE_API_SECRET");
  const rawPort = env.KITE_LOGIN_PORT?.trim();
  const loginPort = rawPort ? Number(rawPort) : DEFAULT_LOGIN_PORT;
  if (!Number.isInteger(loginPort) || loginPort < 1 || loginPort > 65535) {
    throw new KiteConfigError(`KITE_LOGIN_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }
  return { apiKey, apiSecret, loginPort };
}
