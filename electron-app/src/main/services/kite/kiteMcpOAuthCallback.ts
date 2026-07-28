import http from "node:http";
import type { AddressInfo } from "node:net";

export interface OAuthCallbackCaptureOptions {
  port: number;
  signal?: AbortSignal;
  onListening?: (assignedPort: number) => void;
}

export interface OAuthCallbackResult {
  code: string;
  state: string | null;
}

const CLOSE_TAB_PAGE =
  "<!doctype html><meta charset=utf-8><title>Trade Assistant</title><body>Login captured. You can close this tab.</body>";

export function captureOAuthCallback(options: OAuthCallbackCaptureOptions): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const errorParam = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      // A real OAuth redirect carries `code` (success) or `error` (denial),
      // usually alongside `state`. A request with none of these — a favicon
      // probe, a prefetch, a scanner — isn't the callback, so it gets a plain
      // 404 and the server keeps listening instead of settling on a stray hit.
      const looksLikeOAuthCallback = code !== null || errorParam !== null || url.searchParams.has("state");
      if (!looksLikeOAuthCallback) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CLOSE_TAB_PAGE);
      server.close();
      if (code) resolve({ code, state });
      else reject(new Error(`kite oauth callback returned error: ${errorParam ?? "unknown"}`));
    });

    server.on("error", reject);

    options.signal?.addEventListener("abort", () => {
      server.close();
      reject(new Error("kite oauth callback capture aborted"));
    });

    server.listen(options.port, "127.0.0.1", () => {
      options.onListening?.((server.address() as AddressInfo).port);
    });
  });
}
