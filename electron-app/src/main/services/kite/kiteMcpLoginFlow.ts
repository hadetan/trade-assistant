import type { KiteClient } from "./kiteClient";

const LOGIN_URL_PATTERN = /https:\/\/mcp\.kite\.trade\/authorize\?\S+/;

// The "login" tool's response is plain text meant for a human/agent to read
// and act on (see the live response captured during investigation), not a
// structured field -- so the login URL has to be pulled out of that text
// with a pattern match rather than read off a dedicated property.
export function extractKiteLoginUrl(loginResponse: unknown): string {
  const content = (loginResponse as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    throw new Error("kite login response had no content");
  }
  const text = content
    .map((part) => (part as { text?: unknown })?.text)
    .find((value): value is string => typeof value === "string");
  if (text === undefined) {
    throw new Error("kite login response had no text content");
  }
  const match = text.match(LOGIN_URL_PATTERN);
  if (!match) {
    throw new Error("kite login response did not include a login URL");
  }
  // Markdown link syntax wraps the URL as "(url)"; strip a trailing ")" that
  // isn't part of the URL itself (the query string carries none of its own).
  return match[0].replace(/\)+$/, "");
}

function isErrorResult(response: unknown): boolean {
  return (response as { isError?: boolean })?.isError === true;
}

export async function defaultVerifyKiteLogin(kite: KiteClient): Promise<boolean> {
  const response = await kite.getProfile();
  return !isErrorResult(response);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollForKiteLoginDeps {
  kite: KiteClient;
  verifyLogin?: (kite: KiteClient) => Promise<boolean>;
  delayFn?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 90000;

// Kite's MCP server gives no distinguishable "not authenticated yet" signal
// (an unauthenticated real tool call just comes back {isError: true, text:
// "Failed to execute ..."} -- the same generic shape any other failure would
// have), so completion can only be detected by retrying a real call until it
// stops failing. Attempt-count based (not wall-clock-deadline based) so tests
// can drive it deterministically with a fake delayFn.
export async function pollForKiteLogin(deps: PollForKiteLoginDeps): Promise<void> {
  const verifyLogin = deps.verifyLogin ?? defaultVerifyKiteLogin;
  const delay = deps.delayFn ?? defaultDelay;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await verifyLogin(deps.kite)) return;
    if (attempt < maxAttempts - 1) await delay(pollIntervalMs);
  }
  throw new Error(
    'Didn\'t detect a completed Kite login in time — finish the login in your browser, then click "Login to Kite" again.',
  );
}
