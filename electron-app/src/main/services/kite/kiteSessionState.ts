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

// The exact live shape of an unauthenticated MCP login-gate response must be
// confirmed empirically (§4 notes it is a functional "please log in" response,
// not a protocol error); these markers cover the documented TokenException /
// 403 / gate-text forms. Extend with the real shape once observed in Task 10.
export function classifyKiteResponse(response: unknown): KiteSessionStatus {
  if (typeof response !== "object" || response === null) return "unknown";
  const record = response as Record<string, unknown>;

  if (record.error_type === "TokenException") return "needsLogin";
  if (record.status === 403) return "needsLogin";
  if (containsLoginGateText(record)) return "needsLogin";

  return "authenticated";
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
