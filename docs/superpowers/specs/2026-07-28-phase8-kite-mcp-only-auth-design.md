# Phase 8 — Kite MCP-Only Authentication

Status: approved by user 2026-07-28 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`, a post-roadmap addition to `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` (the original 7-phase roadmap is complete). Section references: "§N" → master design; "P8§N" → this document; "P7§N" → `docs/superpowers/specs/2026-07-28-phase7-platform-build-packaging-design.md`, whose structure/tone this document mirrors.

## P8§1 Purpose

By the end of Phase 7 the app is a complete, packaged desktop trading *assistant*: an Electron + TypeScript + React shell, a Rust compute core (`rust-core/`) spawned as a sidecar subprocess, and Claude reached via the `claude` CLI subprocess as the AI reasoning layer. Its sole live-data path is the Kite MCP connection (§4, §5.1), authenticated today by a paid Kite Connect Developer API key/secret via the OAuth `request_token` → `access_token` exchange (§8.3).

There is a concrete, reproducible bug and a real capability gap this phase closes together:

- **The bug:** `loadKiteConfig()` throws `KiteConfigError` synchronously whenever `KITE_API_KEY`/`KITE_API_SECRET` are absent from the environment (`kiteConfig.ts`'s `requireEnv`), and `createApp()` in `bootstrap.ts` calls `const config = loadKiteConfig();` **unconditionally, near the top, before any window or supervisor exists**. So today, launching the app with no Kite Connect credentials in `electron-app/.env` crashes it at startup rather than starting in any degraded/limited state. This is not hypothetical — the checked-in `electron-app/.env` currently contains only `KITE_LOGIN_PORT`, with no key/secret, so the app crashes on launch as it sits.
- **The gap:** `https://mcp.kite.trade/mcp` — the same endpoint this app already talks to — appears to support an anonymous connect plus its own interactive OAuth-style Zerodha login, entirely independent of the ₹500/month Kite Connect Developer API key. A sibling proof-of-concept workspace at `/Users/salman/ws/trade` connects to *this exact endpoint* via the `mcp-remote` npm package with **zero API key configured** (`/Users/salman/ws/trade/.mcp.json`), and its own `CLAUDE.md` states plainly: *"First Kite MCP call in a session may need a Zerodha login popup."* That is real corroborating evidence that the endpoint supports anonymous-connect + interactive OAuth without the paid developer key.

Phase 8 adds a second, automatically-selected authentication mode — **MCP-only** — that connects to the same endpoint using the MCP Authorization spec's OAuth flow (discovery + dynamic client registration + PKCE) implemented in-process against the already-installed `@modelcontextprotocol/sdk` v1.12.0, so the app can run and drive a real analysis flow against a real Zerodha account **without any Kite Connect Developer subscription**. The existing full (API-key) mode is preserved byte-for-byte.

This phase touches **authentication/connection only**. It adds **zero** order-related surface — no Kite write-tool method, no new Claude tool grant, no order/GTT code path of any kind. The read-only tool surface (§4's closed 11-method allowlist) is provably unaffected, because both login paths produce the identical `KiteClient` over the identical `McpToolCaller` interface (P8§3). The permanent §2/§4 no-order-placement guarantee holds by construction.

## P8§2 Scope

**In scope:**

1. `kiteConfig.ts` — `KiteConfig` becomes a discriminated union (`{ mode: "full"; … } | { mode: "mcpOnly"; … }`) and `loadKiteConfig` gains mode-detection: both key+secret present → `full`; both absent → `mcpOnly` (no throw — the crash fix); exactly one present → still throws `KiteConfigError` (P8§4).
2. `kiteMcpOAuthProvider.ts` (new) — an `OAuthClientProvider` implementation, in-process, in-memory, using the SDK; no new npm dependency, no subprocess (P8§5).
3. `kiteMcpOAuthCallback.ts` (new) — a loopback HTTP capture for the OAuth `code`/`state` redirect, mirroring `kiteOAuth.ts`'s existing `captureRequestToken` shape (P8§6).
4. `mcpConnection.ts` — a new sibling function `connectKiteMcpOAuth`, alongside the unchanged `connectKiteMcp`, that builds the transport with `{ authProvider }` and orchestrates the connect → challenge → capture → `finishAuth` → reconnect dance (P8§7).
5. `kiteLogin.ts` — a new `runKiteMcpOnlyLogin(deps)` mirroring `runKiteLogin`'s composition (connect → `checkDrift`, close-on-drift-failure), returning the identical `KiteSession` (P8§8).
6. `bootstrap.ts` — one new branch at the existing `login()` closure's single `runKiteLogin` call site: `config.mode === "full" ? runKiteLogin(...) : runKiteMcpOnlyLogin(...)` (P8§9).

**Not in scope (deferred, or permanently out of scope — P8§17 has the full list):**

- Any change to the no-order-placement safety invariant (§2, §4) — unaffected (P8§3).
- **A Settings-UI toggle for auth mode.** Mode is auto-detected from `.env` presence; there is no new UI control (P8§4, locked decision 1).
- **Any token/session persistence.** No `safeStorage`, no file writes, no disk cache for `clientInformation`/`tokens`/`codeVerifier` — all in-memory, matching today's zero-persistence behavior exactly (P8§5.3, locked decision 3).
- **A new npm dependency.** The SDK (`@modelcontextprotocol/sdk` v1.12.0) is already installed; `mcp-remote` is explicitly **not** added (P8§5, locked decision 2).
- **Shelling out to `mcp-remote`** (the POC's approach) — the SDK's `OAuthClientProvider` is implemented in-process instead, for full control over how the login prompt surfaces and architectural consistency (P8§5, locked decision 2).
- Any change to `KiteClient`, the §4 read/write allowlists, `mcpDriftMonitor`, `mcpClientAdapter`, `kiteSessionState`, or the renderer (P8§10).

**Locked decisions this document writes up verbatim (from the completed brainstorming session — each was an explicit user decision or a resolved investigation finding; none are re-litigated here):**

1. **Automatic mode detection from `.env` presence, no new Settings UI.** Both key+secret present → `full` (today's flow, byte-unchanged). Both absent → `mcpOnly` (new, no crash). Exactly one present → still throws `KiteConfigError` loudly — a real misconfiguration (e.g. a typo) must never be silently downgraded into MCP-only mode.
2. **SDK-native OAuth, in-process — no new npm dependency, no new subprocess.** Not `mcp-remote`; implement `OAuthClientProvider` directly on the installed SDK, reusing the existing `openExternal` pattern.
3. **In-memory only, zero persistence** — `clientInformation`/`tokens`/`codeVerifier` are plain instance fields, never written to disk. Matches today's full-mode behavior (fresh login every launch, both modes).
4. **New OAuth callback capture mirrors `captureRequestToken`'s loopback-server pattern closely** — listen on `loginPort`, wait for the real callback, resolve a promise, shut the server down, ignore stray/non-matching requests — adapted for OAuth `code`/`state`.
5. **Zero change to the safety-critical read-only surface.** `KiteClient`'s constructor, the closed `KITE_READ_TOOL_NAMES`/`KITE_WRITE_TOOL_NAMES` allowlists, and the exact-11-method safety test are all unaffected. Both paths produce the identical `KiteClient` via the identical `McpToolCaller` (P8§3).
6. **Both login paths return the identical `KiteSession { kite, connection, drift, close }`** — `bootstrap.ts`'s `login()` closure needs only ONE new branch; everything downstream is untouched, and the renderer never learns which mode is active.
7. **`mcpDriftMonitor`/`mcpClientAdapter` need zero changes** — they operate on an already-connected client/tool-listing, not on how it authenticated.
8. **Error handling reuses the existing `catch` block** in `bootstrap.ts`'s `login()` closure (`markNeedsLogin()`, error returned as a `LoginResult`) — no new error path; both runners reject the same way on failure.
9. **The one genuine open technical risk, stated honestly, not overclaimed** — whether `mcp.kite.trade` actually implements the discovery/DCR/PKCE flow the SDK's `OAuthClientProvider`/`auth()` helpers expect is NOT yet verified against the live endpoint from this codebase. The POC's `mcp-remote`-with-no-key usage is strong corroboration, not proof. The phase's own manual verification (real login, real popup, real token exchange) is the actual proof and should be the first thing tried (P8§12).
10. **A small, testable extraction for the `bootstrap.ts` mode-branch** only if it warrants one; otherwise note it is a trivial ternary tested via the already-tested mode decision. Judgment resolved in P8§9.3: it is a trivial one-expression dispatch, the mode decision is already fully covered by `kiteConfig.test.ts`, so **no new module is created and `bootstrap.test.ts` is unchanged**.

## P8§3 The permanent no-order-placement safety invariant is unaffected (load-bearing)

**This subsection is placed early and deliberately, because it is the reason this phase is low-risk despite touching authentication.**

The §2/§4 guarantee — *the app never places, modifies, cancels, or automates any order, ever* — is enforced by the shape of `KiteClient`, not by how the underlying MCP connection was authenticated. The safety surface and the auth mechanism are orthogonal:

- **Layer 1 (primary — no method exists):** `KiteClient` (`kiteClient.ts`) exposes exactly the 11 read-tool methods in `KITE_READ_TOOL_NAMES`, each an own-instance arrow field enumerated by the exact-11-method test. There is no method — and therefore no code path — that could invoke any of the six `KITE_WRITE_TOOL_NAMES` (`place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, `delete_gtt_order`). This class's **constructor signature and every method are byte-unchanged** by this phase.
- **The auth mechanism feeds the constructor, and only the constructor.** `KiteClient`'s single dependency is an `McpToolCaller` (`{ callTool(name, args): Promise<unknown> }`). Both `connectKiteMcp` (header auth, unchanged) and the new `connectKiteMcpOAuth` (OAuth auth) produce that `McpToolCaller` via the *same* `toToolCaller(client)` adapter (`mcpClientAdapter.ts`, unchanged). Whichever login path ran, the object handed to `new KiteClient(connection.caller, …)` is the same shape with the same 11-method surface layered on top. The auth mechanism changes which bytes flow on the wire to `mcp.kite.trade`; it cannot add or remove a `KiteClient` method.
- **Layers 2 and 3 are untouched.** The `claude` subprocess `--disallowedTools` denylist plus `--strict-mcp-config` (§4 layer 2, in `ClaudeCliProvider`) is not modified. The startup drift-detection audit (§4 layer 3, `mcpDriftMonitor`) is not modified — it diffs the live `tools/list` against the pinned `EXPECTED_KITE_TOOLS` baseline, and `tools/list` is auth-mechanism-independent (§4 explicitly notes it does not even require an authenticated session), so the same drift check runs identically in both modes.

Concrete proof carried into testing: the existing `kiteClient.test.ts` safety allowlist test — which enumerates `KiteClient.prototype`/own-property method names and asserts *exactly* the eleven read methods and none matching a write tool — **requires zero changes** and continues to pass unmodified (P8§13). Restated for completeness, as in every phase: nothing here touches order placement; this phase adds no order-related surface of any kind.

## P8§4 `kiteConfig.ts` — the discriminated union and mode detection

### P8§4.1 The union type

`KiteConfig` changes from a single interface into a discriminated union tagged by `mode`:

```typescript
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
```

`loginPort` is common to both modes (both flows run a loopback server on it), so it is parsed and validated the same way regardless of mode. `apiKey`/`apiSecret` exist only on the `full` variant — the `mcpOnly` variant structurally cannot reference them, which is what makes the "MCP-only path never touches the developer key" property hold at the type level.

### P8§4.2 `loadKiteConfig` logic

```typescript
export function loadKiteConfig(env: NodeJS.ProcessEnv = process.env): KiteConfig {
  const loginPort = parseLoginPort(env); // today's KITE_LOGIN_PORT parse+validate, unchanged
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
```

- The `KITE_LOGIN_PORT` parse/validate (default `3000`, integer `1..65535`, else `KiteConfigError`) is preserved verbatim from today; extract it into a small `parseLoginPort(env)` helper only because it is now needed before the mode branch. `DEFAULT_LOGIN_PORT = 3000` stays in this file.
- The `full` return value is `{ mode: "full", apiKey, apiSecret, loginPort }` — the same three fields as today's `KiteConfig`, plus the `mode` tag. Runtime behavior of full mode is otherwise byte-unchanged.
- The exactly-one-present branch is the deliberate loud failure of locked decision 1: a typo'd/half-filled `.env` throws rather than silently degrading into MCP-only mode.
- **Mechanical judgment call (flagged):** the existing `requireEnv` helper (which throws on a missing single var) is replaced by the trim-and-classify logic above, because "missing is now sometimes valid" changes its contract. The `KiteConfigError` class itself is unchanged.

### P8§4.3 `.env.example` (recommended doc update, not core logic)

`electron-app/.env.example` currently presents `KITE_API_KEY`/`KITE_API_SECRET` as required. It should be updated to document that both are now optional-together: present-both → full mode, absent-both → MCP-only mode, exactly-one → error. This is a documentation-only change with no code impact; flagged here so the plan-writer includes it, not treated as new scope.

## P8§5 `kiteMcpOAuthProvider.ts` (new) — the `OAuthClientProvider`

A new file whose single responsibility is implementing the SDK's `OAuthClientProvider` interface (`@modelcontextprotocol/sdk/client/auth.js`) for one MCP session, entirely in memory. It is pure state + one side-effect (`redirectToAuthorization` → `openExternal`); the network dance itself lives in `connectKiteMcpOAuth` (P8§7).

### P8§5.1 Class shape

```typescript
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface KiteMcpOAuthProviderOptions {
  loginPort: number;
  openExternal: (url: string) => void;
}

export class KiteMcpOAuthProvider implements OAuthClientProvider {
  private readonly loginPort: number;
  private readonly openExternalFn: (url: string) => void;

  private clientInformationValue?: OAuthClientInformationFull;
  private tokensValue?: OAuthTokens;
  private codeVerifierValue?: string;

  constructor(options: KiteMcpOAuthProviderOptions) {
    this.loginPort = options.loginPort;
    this.openExternalFn = options.openExternal;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.loginPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Trade Assistant",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.clientInformationValue;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.clientInformationValue = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokensValue;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.tokensValue = tokens;
  }

  saveCodeVerifier(verifier: string): void {
    this.codeVerifierValue = verifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("codeVerifier requested before saveCodeVerifier — PKCE flow out of order");
    }
    return this.codeVerifierValue;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.openExternalFn(authorizationUrl.toString());
  }
}
```

### P8§5.2 `clientMetadata` field rationale

- `client_name: "Trade Assistant"` — matches the app name already used in `mcpConnection.ts`'s `Client({ name: "trade-assistant", … })`.
- `redirect_uris: ["http://127.0.0.1:{loginPort}/callback"]` — a single loopback redirect, identical in shape to §8.3's resolved Kite OAuth capture (`http://127.0.0.1:<port>/callback`, the same pattern Zerodha's own reference server uses). `redirectUrl` returns the same string so the SDK's `redirectUrl`-must-match-a-`redirect_uri` check holds.
- `grant_types: ["authorization_code", "refresh_token"]` — authorization-code for the initial login; `refresh_token` because the SDK's transport will attempt a token refresh before re-prompting if a refresh token was issued (a within-session convenience; refresh tokens are still never persisted).
- `response_types: ["code"]` — authorization-code flow.
- `token_endpoint_auth_method: "none"` — this is a **public/native client** using PKCE, not a confidential client. There is no client secret. This is the correct method for a desktop app that cannot keep a secret.

### P8§5.3 In-memory only (locked decision 3)

`clientInformationValue`, `tokensValue`, and `codeVerifierValue` are plain private instance fields. There is **no** `safeStorage`, no file write, no SQLite row, no cache of any kind — confirmed to match today's behavior, where `bootstrap.ts`'s `session` is a plain in-memory variable reset on logout/re-login with no token persistence anywhere in the codebase. A fresh `KiteMcpOAuthProvider` is constructed per login attempt (P8§7), so every app launch requires a fresh interactive login, exactly as full mode does today via the daily-expiring `access_token`.

### P8§5.4 Judgment calls (flagged, unpinned by the brainstorm)

- **`state()` is intentionally not implemented.** In SDK 1.12.0 the transport-driven flow completes the return leg via `transport.finishAuth(code)`, which takes only the authorization code — there is no state re-validation hook on that path, so implementing `state()` would add an unvalidated round-trip value. Security on this flow rests on PKCE (mandatory, the SDK generates and verifies the code verifier) plus the redirect being bound to `127.0.0.1` only. The loopback capture still *reads* any returned `state` (P8§6) for logging/future use, but nothing depends on it. Flagged so the plan-writer knows `state()` was considered and deliberately omitted.
- **`codeVerifier()` throws if called before `saveCodeVerifier()`** rather than returning `""`; an out-of-order PKCE call is a programming error, and a thrown message surfaces through the same `login()` catch (P8§11) rather than silently producing an invalid verifier.

## P8§6 `kiteMcpOAuthCallback.ts` (new) — the loopback capture

A new file mirroring `kiteOAuth.ts`'s `captureRequestToken` shape closely (same loopback-server pattern, same close-tab page, same ignore-stray-requests discipline), adapted for a generic OAuth `code`/`state`/`error` redirect. **The one structural difference from `captureRequestToken`: this function does NOT open the browser.** In the OAuth flow the browser is opened by `KiteMcpOAuthProvider.redirectToAuthorization` (P8§5) when the SDK reaches the authorize step, so the capture's only job is to listen and resolve — it takes no `openExternal`.

```typescript
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
```

- **Resolve/reject mirror `captureRequestToken`:** a `code` resolves; an `error` param rejects with the OAuth error string (this is the user-denied / access-denied case); a stray request 404s without settling.
- **`signal?: AbortSignal`** lets `connectKiteMcpOAuth` shut the listener down if the connection unexpectedly authorizes without a redirect (P8§7) — a defensive path that avoids leaking a listening server. Aborting rejects the promise; the orchestration ignores that rejection when it aborted deliberately.
- **`onListening?(assignedPort)`** fires once the server is bound. In production the port is the fixed pre-registered `loginPort` and the hook is unused; it exists so the unit test can bind to an ephemeral port (`port: 0`) and learn the actual port to fire its fake callback request at (mirroring how `captureRequestToken`'s test learns the port from the `openExternal` URL). It also gives `connectKiteMcpOAuth` a deterministic "server is ready" signal if it wants to sequence the connect strictly after listening.
- `state` is captured and returned but nothing downstream depends on it (P8§5.4).

## P8§7 `mcpConnection.ts` — `connectKiteMcpOAuth` (new sibling)

`connectKiteMcp` (header auth) is **unchanged**. A new sibling `connectKiteMcpOAuth` is added to the same file (it is a Kite-MCP connection concern, same responsibility as the file's existing function). It constructs the transport with `{ authProvider }` instead of `{ requestInit: { headers } }`, and orchestrates the SDK's 401-challenge → authorize → capture → `finishAuth` → reconnect sequence.

### P8§7.1 The connect dance

When a `StreamableHTTPClientTransport` is given an `authProvider` and `connect()` is called (per the SDK's `streamableHttp.d.ts` contract): it tries any existing token (none, on a fresh in-memory provider), and when auth is required with no usable token it calls `provider.redirectToAuthorization(url)` (which opens the browser via `openExternal`) and throws `UnauthorizedError` from `connect()`. The caller must then capture the authorization `code` from the redirect, call `transport.finishAuth(code)` (which exchanges the code for tokens and stores them via `saveTokens`), and retry `connect()`.

```typescript
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
// ... existing imports (Client, StreamableHTTPClientTransport, app, adapters) ...
import { KiteMcpOAuthProvider } from "./kiteMcpOAuthProvider";
import { captureOAuthCallback } from "./kiteMcpOAuthCallback";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export interface ConnectKiteMcpOAuthDeps {
  loginPort: number;
  openExternal: (url: string) => void;
  url?: string;
  // Injection seams for unit tests; defaults build the real SDK objects.
  createProvider?: (opts: { loginPort: number; openExternal: (url: string) => void }) => OAuthClientProvider;
  createClient?: (opts: { url: string; provider: OAuthClientProvider }) => {
    client: OAuthCapableSdkClient;
    transport: OAuthTransport;
  };
  captureCallback?: (opts: { port: number; signal?: AbortSignal }) => Promise<{ code: string; state: string | null }>;
}

export async function connectKiteMcpOAuth(deps: ConnectKiteMcpOAuthDeps): Promise<McpConnection> {
  const url = deps.url ?? DEFAULT_MCP_URL;
  const provider = (deps.createProvider ?? defaultCreateOAuthProvider)({
    loginPort: deps.loginPort,
    openExternal: deps.openExternal,
  });
  const capture = deps.captureCallback ?? captureOAuthCallback;
  const { client, transport } = (deps.createClient ?? defaultCreateOAuthClient)({ url, provider });

  const abort = new AbortController();
  const callbackPromise = capture({ port: deps.loginPort, signal: abort.signal });
  try {
    await client.connect(transport);
    // A fresh in-memory provider has no tokens, so connect normally throws
    // UnauthorizedError after opening the browser. Reaching here means it
    // authorized with no redirect — no callback will arrive, so stop listening.
    abort.abort();
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      abort.abort();
      throw error;
    }
    const { code } = await callbackPromise;
    await transport.finishAuth(code);
    await client.connect(transport);
  }
  return {
    caller: toToolCaller(client),
    listing: toToolListing(client),
    close: () => client.close(),
  };
}
```

Supporting types and defaults added to the same file:

```typescript
type OAuthCapableSdkClient = SdkLikeClient & { connect(transport: unknown): Promise<void> };
interface OAuthTransport { finishAuth(code: string): Promise<void>; }

function defaultCreateOAuthProvider(opts: { loginPort: number; openExternal: (url: string) => void }): OAuthClientProvider {
  return new KiteMcpOAuthProvider(opts);
}

function defaultCreateOAuthClient(opts: { url: string; provider: OAuthClientProvider }): {
  client: OAuthCapableSdkClient;
  transport: OAuthTransport;
} {
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), { authProvider: opts.provider });
  const client = new Client({ name: "trade-assistant", version: app.getVersion() }, {});
  return { client: client as unknown as OAuthCapableSdkClient, transport: transport as unknown as OAuthTransport };
}
```

### P8§7.2 Ordering note

The loopback capture is started (`capture(...)`) **before** `client.connect(transport)`, so the server is listening before the SDK can open the browser. In practice this is safe with room to spare: `connect()` performs protected-resource + authorization-server discovery and dynamic client registration (several network round-trips to `mcp.kite.trade`) before it ever calls `redirectToAuthorization`, while the loopback bind to `127.0.0.1` is near-instant. `captureOAuthCallback`'s `onListening` hook is available if a future change wants to make this ordering strict rather than relying on the timing margin.

### P8§7.3 Injection-seam judgment call (flagged)

The three seams (`createProvider`, `createClient`, `captureCallback`) mirror `connectKiteMcp`'s existing `createClient` seam, extended to cover the extra moving parts the OAuth dance has (a provider, a transport that exposes `finishAuth`, and the callback capture). The exact seam names/shapes are a mechanical detail I pinned for testability; an implementer may consolidate them (e.g. fold `createProvider` into `createClient`) as long as the load-bearing dance — first-connect-throws-`UnauthorizedError` → `finishAuth(code)` → reconnect, plus the non-`UnauthorizedError` rethrow — stays unit-testable. The `OAuthCapableSdkClient`/`OAuthTransport` local types exist because the file's existing `SdkLikeClient` deliberately omits `connect`/`finishAuth` (the header path never calls them at the orchestration level).

## P8§8 `kiteLogin.ts` — `runKiteMcpOnlyLogin` (new)

A new function mirroring `runKiteLogin`'s composition exactly, minus the request-token/access-token exchange (which OAuth replaces) and using `connectKiteMcpOAuth`. It returns the identical `KiteSession` and reproduces the same close-on-drift-failure defensive path.

```typescript
import { connectKiteMcpOAuth } from "./mcpConnection";
import type { ConnectKiteMcpOAuthDeps } from "./mcpConnection";
import type { KiteMcpOnlyConfig } from "./kiteConfig";

export interface KiteMcpOnlyLoginDeps {
  config: KiteMcpOnlyConfig;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpOAuthDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
}

export async function runKiteMcpOnlyLogin(deps: KiteMcpOnlyLoginDeps): Promise<KiteSession> {
  const connectMcp = deps.connectMcp ?? connectKiteMcpOAuth;
  const checkDrift = deps.checkDrift ?? checkKiteToolDrift;
  const { loginPort } = deps.config;

  const connection = await connectMcp({ loginPort, openExternal: deps.openExternal });
  try {
    const kite = new KiteClient(connection.caller, { onResponse: deps.onKiteResponse });
    const drift = await checkDrift(connection.listing);
    return { kite, connection, drift, close: connection.close };
  } catch (error) {
    // Mirrors runKiteLogin: checkDrift is a real tools/list network call; if it
    // fails after connectMcp already opened the connection, close it here so the
    // caller only sees the rejection, never a leaked open connection.
    await connection.close().catch(() => {});
    throw error;
  }
}
```

- **No `captureRequestToken`/`exchangeAccessToken`/`postForm`.** The interactive OAuth flow — including the loopback callback capture — lives inside `connectKiteMcpOAuth` (P8§7), because in the OAuth path the capture is inseparable from the transport connect lifecycle (listen → connect opens browser → capture resolves → `finishAuth`). This is the structural reason the MCP-only runner's dependency list is shorter than `runKiteLogin`'s: there is no separate token exchange to compose before connecting.
- **`KiteLoginDeps.config` type narrows to `KiteFullConfig`** (from the old `KiteConfig`) as a mechanical consequence of the union (P8§4.1). This is a type-annotation change only; `runKiteLogin`'s body (`const { apiKey, apiSecret, loginPort } = deps.config;` and everything after) is byte-unchanged, since `KiteFullConfig` still carries all three fields. Flagged as an unpinned mechanical detail.
- The returned `KiteSession { kite, connection, drift, close }` is structurally identical to `runKiteLogin`'s, satisfying locked decision 6.

## P8§9 `bootstrap.ts` — the one new branch

### P8§9.1 The single change

The `login()` closure's existing single call site:

```typescript
const newSession = await runKiteLogin({
  config,
  captureRequestToken,
  exchangeAccessToken,
  postForm,
  openExternal: (url) => shell.openExternal(url),
  onKiteResponse: (response) => handleKiteResponse(sessionState, response),
});
```

becomes:

```typescript
const openExternal = (url: string) => shell.openExternal(url);
const onKiteResponse = (response: unknown) => handleKiteResponse(sessionState, response);
const newSession =
  config.mode === "full"
    ? await runKiteLogin({ config, captureRequestToken, exchangeAccessToken, postForm, openExternal, onKiteResponse })
    : await runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse });
```

`config.mode === "full"` narrows `config` to `KiteFullConfig` in the first arm and `KiteMcpOnlyConfig` in the second, so both calls typecheck against their respective dep types with no cast.

### P8§9.2 Everything else in `login()` is untouched

The lines after `const newSession = …` — the `previousSession` close, `session = newSession`, the `driftWarning`/`dispatchBanner` drift wiring, `sessionState.markAuthenticated()`, the `return { status: "authenticated" }`, the `catch` block's `markNeedsLogin()` + `return { status: "error", message }`, and the `finally` clearing `loginInFlight` — are **all byte-unchanged**, because both runners return the identical `KiteSession` and reject the same way (locked decisions 6, 8). The `sessionState.on("change", …)` stale-session teardown, the `getSession`/`login` bridge wiring, and the renderer's "Login to Kite" button and banners are equally untouched — none of them can observe which mode produced the session.

### P8§9.3 No extraction, `bootstrap.test.ts` unchanged (locked decision 10, judgment resolved)

Following the precedent of `resolveSidecarBinaryPath`/`shouldQuitOnAllWindowsClosed`, a pure function is extracted only when it carries logic worth its own unit test. Here the mode branch is a **trivial one-expression ternary** dispatching to two functions; the only real decision it encodes — *which mode* — is made by `loadKiteConfig` and already fully covered by `kiteConfig.test.ts` (all three cases: both-present, both-absent, exactly-one). The `runKiteMcpOnlyLogin` composition is covered in `kiteLogin.test.ts`. Extracting the ternary into a module would add indirection without adding a meaningfully testable unit. So: **no new module, no new pure function, and `bootstrap.test.ts` gains no new test** — its existing `handleKiteResponse` tests remain and are unaffected (they never touched auth mode). This is the "don't over-engineer a one-line ternary" outcome the decision anticipated.

### P8§9.4 Imports

`bootstrap.ts` adds `import { runKiteMcpOnlyLogin } from "./services/kite/kiteLogin";` (alongside the existing `runKiteLogin` import). `captureRequestToken`/`exchangeAccessToken` and the local `postForm` remain imported/defined and are now referenced only in the `full` arm — used conditionally, not removed.

## P8§10 Modules that need zero change (stated explicitly)

- **`kiteClient.ts`** — constructor, `KITE_READ_TOOL_NAMES` (11 tools incl. `login`), `KITE_WRITE_TOOL_NAMES`, `McpToolCaller`: all unchanged. This is the load-bearing safety surface (P8§3).
- **`mcpDriftMonitor.ts`** — `EXPECTED_KITE_TOOLS`, `diffToolList`, `checkKiteToolDrift`: unchanged. Operates on a `tools/list` result, which is auth-mechanism-independent (locked decision 7, §4).
- **`mcpClientAdapter.ts`** — `toToolCaller`/`toToolListing`: unchanged. Both connect functions feed it the same SDK client shape.
- **`kiteSessionState.ts`** — `classifyKiteResponse`, `looksLikeSessionExpiry`, `KiteSessionState`: unchanged. They classify MCP tool-call *responses*, not how the connection authenticated.
- **`bootstrap.ts`'s `handleKiteResponse`/`classifyKiteResponse` wiring** — unchanged beyond the one branch in P8§9.
- **Renderer** (`rendererApi.ts`, the "Login to Kite" button, banners, `LoginResult`) — unchanged; the renderer never learns the mode. `LoginResult` (`{ status: "authenticated" } | { status: "error"; message: string }`) is produced identically by `login()` in both modes.
- **`kiteOAuth.ts`** — `captureRequestToken`/`exchangeAccessToken`/`computeKiteChecksum`: unchanged; full mode still uses them.

## P8§11 Error handling / edge cases

No new error-handling code path is added. Every failure mode below rejects the login promise and is caught by the **existing** `login()` closure `catch` in `bootstrap.ts`, which calls `sessionState.markNeedsLogin()` and returns `{ status: "error", message }` — the same behavior full mode already has (locked decision 8).

1. **User cancels / denies in the browser.** The redirect carries `error=access_denied` (or similar). `captureOAuthCallback` rejects with the OAuth error string (P8§6); `connectKiteMcpOAuth` propagates it; `runKiteMcpOnlyLogin` closes the connection if one was opened and rethrows; `login()` marks needs-login. Same visible outcome as a full-mode cancel.
2. **`mcp.kite.trade` does not support the expected OAuth flow** (the real open unknown — P8§12). The SDK's discovery/DCR helpers throw during the first `client.connect`. That is not an `UnauthorizedError`, so `connectKiteMcpOAuth` aborts the capture and rethrows; `login()` surfaces it as an error `LoginResult`. No crash, no hang.
3. **Network failure mid-flow.** Same as (2): the thrown error propagates through the existing catch.
4. **Drift-check fails after connect.** Handled by `runKiteMcpOnlyLogin`'s `catch` closing the connection then rethrowing — a byte-for-byte mirror of `runKiteLogin`'s existing defensive path.
5. **Connect authorizes without a redirect** (e.g. a future server that skips the interactive step). The first `client.connect` resolves; the code aborts the still-listening capture (`abort.abort()`) so no server leaks, and returns the connection normally.
6. **Missing developer key was the whole point.** The pre-Phase-8 startup crash (missing key → `KiteConfigError` → `createApp()` throws) is eliminated by P8§4: both-absent now returns `mcpOnly` instead of throwing.

## P8§12 The one open technical risk (honest, not overclaimed)

**The single genuine unknown:** whether `https://mcp.kite.trade` actually implements the MCP Authorization spec's OAuth flow the way the SDK's `OAuthClientProvider`/`auth()`/transport `authProvider` path expects — specifically: RFC 9728 protected-resource metadata discovery, RFC 8414 authorization-server metadata discovery, RFC 7591 dynamic client registration, and PKCE authorization-code exchange. This is **not yet verified against the live endpoint from within this codebase.**

**What is real corroborating evidence (not proof):** the `/Users/salman/ws/trade` POC connects to this exact endpoint via `mcp-remote` — a generic MCP-OAuth-capable proxy — with **zero API key** (`/Users/salman/ws/trade/.mcp.json`), and its `CLAUDE.md` documents an interactive Zerodha login popup on the first call. That strongly indicates the endpoint supports anonymous-connect + interactive OAuth independent of the paid developer key. It does **not** prove the endpoint speaks the *specific* discovery/DCR shape the SDK's strict helpers require — `mcp-remote` may accept a looser or differently-shaped handshake than `@modelcontextprotocol/sdk`'s `auth()` does.

**Mitigation, and the sequencing consequence:** the phase's own manual verification (P8§14) — a real login attempt producing a real browser popup and a real token exchange against a real Zerodha account with no Kite Connect subscription active — is the actual proof, and it should be **the first thing tried**, early, before over-investing in edge-case polish (retry UX, refresh-token handling, multi-tab robustness). If manual verification shows the SDK's strict flow does not match what the endpoint offers, that is a design-level finding that **reopens this spec's approach** (e.g. dropping to the SDK's lower-level `discoverOAuthMetadata`/`startAuthorization`/`exchangeAuthorization` building blocks with an adjusted discovery step) — it is a separately-decided change, not something to paper over inside this phase, and explicitly **not** a reversion to `mcp-remote` (ruled out by locked decision 2). The design is built so this verification is cheap to run and fails safe (P8§11 item 2): a mismatch surfaces as an error banner, never a crash.

## P8§13 Testing strategy

Matches the existing conventions in `kiteConfig.test.ts` / `kiteOAuth.test.ts` / `kiteLogin.test.ts` / `kiteClient.test.ts` (Vitest, `describe`/`it`, injected fakes via `vi.fn()`, no real network, no real browser, real `http` loopback only where the existing `kiteOAuth.test.ts` already does it).

**`kiteConfig.test.ts` (updated):**
- both key+secret present → `{ mode: "full", apiKey, apiSecret, loginPort }` (the existing "parses a fully populated env" and "defaults loginPort to 3000" assertions gain the `mode: "full"` field — a required update since the return shape changed).
- both absent → `{ mode: "mcpOnly", loginPort: 3000 }`, and **does not throw** (the new headline case — proves the crash fix).
- `KITE_LOGIN_PORT` honored/validated in `mcpOnly` mode too (e.g. `{ KITE_LOGIN_PORT: "4100" }` alone → `{ mode: "mcpOnly", loginPort: 4100 }`).
- only `KITE_API_KEY` present → throws `KiteConfigError` (message names the missing secret).
- only `KITE_API_SECRET` present → throws `KiteConfigError` (message names the missing key).
- non-numeric `KITE_LOGIN_PORT` → still throws `KiteConfigError` (existing test, now exercised before the mode branch).

**`kiteMcpOAuthProvider.test.ts` (new):**
- `clientMetadata` returns `client_name: "Trade Assistant"`, `redirect_uris: ["http://127.0.0.1:3000/callback"]` (for `loginPort: 3000`), `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, `token_endpoint_auth_method: "none"`.
- `redirectUrl` equals the single `redirect_uris` entry.
- `tokens()`/`clientInformation()` return `undefined` before any save; `saveTokens`/`saveClientInformation`/`saveCodeVerifier` round-trip in memory.
- `codeVerifier()` throws if called before `saveCodeVerifier`.
- `redirectToAuthorization(new URL("https://kite.example/auth?x=1"))` calls the injected `openExternal` once with the exact URL string.

**`kiteMcpOAuthCallback.test.ts` (new):** mirrors `kiteOAuth.test.ts`'s real-`http` loopback test.
- start `captureOAuthCallback({ port: 0, onListening })`; in `onListening(port)`, `http.get` to `http://127.0.0.1:${port}/callback?code=AUTH_CODE&state=xyz`; assert it resolves `{ code: "AUTH_CODE", state: "xyz" }`.
- an `error=access_denied` callback → rejects with a message containing `access_denied`.
- a stray request with none of `code`/`error`/`state` → gets 404 and the promise stays pending (then fire a real callback to settle it, proving the server kept listening).
- an `abort` on the signal → rejects and stops listening.

**`mcpConnection.test.ts` (updated — add `connectKiteMcpOAuth`; existing `connectKiteMcp` tests unchanged):** inject fakes for `createProvider`, `createClient` (returning a fake `client` with `connect`/`callTool`/`listTools`/`close` and a fake `transport` with `finishAuth`), and `captureCallback`.
- happy path: first `client.connect` throws `UnauthorizedError`, `captureCallback` resolves `{ code }`, `transport.finishAuth` is called with that code, second `client.connect` resolves, and the returned `McpConnection`'s `caller.callTool`/`listing.listTools`/`close` delegate to the fake client (proves adapter wiring is identical to the header path).
- a non-`UnauthorizedError` thrown from the first `connect` is rethrown and `finishAuth` is never called.
- honors a custom `url`; defaults to `https://mcp.kite.trade/mcp`.

**`kiteLogin.test.ts` (updated — add `runKiteMcpOnlyLogin`; existing `runKiteLogin` tests unchanged):** same fake-`McpConnection` helper style already in the file.
- success: injected `connectMcp` returns a fake connection, `checkDrift` returns no drift → returns a `KiteSession` whose `kite` calls delegate to the fake caller (e.g. `getLTP` → `callTool("get_ltp", …)`), `connection` is the fake, `drift.hasDrift === false`.
- drift surfaced on the returned session (mirror the existing full-mode drift test).
- `onKiteResponse` wired through to the session's `KiteClient` (mirror the existing test).
- **close-on-drift-failure:** injected `checkDrift` rejects → the fake connection's `close()` is called exactly once and the rejection propagates (the mirror of `runKiteLogin`'s defensive path).

**`kiteClient.test.ts` (UNCHANGED — stated as proof):** the exact-11-method safety allowlist test and the write-tool-name assertions require **zero** changes and continue to pass unmodified. This is the concrete evidence that this phase does not touch the safety surface (P8§3, locked decision 5).

**`bootstrap.test.ts` (UNCHANGED):** per P8§9.3, no new test — the mode decision is covered in `kiteConfig.test.ts` and the runner in `kiteLogin.test.ts`; the existing `handleKiteResponse` tests are unaffected.

**Manual verification** is the primary real proof of the OAuth flow itself, and is the first thing to run (P8§12, P8§14) — never blocking.

## P8§14 Manual verification checklist

Never blocks calling Phase 8 done; it is the **first real thing to try** because it is the only proof of the P8§12 open risk.

1. Remove `KITE_API_KEY` and `KITE_API_SECRET` entirely from `electron-app/.env` (leave `KITE_LOGIN_PORT` as-is). This is the current on-disk state, so in practice this step is already done.
2. Launch the app. Confirm it **starts without crashing** (the pre-Phase-8 behavior was a startup crash) and reaches the normal UI with a "Kite needs login" banner.
3. Click "Login to Kite." Confirm a **real Zerodha login popup** opens in the system browser via the new MCP OAuth path (not the API-key `kite.zerodha.com/connect/login` URL — a `mcp.kite.trade`-driven OAuth authorize URL).
4. Complete the Zerodha login. Confirm the loopback "you can close this tab" page appears and the app transitions to authenticated.
5. Run a real analysis flow (Engine-Only is enough — no Claude auth needed) against a real Zerodha account **with no Kite Connect Developer subscription active**, and confirm real market data comes back.
6. Regression check the other direction: restore a valid `KITE_API_KEY`/`KITE_API_SECRET` in `.env`, relaunch, and confirm full mode still logs in exactly as before (byte-unchanged path).

## P8§15 Global Constraints (binding, verbatim for the plan-writer and task-implementers)

**Exact new file paths:**
- `electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts`
- `electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts`
- `electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts`
- `electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts`

**Exact modified file paths:**
- `electron-app/src/main/services/kite/kiteConfig.ts` — `KiteConfig` becomes the discriminated union; `loadKiteConfig` gains mode detection (P8§4).
- `electron-app/src/main/services/kite/mcpConnection.ts` — add `connectKiteMcpOAuth` + its default provider/client builders and local `OAuthCapableSdkClient`/`OAuthTransport` types; `connectKiteMcp` unchanged (P8§7).
- `electron-app/src/main/services/kite/kiteLogin.ts` — add `runKiteMcpOnlyLogin` + `KiteMcpOnlyLoginDeps`; narrow `KiteLoginDeps.config` to `KiteFullConfig`; `runKiteLogin` body unchanged (P8§8).
- `electron-app/src/main/bootstrap.ts` — one new ternary branch in the `login()` closure; add `runKiteMcpOnlyLogin` import (P8§9).
- `electron-app/test/main/services/kite/kiteConfig.test.ts` — updated for the union return shape + the new mode cases (P8§13).
- `electron-app/test/main/services/kite/mcpConnection.test.ts` — add `connectKiteMcpOAuth` cases (P8§13).
- `electron-app/test/main/services/kite/kiteLogin.test.ts` — add `runKiteMcpOnlyLogin` cases (P8§13).
- `electron-app/.env.example` — document both-optional-together key/secret (P8§4.3, doc-only).

**Exact `KiteConfig` type:**
```typescript
export interface KiteFullConfig { mode: "full"; apiKey: string; apiSecret: string; loginPort: number; }
export interface KiteMcpOnlyConfig { mode: "mcpOnly"; loginPort: number; }
export type KiteConfig = KiteFullConfig | KiteMcpOnlyConfig;
```
Behavior of `loadKiteConfig`: both key+secret non-empty → `full`; both empty/absent → `mcpOnly` (no throw); exactly one → throw `KiteConfigError`. `KITE_LOGIN_PORT` parse/validate (default 3000, integer 1..65535, else throw) unchanged, applied in both modes.

**Exact `OAuthClientProvider` implementation contract (`KiteMcpOAuthProvider`):**
- Constructor: `{ loginPort: number; openExternal: (url: string) => void }`.
- `get redirectUrl(): string` → `` `http://127.0.0.1:${loginPort}/callback` ``.
- `get clientMetadata(): OAuthClientMetadata` → `{ client_name: "Trade Assistant", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }`.
- `clientInformation()`/`saveClientInformation()`, `tokens()`/`saveTokens()`, `saveCodeVerifier()`/`codeVerifier()` — in-memory instance fields, no persistence.
- `redirectToAuthorization(url: URL): void` → `openExternal(url.toString())`.
- `state()` deliberately NOT implemented (P8§5.4).

**Exact loopback capture signature (`captureOAuthCallback`):**
```typescript
captureOAuthCallback(options: { port: number; signal?: AbortSignal; onListening?: (assignedPort: number) => void }): Promise<{ code: string; state: string | null }>
```
Behavior: listen on `127.0.0.1:port`; a request with `code` resolves `{ code, state }`; with `error` rejects; with none of `code`/`error`/`state` → 404 and keep listening; `signal` abort → close + reject. Does NOT open the browser (the provider does).

**Exact OAuth connect signature (`connectKiteMcpOAuth`):**
```typescript
connectKiteMcpOAuth(deps: {
  loginPort: number;
  openExternal: (url: string) => void;
  url?: string;
  createProvider?: (opts: { loginPort: number; openExternal: (url: string) => void }) => OAuthClientProvider;
  createClient?: (opts: { url: string; provider: OAuthClientProvider }) => { client: OAuthCapableSdkClient; transport: OAuthTransport };
  captureCallback?: (opts: { port: number; signal?: AbortSignal }) => Promise<{ code: string; state: string | null }>;
}): Promise<McpConnection>
```
Orchestration: create provider → build `StreamableHTTPClientTransport(url, { authProvider: provider })` + `Client` → start `captureOAuthCallback` (listening) → `client.connect(transport)` (throws `UnauthorizedError` after browser opens) → await captured `code` → `transport.finishAuth(code)` → `client.connect(transport)` → wrap via `toToolCaller`/`toToolListing`/`close`. Non-`UnauthorizedError` from the first connect → abort capture + rethrow. Default `url` = `https://mcp.kite.trade/mcp`.

**Exact MCP-only login signature (`runKiteMcpOnlyLogin`):**
```typescript
runKiteMcpOnlyLogin(deps: {
  config: KiteMcpOnlyConfig;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpOAuthDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
}): Promise<KiteSession>
```
Returns the identical `KiteSession { kite: KiteClient; connection: McpConnection; drift: DriftResult; close(): Promise<void> }` as `runKiteLogin`. Mirrors `runKiteLogin`'s close-on-drift-failure `try/catch`.

**Exact `bootstrap.ts` branch (the only bootstrap change):**
```typescript
const newSession =
  config.mode === "full"
    ? await runKiteLogin({ config, captureRequestToken, exchangeAccessToken, postForm, openExternal, onKiteResponse })
    : await runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse });
```
Everything else in `login()` and the rest of `createApp()` is byte-unchanged.

**Binding invariants:**
- (a) `KiteClient`, `KITE_READ_TOOL_NAMES`, `KITE_WRITE_TOOL_NAMES`, `McpToolCaller`, and the exact-11-method safety test are NOT modified — both auth paths feed the same `McpToolCaller` (P8§3).
- (b) `mcpDriftMonitor`, `mcpClientAdapter`, `kiteSessionState`, and the renderer are NOT modified (P8§10).
- (c) `connectKiteMcp` (header auth) and `runKiteLogin`'s body are NOT modified — full mode is byte-unchanged.
- (d) Zero persistence: `clientInformation`/`tokens`/`codeVerifier` are in-memory only; no `safeStorage`, no file/DB writes (P8§5.3).
- (e) No new npm dependency; no `mcp-remote`; no new subprocess (locked decision 2).
- (f) No new Settings UI; mode is auto-detected from `.env` presence (locked decision 1).
- (g) Exactly-one-of key/secret present → `loadKiteConfig` throws `KiteConfigError`, never silently downgrades (locked decision 1).
- (h) No order-related surface is added; the §2/§4 no-order-placement guarantee holds by construction (P8§3).
- (i) Every failure reuses the existing `login()` `catch` → `markNeedsLogin()` + error `LoginResult`; no new error path (P8§11).

## P8§16 File layout summary

**New:**
- `electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts` — the `OAuthClientProvider` (P8§5).
- `electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts` — the loopback `code`/`state` capture (P8§6).
- `electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts` — its unit tests (P8§13).
- `electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts` — its unit tests (P8§13).

**Modified:**
- `electron-app/src/main/services/kite/kiteConfig.ts` — discriminated union + mode detection (P8§4).
- `electron-app/src/main/services/kite/mcpConnection.ts` — add `connectKiteMcpOAuth` (P8§7).
- `electron-app/src/main/services/kite/kiteLogin.ts` — add `runKiteMcpOnlyLogin`; narrow `KiteLoginDeps.config` (P8§8).
- `electron-app/src/main/bootstrap.ts` — one new branch in `login()` (P8§9).
- `electron-app/test/main/services/kite/kiteConfig.test.ts`, `mcpConnection.test.ts`, `kiteLogin.test.ts` — new cases (P8§13).
- `electron-app/.env.example` — doc-only (P8§4.3).

**Explicitly considered, NOT changed:**
- `electron-app/src/main/services/kite/kiteClient.ts` — safety surface, byte-unchanged (P8§3).
- `electron-app/src/main/services/kite/mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, `kiteSessionState.ts` — auth-independent (P8§10).
- `electron-app/src/main/services/kite/kiteOAuth.ts` — full mode still uses it (P8§10).
- `electron-app/test/main/services/kite/kiteClient.test.ts`, `bootstrap.test.ts` — unchanged (P8§13).
- The renderer, `rendererApi.ts`, `LoginResult` — unchanged (P8§10).

## P8§17 Out of scope for this phase

- **Any change to the hard no-order-placement safety invariant (§2, §4).** Unaffected — this phase adds no order-related surface (P8§3).
- **A Settings-UI toggle for auth mode.** Auto-detected from `.env` (P8§4, locked decision 1).
- **Token/session persistence** of any kind (`safeStorage`, files, DB). In-memory only, matching today (P8§5.3, locked decision 3).
- **A new npm dependency**, and specifically **`mcp-remote`** or any subprocess-based OAuth proxy. In-process SDK only (locked decision 2).
- **Refresh-token-driven silent re-login across app launches.** Refresh tokens (if issued) are used only within a live session and never persisted; a relaunch always re-prompts, both modes.
- **Changing full (API-key) mode's behavior** in any way — it is byte-unchanged.
- **Multi-account / account-switching** in MCP-only mode — single user, single account, as everywhere else in this design.
- **Hardening/polish beyond the golden path** (retry UX, multi-tab callback robustness, `state` CSRF validation) — deferred until P8§12's manual verification proves the base flow works against the live endpoint; some may prove unnecessary.
