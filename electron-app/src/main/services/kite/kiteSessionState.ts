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

// By the time a failed Kite MCP call reaches an IPC handler's catch block,
// the original structured response classifyKiteResponse expects is already
// gone — only a thrown Error survives, and its .message is whatever the
// throwing code chose to stringify. This only detects session expiry if
// that message happens to carry one of the same three markers as text;
// unverified against a real live session (see p5a-task-10-report.md's
// deferred MCP header-format uncertainty for the same category of risk).
// A bare /\b403\b/ would false-positive on any unrelated "403" substring in
// free text (a byte count, a line number, an unrelated ID). Requiring
// "status"/"code" to appear shortly before "403" targets how Node HTTP
// clients typically stringify this exact error — e.g. axios's default
// "Request failed with status code 403" — without over-narrowing to one
// exact phrasing.
const HTTP_403_MARKER = /\b(status|code)\D{0,10}403\b/i;

export function looksLikeSessionExpiry(error: unknown): boolean {
  const message = (error as Error)?.message ?? String(error);
  if (/tokenexception/i.test(message)) return true;
  if (HTTP_403_MARKER.test(message)) return true;
  if (/log ?in/i.test(message) && /kite/i.test(message)) return true;
  return false;
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
