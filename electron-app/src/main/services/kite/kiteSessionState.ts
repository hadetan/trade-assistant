import { EventEmitter } from "node:events";
import type { BannerEvent, KiteSessionStatus } from "../../ipc/rendererApi";

function containsLoginGateText(response: Record<string, unknown>): boolean {
  const content = response.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" && /log ?in/i.test(text) && /kite/i.test(text);
  });
}

function looksAuthenticated(record: Record<string, unknown>): boolean {
  const data = record.data;
  if (typeof data !== "object" || data === null) return false;
  return typeof (data as Record<string, unknown>).user_id === "string";
}

// The exact live shape of an unauthenticated MCP login-gate response must be
// confirmed empirically (§4 notes it is a functional "please log in" response,
// not a protocol error); these markers cover the documented TokenException /
// 403 / gate-text forms. Extend with the real shape once observed in Task 10.
//
// The authenticated-side marker is likewise provisional: Kite Connect's
// documented convention wraps successful responses as `data: {...}`, and
// `user_id` is the field present specifically on the profile/login response.
// Other successful shapes (quotes, historical data, ...) won't match this
// narrow positive check yet and fall through to "unknown" until broader
// markers are confirmed empirically — same extend-once-observed spirit.
export function classifyKiteResponse(response: unknown): KiteSessionStatus {
  if (typeof response !== "object" || response === null) return "unknown";
  const record = response as Record<string, unknown>;

  if (record.error_type === "TokenException") return "needsLogin";
  if (record.status === 403) return "needsLogin";
  if (containsLoginGateText(record)) return "needsLogin";

  if (looksAuthenticated(record)) return "authenticated";
  return "unknown";
}

export class KiteSessionState extends EventEmitter {
  private current: KiteSessionStatus = "unknown";

  get status(): KiteSessionStatus {
    return this.current;
  }

  observe(response: unknown): void {
    this.transition(classifyKiteResponse(response));
  }

  markAuthenticated(): void {
    this.transition("authenticated");
  }

  markNeedsLogin(): void {
    this.transition("needsLogin");
  }

  private transition(next: KiteSessionStatus): void {
    if (next === this.current) return;
    this.current = next;
    this.emit("change", next);
    if (next === "needsLogin") {
      const banner: BannerEvent = { kind: "kiteLogin", message: "Kite needs login today." };
      this.emit("banner", banner);
    }
  }
}
