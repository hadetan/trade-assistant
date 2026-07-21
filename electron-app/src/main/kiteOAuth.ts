import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export function computeKiteChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash("sha256").update(`${apiKey}${requestToken}${apiSecret}`).digest("hex");
}

export interface RequestTokenCaptureOptions {
  port: number;
  loginUrl: string;
  openExternal: (url: string) => void;
}

const CLOSE_TAB_PAGE =
  "<!doctype html><meta charset=utf-8><title>Trade Assistant</title><body>Login captured. You can close this tab.</body>";

export function captureRequestToken(options: RequestTokenCaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestToken = url.searchParams.get("request_token");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CLOSE_TAB_PAGE);
      server.close();
      if (requestToken) resolve(requestToken);
      else reject(new Error("callback did not include request_token"));
    });

    server.on("error", reject);

    server.listen(options.port, "127.0.0.1", () => {
      const assignedPort = (server.address() as AddressInfo).port;
      const separator = options.loginUrl.includes("?") ? "&" : "?";
      options.openExternal(`${options.loginUrl}${separator}port=${assignedPort}`);
    });
  });
}

export interface AccessTokenExchange {
  apiKey: string;
  apiSecret: string;
  requestToken: string;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
}

export function exchangeAccessToken(exchange: AccessTokenExchange): Promise<unknown> {
  const checksum = computeKiteChecksum(exchange.apiKey, exchange.requestToken, exchange.apiSecret);
  return exchange.postForm("https://api.kite.trade/session/token", {
    api_key: exchange.apiKey,
    request_token: exchange.requestToken,
    checksum,
  });
}
