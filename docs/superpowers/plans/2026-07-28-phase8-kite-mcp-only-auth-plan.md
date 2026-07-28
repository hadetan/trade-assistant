# Phase 8 — Kite MCP-Only Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a reproducible startup crash and close a real capability gap in one phase (P8§1). Today `loadKiteConfig()` throws `KiteConfigError` synchronously when `KITE_API_KEY`/`KITE_API_SECRET` are absent, and `createApp()` calls it unconditionally near the top of `bootstrap.ts` — so the app, whose checked-in `.env` has both credentials commented out, **crashes on launch**. Phase 8 turns `KiteConfig` into a discriminated union with auto-detected mode (both present → `full`, both absent → `mcpOnly` (no throw — the crash fix), exactly one → still throws), and adds a second, automatically-selected authentication path — **MCP-only** — that connects to the *same* `https://mcp.kite.trade/mcp` endpoint via the MCP Authorization spec's OAuth flow (discovery + dynamic client registration + PKCE) implemented in-process on the already-installed `@modelcontextprotocol/sdk` v1.12.0, so the app runs and drives a real analysis flow against a real Zerodha account **with no ₹500/month Kite Connect Developer subscription** (P8§1). Six in-scope files change: `kiteConfig.ts` (the union + crash fix), two new files (`kiteMcpOAuthProvider.ts`, `kiteMcpOAuthCallback.ts`), `mcpConnection.ts` (a new `connectKiteMcpOAuth` sibling), `kiteLogin.ts` (a new `runKiteMcpOnlyLogin`), and `bootstrap.ts` (one new ternary branch). The full (API-key) mode is preserved **byte-for-byte**. This phase adds **zero** order-related surface (P8§3, P8§17).

**Architecture:** No new architectural surface beyond a second auth mechanism. The load-bearing safety property (P8§3): both `connectKiteMcp` (header auth, unchanged) and the new `connectKiteMcpOAuth` (OAuth auth) produce the identical `McpConnection` — a `{ caller: McpToolCaller; listing: ToolListing; close }` — via the *same* `toToolCaller`/`toToolListing` adapter (`mcpClientAdapter.ts`, unchanged). Whichever login path ran, the object handed to `new KiteClient(connection.caller, …)` has the same 11-read-method surface; the auth mechanism changes only which bytes flow to `mcp.kite.trade`, and *cannot add or remove a `KiteClient` method*. Both `runKiteLogin` and the new `runKiteMcpOnlyLogin` return the identical `KiteSession { kite, connection, drift, close }`, so `bootstrap.ts`'s `login()` closure needs exactly ONE new branch and everything downstream (drift wiring, `markAuthenticated`, the `catch`→`markNeedsLogin`, the renderer, `LoginResult`) is untouched. The one open technical risk — whether the live endpoint actually speaks the strict discovery/DCR/PKCE flow the SDK expects (P8§12) — is **not** resolvable by any task in this plan; it is resolved only by the manual verification checklist at the end, which is never blocking.

**Tech Stack:** TypeScript (`camelCase`/`PascalCase`, no Hungarian notation); Electron 33 shell; `@modelcontextprotocol/sdk` v1.12.0 **already installed** — no new npm dependency, no `mcp-remote`, no new subprocess; the SDK's `OAuthClientProvider` interface (`@modelcontextprotocol/sdk/client/auth.js`), `StreamableHTTPClientTransport` with `{ authProvider }` and `transport.finishAuth(code)` (`.../client/streamableHttp.js`), and `UnauthorizedError` (a real exported class → `instanceof` works). Vitest `2.1.8` (`environment: node`, `describe`/`it`, `vi.fn()` fakes, real `http` loopback only where `kiteOAuth.test.ts` already does). Tests run from `electron-app/`: per-file `npx vitest run <path>` (no `better-sqlite3` rebuild needed — none of the kite files touch it), full suite `npm test` (its `pretest` runs `npm rebuild better-sqlite3`), typecheck `npm run typecheck` (`tsc --noEmit`, `include: ["src/**/*"]`, `exclude: ["**/*.test.ts", …]` — verified: type-checking covers src only, never test files, so type errors surface only in `src/**`). No Rust change anywhere.

## Global Constraints

Every task's requirements implicitly include this section. Values below are copied verbatim from spec **P8§15** unless noted.

- **Hard safety invariant (non-negotiable, restated every phase — the reason this phase is approved to touch auth code at all, P8§3):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface: no Kite write-tool method, no new Claude tool grant, no code path reaching `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order`. The guarantee holds **by construction**: `KiteClient` exposes exactly the 11 read methods in `KITE_READ_TOOL_NAMES`, there is no method that could invoke any of the six `KITE_WRITE_TOOL_NAMES`, and its constructor + every method are byte-unchanged. `KiteClient`'s single dependency is an `McpToolCaller`; **both** auth paths (`connectKiteMcp` header auth, `connectKiteMcpOAuth` OAuth auth) feed it the *same* `McpToolCaller` via the *same* `toToolCaller` adapter. The auth mechanism changes only the wire bytes to `mcp.kite.trade`; it cannot change the 11-method surface. The concrete, carried-into-testing proof is that `kiteClient.test.ts`'s exact-11-method safety allowlist test **requires zero changes and continues to pass unmodified** (verified in Task 5's final full-suite run).
- **Exact new file paths (P8§15/P8§16):** `electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts`; `electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts`; `electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts`; `electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts`.
- **Exact modified file paths (P8§15/P8§16):** `electron-app/src/main/services/kite/kiteConfig.ts` (discriminated union + mode detection); `electron-app/src/main/services/kite/mcpConnection.ts` (add `connectKiteMcpOAuth` + its default builders + local `OAuthCapableSdkClient`/`OAuthTransport` types; `connectKiteMcp` unchanged); `electron-app/src/main/services/kite/kiteLogin.ts` (add `runKiteMcpOnlyLogin` + `KiteMcpOnlyLoginDeps`; narrow `KiteLoginDeps.config` to `KiteFullConfig`; `runKiteLogin` body unchanged); `electron-app/src/main/bootstrap.ts` (one new ternary branch + one import); `electron-app/test/main/services/kite/kiteConfig.test.ts`, `mcpConnection.test.ts`, `kiteLogin.test.ts` (new cases); `electron-app/.env.example` (doc-only, P8§4.3).
- **Exact `KiteConfig` type (P8§15):**
  ```typescript
  export interface KiteFullConfig { mode: "full"; apiKey: string; apiSecret: string; loginPort: number; }
  export interface KiteMcpOnlyConfig { mode: "mcpOnly"; loginPort: number; }
  export type KiteConfig = KiteFullConfig | KiteMcpOnlyConfig;
  ```
  Behavior of `loadKiteConfig`: both key+secret non-empty → `full`; both empty/absent → `mcpOnly` (no throw); exactly one → throw `KiteConfigError`. `KITE_LOGIN_PORT` parse/validate (default 3000, integer 1..65535, else throw) unchanged, applied in both modes.
- **Exact `OAuthClientProvider` implementation contract (`KiteMcpOAuthProvider`, P8§15):** constructor `{ loginPort: number; openExternal: (url: string) => void }`; `get redirectUrl(): string` → `` `http://127.0.0.1:${loginPort}/callback` ``; `get clientMetadata(): OAuthClientMetadata` → `{ client_name: "Trade Assistant", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }`; `clientInformation()`/`saveClientInformation()`, `tokens()`/`saveTokens()`, `saveCodeVerifier()`/`codeVerifier()` — in-memory instance fields, no persistence; `redirectToAuthorization(url: URL): void` → `openExternal(url.toString())`; **`state()` deliberately NOT implemented** (P8§5.4).
- **Exact loopback capture signature (`captureOAuthCallback`, P8§15):**
  ```typescript
  captureOAuthCallback(options: { port: number; signal?: AbortSignal; onListening?: (assignedPort: number) => void }): Promise<{ code: string; state: string | null }>
  ```
  Behavior: listen on `127.0.0.1:port`; a request with `code` resolves `{ code, state }`; with `error` rejects; with none of `code`/`error`/`state` → 404 and keep listening; `signal` abort → close + reject. Does NOT open the browser (the provider does).
- **Exact OAuth connect signature (`connectKiteMcpOAuth`, P8§15):**
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
- **Exact MCP-only login signature (`runKiteMcpOnlyLogin`, P8§15):**
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
- **Exact `bootstrap.ts` branch (the only bootstrap change, P8§15):**
  ```typescript
  const newSession =
    config.mode === "full"
      ? await runKiteLogin({ config, captureRequestToken, exchangeAccessToken, postForm, openExternal, onKiteResponse })
      : await runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse });
  ```
  Everything else in `login()` and the rest of `createApp()` is byte-unchanged.
- **Binding invariants (P8§15, verbatim):** (a) `KiteClient`, `KITE_READ_TOOL_NAMES`, `KITE_WRITE_TOOL_NAMES`, `McpToolCaller`, and the exact-11-method safety test are NOT modified — both auth paths feed the same `McpToolCaller` (P8§3). (b) `mcpDriftMonitor`, `mcpClientAdapter`, `kiteSessionState`, and the renderer are NOT modified (P8§10). (c) `connectKiteMcp` (header auth) and `runKiteLogin`'s body are NOT modified — full mode is byte-unchanged. (d) Zero persistence: `clientInformation`/`tokens`/`codeVerifier` are in-memory only; no `safeStorage`, no file/DB writes (P8§5.3). (e) No new npm dependency; no `mcp-remote`; no new subprocess (locked decision 2). (f) No new Settings UI; mode is auto-detected from `.env` presence (locked decision 1). (g) Exactly-one-of key/secret present → `loadKiteConfig` throws `KiteConfigError`, never silently downgrades (locked decision 1). (h) No order-related surface is added; the §2/§4 no-order-placement guarantee holds by construction (P8§3). (i) Every failure reuses the existing `login()` `catch` → `markNeedsLogin()` + error `LoginResult`; no new error path (P8§11).
- **`kiteClient.ts` and its test, `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, `kiteSessionState.ts`, `kiteOAuth.ts`, `bootstrap.test.ts`, and the renderer are explicitly NOT changed (P8§10, P8§16).** No task may touch them. `bootstrap.test.ts` gains no new test (P8§9.3) — the mode decision is covered by `kiteConfig.test.ts` and the runner by `kiteLogin.test.ts`.
- **Comments (from `CLAUDE.md`):** default to none. Only add one when the *why* isn't obvious. The warranted comments in this phase are the ones already written verbatim into the spec's pinned code (`captureOAuthCallback`'s "looks like a callback" rationale, `connectKiteMcpOAuth`'s "fresh in-memory provider has no tokens" note, `runKiteMcpOnlyLogin`'s close-on-drift-failure note). Never restate the next line; never a numbered step block.
- **Naming (from `CLAUDE.md`):** TypeScript `camelCase` functions/vars, `PascalCase` types; domain terms (`oi`/`pcr`/`ltp`) fine. File names describe responsibility (`kiteMcpOAuthProvider.ts`, `kiteMcpOAuthCallback.ts`). Pure logic (the provider, the capture) stays separate from I/O/orchestration (`connectKiteMcpOAuth`, `bootstrap.ts`). This phase touches no Rust source.
- **Commit convention:** each task's implementer commits as the repo's own configured git user (`hadetan <aquibsyed83@gmail.com>`) via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects, matching the sibling plans.
- **Dependency shape (parallelism for the orchestrator) — READ THIS; it differs from the guidance's initial assumption for a real, verified reason.** The crash-fix (`KiteConfig` → union) is **NOT independently landable with a green tree**: converting `KiteConfig` to a discriminated union makes `runKiteLogin`'s body `const { apiKey, apiSecret, loginPort } = deps.config;` fail to typecheck (TS2339 — those fields don't exist on the `mcpOnly` arm), which forces narrowing `KiteLoginDeps.config` to `KiteFullConfig`, which in turn makes `bootstrap.ts`'s un-branched `runKiteLogin({ config })` fail (TS2322 — the union isn't assignable to `KiteFullConfig`), which forces the `config.mode === "full"` branch, whose `mcpOnly` arm needs `runKiteMcpOnlyLogin` to already exist. This was verified empirically against a strict `tsc --noEmit`. So the union + `kiteLogin` narrowing + `bootstrap` branch are **type-locked** and land together in the final task, on top of the OAuth building blocks. Ordering: **Tasks 1 and 2 are fully independent (no shared file, no import) — dispatch in parallel via worktrees.** Task **3** depends on Tasks 1 + 2. Task **4** depends on Task 3. Task **5** (the crash-fix + wiring) depends on Task 4. The critical path is 1/2 → 3 → 4 → 5.

---

### Task 1: `kiteMcpOAuthProvider.ts` — the in-memory `OAuthClientProvider`

A new, pure, self-contained class implementing the SDK's `OAuthClientProvider` interface for one MCP session, entirely in memory (P8§5). It is state + one side-effect (`redirectToAuthorization` → `openExternal`); the network dance itself lives in Task 3's `connectKiteMcpOAuth`. Zero persistence — `clientInformationValue`/`tokensValue`/`codeVerifierValue` are plain private instance fields (locked decision 3, invariant (d)). `state()` is deliberately NOT implemented (P8§5.4). **Fully independent of every other task** — depends only on SDK types (parallelizable with Task 2).

**Files:**
- Create: `electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts`
- Create: `electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts`

**Interfaces:**
- Consumes: `OAuthClientProvider` (type, `@modelcontextprotocol/sdk/client/auth.js`); `OAuthClientInformation`, `OAuthClientInformationFull`, `OAuthClientMetadata`, `OAuthTokens` (types, `@modelcontextprotocol/sdk/shared/auth.js`). No Phase 8 file dependency.
- Produces: `export class KiteMcpOAuthProvider`, `export interface KiteMcpOAuthProviderOptions`. Task 3's `defaultCreateOAuthProvider` constructs it.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts` (covers every P8§13 `kiteMcpOAuthProvider.test.ts` bullet; import depth `../../../../src/…` matches the sibling kite tests):

```typescript
import { describe, expect, it, vi } from "vitest";
import { KiteMcpOAuthProvider } from "../../../../src/main/services/kite/kiteMcpOAuthProvider";

describe("KiteMcpOAuthProvider", () => {
  it("exposes the public-client OAuth metadata for the given loginPort", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(provider.clientMetadata).toEqual({
      client_name: "Trade Assistant",
      redirect_uris: ["http://127.0.0.1:3000/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("uses the same redirect URL as its single registered redirect_uri", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 4100, openExternal: vi.fn() });
    expect(provider.redirectUrl).toBe("http://127.0.0.1:4100/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl]);
  });

  it("returns undefined before any save and round-trips tokens/clientInformation in memory", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();

    const info = { client_id: "cid-1", redirect_uris: ["http://127.0.0.1:3000/callback"] };
    provider.saveClientInformation(info);
    expect(provider.clientInformation()).toEqual(info);

    const tokens = { access_token: "at-1", token_type: "bearer" };
    provider.saveTokens(tokens);
    expect(provider.tokens()).toEqual(tokens);
  });

  it("round-trips a PKCE code verifier and throws if read before it is saved", () => {
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal: vi.fn() });
    expect(() => provider.codeVerifier()).toThrow(/PKCE flow out of order/);
    provider.saveCodeVerifier("verifier-123");
    expect(provider.codeVerifier()).toBe("verifier-123");
  });

  it("redirects to authorization by opening the exact URL once", () => {
    const openExternal = vi.fn();
    const provider = new KiteMcpOAuthProvider({ loginPort: 3000, openExternal });
    provider.redirectToAuthorization(new URL("https://kite.example/auth?x=1"));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://kite.example/auth?x=1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteMcpOAuthProvider.test.ts`
Expected: FAIL — cannot resolve the import `../../../../src/main/services/kite/kiteMcpOAuthProvider` (the module does not exist yet).

- [ ] **Step 3: Implement the provider** — create `electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts` (verbatim from P8§5.1):

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

- [ ] **Step 4: Run the test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteMcpOAuthProvider.test.ts`
Expected: PASS — all five `it` cases green.

- [ ] **Step 5: Typecheck and run the full suite**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean (the class satisfies `implements OAuthClientProvider`; `state?()` is optional so omitting it typechecks; the metadata literal typechecks against `OAuthClientMetadata`, whose only required field is `redirect_uris`). Full suite green; the five new cases pass; nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/kite/kiteMcpOAuthProvider.ts electron-app/test/main/services/kite/kiteMcpOAuthProvider.test.ts
git commit -m "feat(electron-app): add in-memory KiteMcpOAuthProvider for the MCP OAuth flow"
```

---

### Task 2: `kiteMcpOAuthCallback.ts` — the loopback `code`/`state` capture

A new, pure, self-contained loopback HTTP capture for the OAuth redirect (P8§6), mirroring `kiteOAuth.ts`'s `captureRequestToken` shape closely (same loopback-server pattern, same close-tab page, same ignore-stray-requests discipline). The one structural difference: it does **NOT** open the browser — in the OAuth flow the browser is opened by `KiteMcpOAuthProvider.redirectToAuthorization` (Task 1) when the SDK reaches the authorize step, so the capture's only job is to listen and resolve. **Fully independent of every other task** (parallelizable with Task 1).

**Files:**
- Create: `electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts`
- Create: `electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts`

**Interfaces:**
- Consumes: `node:http`, `node:net` (`AddressInfo` type). No Phase 8 file dependency.
- Produces: `export function captureOAuthCallback`, `export interface OAuthCallbackCaptureOptions`, `export interface OAuthCallbackResult`. Task 3's `connectKiteMcpOAuth` uses `captureOAuthCallback` as its default `captureCallback`.

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts` (covers every P8§13 `kiteMcpOAuthCallback.test.ts` bullet; real `http` loopback, mirroring `kiteOAuth.test.ts` — no mocking framework for the transport):

```typescript
import http from "node:http";
import { describe, expect, it } from "vitest";
import { captureOAuthCallback } from "../../../../src/main/services/kite/kiteMcpOAuthCallback";

function fireCallback(port: number, query: string): void {
  http.get(`http://127.0.0.1:${port}/callback${query}`, (res) => res.resume());
}

describe("captureOAuthCallback", () => {
  it("resolves { code, state } from a real loopback callback", async () => {
    const result = await captureOAuthCallback({
      port: 0,
      onListening: (port) => fireCallback(port, "?code=AUTH_CODE&state=xyz"),
    });
    expect(result).toEqual({ code: "AUTH_CODE", state: "xyz" });
  });

  it("rejects when the callback carries an OAuth error param", async () => {
    await expect(
      captureOAuthCallback({ port: 0, onListening: (port) => fireCallback(port, "?error=access_denied") }),
    ).rejects.toThrow(/access_denied/);
  });

  it("404s a stray request and keeps listening until the real callback arrives", async () => {
    let strayStatus = 0;
    const result = await captureOAuthCallback({
      port: 0,
      onListening: (port) => {
        http.get(`http://127.0.0.1:${port}/favicon.ico`, (stray) => {
          strayStatus = stray.statusCode ?? 0;
          stray.resume();
          fireCallback(port, "?code=LATE_CODE&state=zzz");
        });
      },
    });
    expect(strayStatus).toBe(404);
    expect(result).toEqual({ code: "LATE_CODE", state: "zzz" });
  });

  it("rejects and stops listening when the signal aborts", async () => {
    const controller = new AbortController();
    const promise = captureOAuthCallback({
      port: 0,
      signal: controller.signal,
      onListening: () => controller.abort(),
    });
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteMcpOAuthCallback.test.ts`
Expected: FAIL — cannot resolve the import `../../../../src/main/services/kite/kiteMcpOAuthCallback` (the module does not exist yet).

- [ ] **Step 3: Implement the capture** — create `electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts` (verbatim from P8§6, comment included):

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

- [ ] **Step 4: Run the test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteMcpOAuthCallback.test.ts`
Expected: PASS — all four `it` cases green (the stray test proves the server keeps listening: it returns 404 for `/favicon.ico`, then resolves `LATE_CODE` from the follow-up real callback).

- [ ] **Step 5: Typecheck and run the full suite**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean; full suite green; the four new cases pass; nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/kite/kiteMcpOAuthCallback.ts electron-app/test/main/services/kite/kiteMcpOAuthCallback.test.ts
git commit -m "feat(electron-app): add loopback captureOAuthCallback for the MCP OAuth redirect"
```

---

### Task 3: `mcpConnection.ts` — `connectKiteMcpOAuth` (new sibling)

Add a new `connectKiteMcpOAuth` alongside the **unchanged** `connectKiteMcp` (invariant (c)). It builds the transport with `{ authProvider }` instead of `{ requestInit: { headers } }` and orchestrates the SDK's 401-challenge → authorize → capture → `finishAuth` → reconnect dance (P8§7). The loopback capture is started *before* `client.connect(transport)` so the server is listening before the SDK can open the browser (P8§7.2). Non-`UnauthorizedError` from the first connect aborts the capture and rethrows (P8§11 items 2/3). Three injection seams (`createProvider`, `createClient`, `captureCallback`) mirror `connectKiteMcp`'s existing `createClient` seam, extended for the OAuth dance (P8§7.3). **Depends on Task 1 (`KiteMcpOAuthProvider`) and Task 2 (`captureOAuthCallback`)** — both src files must exist or typecheck fails.

**Files:**
- Modify: `electron-app/src/main/services/kite/mcpConnection.ts`
- Modify: `electron-app/test/main/services/kite/mcpConnection.test.ts`

**Interfaces:**
- Consumes: `UnauthorizedError` and `OAuthClientProvider` (`@modelcontextprotocol/sdk/client/auth.js`); `KiteMcpOAuthProvider` (Task 1); `captureOAuthCallback` (Task 2); the file's existing `Client`, `StreamableHTTPClientTransport`, `app`, `toToolCaller`/`toToolListing`, `SdkLikeClient`, `McpConnection`, `DEFAULT_MCP_URL`.
- Produces: `export interface ConnectKiteMcpOAuthDeps`, `export async function connectKiteMcpOAuth`, plus file-local `OAuthCapableSdkClient`/`OAuthTransport` types and `defaultCreateOAuthProvider`/`defaultCreateOAuthClient`. Task 4 consumes `connectKiteMcpOAuth` and `ConnectKiteMcpOAuthDeps`.

- [ ] **Step 1: Write the failing test** — in `electron-app/test/main/services/kite/mcpConnection.test.ts`, add these imports at the top alongside the existing ones (leave the existing `connectKiteMcp` describe block byte-unchanged):

```typescript
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { connectKiteMcpOAuth } from "../../../../src/main/services/kite/mcpConnection";
```

Append this describe block at the end of the file (covers every P8§13 `mcpConnection.test.ts` bullet):

```typescript
function fakeOAuthClient() {
  return {
    connect: vi.fn(),
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "login" }, { name: "get_ltp" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function oauthHarness() {
  const client = fakeOAuthClient();
  // The normal flow: the first connect on a fresh in-memory provider throws
  // UnauthorizedError (after the browser opens); the retry after finishAuth resolves.
  client.connect.mockRejectedValueOnce(new UnauthorizedError("auth required")).mockResolvedValueOnce(undefined);
  const transport = { finishAuth: vi.fn().mockResolvedValue(undefined) };
  const provider = {} as unknown as OAuthClientProvider;
  return {
    client,
    transport,
    provider,
    createProvider: vi.fn().mockReturnValue(provider),
    createClient: vi.fn().mockReturnValue({ client, transport }),
    captureCallback: vi.fn().mockResolvedValue({ code: "AUTH_CODE", state: "xyz" }),
  };
}

describe("connectKiteMcpOAuth", () => {
  it("runs challenge -> capture -> finishAuth -> reconnect and adapts the client identically to the header path", async () => {
    const h = oauthHarness();

    const conn = await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      createProvider: h.createProvider,
      createClient: h.createClient,
      captureCallback: h.captureCallback,
    });

    expect(h.createProvider).toHaveBeenCalledWith({ loginPort: 3000, openExternal: expect.any(Function) });
    expect(h.createClient).toHaveBeenCalledWith({ url: "https://mcp.kite.trade/mcp", provider: h.provider });
    expect(h.captureCallback).toHaveBeenCalledWith({ port: 3000, signal: expect.any(AbortSignal) });
    expect(h.transport.finishAuth).toHaveBeenCalledWith("AUTH_CODE");
    expect(h.client.connect).toHaveBeenCalledTimes(2);
    expect(h.client.connect).toHaveBeenCalledWith(h.transport);

    await conn.caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(h.client.callTool).toHaveBeenCalledWith({ name: "get_ltp", arguments: { instruments: ["NSE:INFY"] } });
    expect(await conn.listing.listTools()).toEqual(["login", "get_ltp"]);
    await conn.close();
    expect(h.client.close).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-UnauthorizedError from the first connect and never calls finishAuth", async () => {
    const client = fakeOAuthClient();
    client.connect.mockRejectedValueOnce(new Error("network down"));
    const transport = { finishAuth: vi.fn() };

    await expect(
      connectKiteMcpOAuth({
        loginPort: 3000,
        openExternal: vi.fn(),
        createProvider: () => ({} as unknown as OAuthClientProvider),
        createClient: () => ({ client, transport }),
        captureCallback: vi.fn().mockResolvedValue({ code: "unused", state: null }),
      }),
    ).rejects.toThrow(/network down/);
    expect(transport.finishAuth).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("honours a custom url and otherwise defaults to https://mcp.kite.trade/mcp", async () => {
    const custom = oauthHarness();
    await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      url: "https://example.test/mcp",
      createProvider: custom.createProvider,
      createClient: custom.createClient,
      captureCallback: custom.captureCallback,
    });
    expect(custom.createClient).toHaveBeenCalledWith({ url: "https://example.test/mcp", provider: custom.provider });

    const dflt = oauthHarness();
    await connectKiteMcpOAuth({
      loginPort: 3000,
      openExternal: vi.fn(),
      createProvider: dflt.createProvider,
      createClient: dflt.createClient,
      captureCallback: dflt.captureCallback,
    });
    expect(dflt.createClient).toHaveBeenCalledWith({ url: "https://mcp.kite.trade/mcp", provider: dflt.provider });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/mcpConnection.test.ts`
Expected: FAIL — the new `connectKiteMcpOAuth` describe block fails (`connectKiteMcpOAuth is not a function`). The existing `connectKiteMcp` cases still pass.

- [ ] **Step 3: Implement `connectKiteMcpOAuth`** — in `electron-app/src/main/services/kite/mcpConnection.ts`:

Add these imports below the existing ones (the existing `app`/`Client`/`StreamableHTTPClientTransport`/`toToolCaller`/`toToolListing` imports stay unchanged):

```typescript
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { KiteMcpOAuthProvider } from "./kiteMcpOAuthProvider";
import { captureOAuthCallback } from "./kiteMcpOAuthCallback";
```

Append this block at the end of the file (verbatim from P8§7.1, comments included; `connectKiteMcp` and `defaultCreateClient` above it are untouched):

```typescript
type OAuthCapableSdkClient = SdkLikeClient & { connect(transport: unknown): Promise<void> };
interface OAuthTransport { finishAuth(code: string): Promise<void>; }

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

- [ ] **Step 4: Run the test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/mcpConnection.test.ts`
Expected: PASS — the four existing `connectKiteMcp` cases plus the three new `connectKiteMcpOAuth` cases are all green. (The happy path proves the same adapter wiring as the header path: `caller.callTool` → `client.callTool({ name, arguments })`, `listing.listTools` → the mapped names, `close` → `client.close`.)

- [ ] **Step 5: Typecheck and run the full suite**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean (`OAuthCapableSdkClient`/`OAuthTransport` are file-local; `defaultCreateOAuthClient` casts through `unknown` exactly as the header path's `defaultCreateClient` does; `capture`'s narrower dep type is assignable from the real `captureOAuthCallback`). Full suite green; `connectKiteMcp`'s tests are unaffected (invariant (c)).

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/kite/mcpConnection.ts electron-app/test/main/services/kite/mcpConnection.test.ts
git commit -m "feat(electron-app): add connectKiteMcpOAuth sibling for the MCP OAuth connect dance"
```

---

### Task 4: `kiteLogin.ts` — `runKiteMcpOnlyLogin` (new) + the `KiteMcpOnlyConfig` type

Add a new `runKiteMcpOnlyLogin` mirroring `runKiteLogin`'s composition exactly, minus the request-token/access-token exchange (OAuth replaces it) and using `connectKiteMcpOAuth` (P8§8). It returns the identical `KiteSession` and reproduces the same close-on-drift-failure defensive path. Its `config` parameter is typed `KiteMcpOnlyConfig`, so this task **also adds the `KiteMcpOnlyConfig` interface to `kiteConfig.ts`** — but does NOT yet convert `KiteConfig` to the union or change `loadKiteConfig` (that is Task 5, the type-locked crash-fix). Adding a new interface plus a new `kiteLogin` export leaves `runKiteLogin` (still consuming the flat `KiteConfig`) and `bootstrap.ts` byte-unchanged, so the whole tree stays green. **Depends on Task 3 (`connectKiteMcpOAuth`, `ConnectKiteMcpOAuthDeps`).**

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteConfig.ts` (add the `KiteMcpOnlyConfig` interface only)
- Modify: `electron-app/src/main/services/kite/kiteLogin.ts`
- Modify: `electron-app/test/main/services/kite/kiteLogin.test.ts`

**Interfaces:**
- Consumes: `connectKiteMcpOAuth`, `ConnectKiteMcpOAuthDeps` (Task 3); the file's existing `KiteClient`, `checkKiteToolDrift`, `McpConnection`, `DriftResult`, `ToolListing`, `KiteSession`.
- Produces: `export interface KiteMcpOnlyConfig` (in `kiteConfig.ts`); `export interface KiteMcpOnlyLoginDeps`, `export async function runKiteMcpOnlyLogin` (in `kiteLogin.ts`). Task 5 consumes `KiteMcpOnlyConfig` (for the union) and leaves `runKiteMcpOnlyLogin` for `bootstrap.ts` to call.

- [ ] **Step 1: Add the `KiteMcpOnlyConfig` interface** — in `electron-app/src/main/services/kite/kiteConfig.ts`, insert the new interface immediately after the existing `KiteConfig` interface block (do NOT touch `KiteConfig`, `DEFAULT_LOGIN_PORT`, `requireEnv`, or `loadKiteConfig` — those change in Task 5):

```typescript
export interface KiteMcpOnlyConfig {
  mode: "mcpOnly";
  loginPort: number;
}
```

- [ ] **Step 2: Write the failing test** — in `electron-app/test/main/services/kite/kiteLogin.test.ts`, change the existing import line

```typescript
import { runKiteLogin } from "../../../../src/main/services/kite/kiteLogin";
```

to

```typescript
import { runKiteLogin, runKiteMcpOnlyLogin } from "../../../../src/main/services/kite/kiteLogin";
```

Append this describe block at the end of the file (it reuses the file's existing `fakeConnection()` helper; covers every P8§13 `runKiteMcpOnlyLogin` bullet; leave the existing `runKiteLogin` describe block and its `baseDeps` byte-unchanged):

```typescript
function mcpOnlyDeps() {
  const connection = fakeConnection();
  return {
    connection,
    deps: {
      config: { mode: "mcpOnly" as const, loginPort: 3000 },
      openExternal: vi.fn(),
      connectMcp: vi.fn().mockResolvedValue(connection),
      checkDrift: vi.fn().mockResolvedValue({ added: [], removed: [], hasDrift: false }),
    },
  };
}

describe("runKiteMcpOnlyLogin", () => {
  it("connects via OAuth then drift-checks and returns a KiteClient session delegating to the fake caller", async () => {
    const { deps, connection } = mcpOnlyDeps();

    const session = await runKiteMcpOnlyLogin(deps);

    expect(deps.connectMcp).toHaveBeenCalledWith({ loginPort: 3000, openExternal: deps.openExternal });
    expect(deps.checkDrift).toHaveBeenCalledWith(connection.listing);
    expect(session.connection).toBe(connection);
    expect(session.drift.hasDrift).toBe(false);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(connection.caller.callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("surfaces detected drift on the returned session", async () => {
    const { deps } = mcpOnlyDeps();
    deps.checkDrift = vi.fn().mockResolvedValue({ added: ["new_tool"], removed: [], hasDrift: true });

    const session = await runKiteMcpOnlyLogin(deps);
    expect(session.drift).toEqual({ added: ["new_tool"], removed: [], hasDrift: true });
  });

  it("wires onKiteResponse through to the session's KiteClient", async () => {
    const { deps, connection } = mcpOnlyDeps();
    connection.caller.callTool = vi.fn().mockResolvedValue({ data: { user_id: "AB1234" } });
    const onKiteResponse = vi.fn();

    const session = await runKiteMcpOnlyLogin({ ...deps, onKiteResponse });
    await session.kite.getProfile();

    expect(onKiteResponse).toHaveBeenCalledWith({ data: { user_id: "AB1234" } });
  });

  it("closes the connection exactly once and rethrows when checkDrift fails after connect", async () => {
    const { deps, connection } = mcpOnlyDeps();
    deps.checkDrift = vi.fn().mockRejectedValue(new Error("tools/list failed"));

    await expect(runKiteMcpOnlyLogin(deps)).rejects.toThrow(/tools\/list failed/);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteLogin.test.ts`
Expected: FAIL — the new `runKiteMcpOnlyLogin` describe block fails (`runKiteMcpOnlyLogin is not a function`). The existing `runKiteLogin` cases still pass.

- [ ] **Step 4: Implement `runKiteMcpOnlyLogin`** — in `electron-app/src/main/services/kite/kiteLogin.ts`:

Change the `mcpConnection` imports to also bring in the OAuth siblings:

```typescript
import { connectKiteMcp, connectKiteMcpOAuth } from "./mcpConnection";
import type { ConnectKiteMcpDeps, ConnectKiteMcpOAuthDeps, McpConnection } from "./mcpConnection";
```

Add the `KiteMcpOnlyConfig` type import alongside the existing `KiteConfig` import (leave `KiteLoginDeps.config: KiteConfig` unchanged for now — it narrows to `KiteFullConfig` only in Task 5):

```typescript
import type { KiteConfig, KiteMcpOnlyConfig } from "./kiteConfig";
```

Append the new deps interface and runner at the end of the file (verbatim from P8§8, comment included; `runKiteLogin`'s body, `extractAccessToken`, `KiteLoginDeps`, and `KiteSession` are byte-unchanged):

```typescript
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

- [ ] **Step 5: Run the test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteLogin.test.ts`
Expected: PASS — the existing `runKiteLogin` cases plus the four new `runKiteMcpOnlyLogin` cases are all green.

- [ ] **Step 6: Typecheck and run the full suite**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean tree-wide: `KiteMcpOnlyConfig` is a new interface; `runKiteLogin` still consumes the still-flat `KiteConfig` (its body's `apiKey`/`apiSecret`/`loginPort` destructure still resolves); `bootstrap.ts` is untouched. Full suite green.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/services/kite/kiteConfig.ts electron-app/src/main/services/kite/kiteLogin.ts electron-app/test/main/services/kite/kiteLogin.test.ts
git commit -m "feat(electron-app): add runKiteMcpOnlyLogin + KiteMcpOnlyConfig over OAuth connect"
```

---

### Task 5: `kiteConfig.ts` union + mode detection (the crash fix) + `kiteLogin`/`bootstrap` wiring

The type-locked final task that delivers the crash fix and wires MCP-only mode in. Three changes land together because TypeScript exhaustiveness couples them (verified — see Global Constraints "Dependency shape"): (1) `kiteConfig.ts` — `KiteConfig` becomes the `KiteFullConfig | KiteMcpOnlyConfig` union and `loadKiteConfig` gains mode detection (both present → `full`, both absent → `mcpOnly` (no throw — the crash fix), exactly one → throws `KiteConfigError` loudly, locked decision 1); (2) `kiteLogin.ts` — `KiteLoginDeps.config` narrows to `KiteFullConfig` (type-annotation only; `runKiteLogin`'s body is byte-unchanged, since `KiteFullConfig` still carries all three fields); (3) `bootstrap.ts` — the one new `config.mode === "full"` ternary branch, calling the `runKiteMcpOnlyLogin` that Task 4 already built. The `KITE_LOGIN_PORT` parse/validate is extracted into `parseLoginPort(env)` (needed before the mode branch); the old `requireEnv` helper is replaced (its "throws on a missing single var" contract no longer holds). Also updates `.env.example` (doc-only, P8§4.3). This is where the P8§3 safety proof lands: the final full suite confirms `kiteClient.test.ts` passes unmodified. **Depends on Task 4 (`runKiteMcpOnlyLogin`, `KiteMcpOnlyConfig`).**

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteConfig.ts`
- Modify: `electron-app/test/main/services/kite/kiteConfig.test.ts`
- Modify: `electron-app/src/main/services/kite/kiteLogin.ts`
- Modify: `electron-app/src/main/bootstrap.ts`
- Modify: `electron-app/.env.example`

**Interfaces:**
- Consumes: `KiteMcpOnlyConfig` (Task 4, for the union); `runKiteMcpOnlyLogin` (Task 4, for the bootstrap branch); the existing `runKiteLogin`, `captureRequestToken`, `exchangeAccessToken`, `postForm`, `shell.openExternal`, `handleKiteResponse`, `sessionState`.
- Produces: `KiteFullConfig`, the `KiteConfig` union, mode-detecting `loadKiteConfig`; `KiteLoginDeps.config` narrowed to `KiteFullConfig`; the fully-wired dual-mode `login()`. Last task — no downstream Phase 8 dependency.

- [ ] **Step 1: Write the failing test** — replace the entire contents of `electron-app/test/main/services/kite/kiteConfig.test.ts` with (covers every P8§13 `kiteConfig.test.ts` bullet):

```typescript
import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env into full mode", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ mode: "full", apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 in full mode when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" })).toEqual({
      mode: "full",
      apiKey: "k",
      apiSecret: "s",
      loginPort: 3000,
    });
  });

  it("returns mcpOnly mode without throwing when both credentials are absent (the crash fix)", () => {
    expect(loadKiteConfig({})).toEqual({ mode: "mcpOnly", loginPort: 3000 });
  });

  it("honours KITE_LOGIN_PORT in mcpOnly mode", () => {
    expect(loadKiteConfig({ KITE_LOGIN_PORT: "4100" })).toEqual({ mode: "mcpOnly", loginPort: 4100 });
  });

  it("throws KiteConfigError naming the missing secret when only KITE_API_KEY is present", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(/KITE_API_SECRET is missing/);
  });

  it("throws KiteConfigError naming the missing key when only KITE_API_SECRET is present", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(/KITE_API_KEY is missing/);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteConfig.test.ts`
Expected: FAIL — the full-mode/mcpOnly cases fail because today's `loadKiteConfig` returns `{ apiKey, apiSecret, loginPort }` with no `mode` field and *throws* on both-absent instead of returning `mcpOnly`.

- [ ] **Step 3: Implement the union + mode detection** — replace the entire contents of `electron-app/src/main/services/kite/kiteConfig.ts` with (verbatim from P8§4.1/P8§4.2; this final file is spec-exact and includes the `KiteMcpOnlyConfig` interface Task 4 added):

```typescript
export class KiteConfigError extends Error {}

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

- [ ] **Step 4: Run the config test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/kite/kiteConfig.test.ts`
Expected: PASS — all seven `it` cases green. (Tree-wide `tsc` is NOT clean yet at this point — `kiteLogin.ts`/`bootstrap.ts` still consume the pre-union shapes; Steps 5–6 fix that. Verify only the config unit here.)

- [ ] **Step 5: Narrow `KiteLoginDeps.config`** — in `electron-app/src/main/services/kite/kiteLogin.ts`, change the config-type import

```typescript
import type { KiteConfig, KiteMcpOnlyConfig } from "./kiteConfig";
```

to

```typescript
import type { KiteFullConfig, KiteMcpOnlyConfig } from "./kiteConfig";
```

and change `KiteLoginDeps.config` from `KiteConfig` to `KiteFullConfig`:

```typescript
export interface KiteLoginDeps {
  config: KiteFullConfig;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  connectMcp?: (d: ConnectKiteMcpDeps) => Promise<McpConnection>;
  checkDrift?: (listing: ToolListing) => Promise<DriftResult>;
  onKiteResponse?: (response: unknown) => void;
}
```

Leave `runKiteLogin`'s body, `extractAccessToken`, `KiteSession`, `KiteMcpOnlyLoginDeps`, and `runKiteMcpOnlyLogin` byte-unchanged (`KiteFullConfig` still carries `apiKey`/`apiSecret`/`loginPort`, so the body's destructure still resolves).

- [ ] **Step 6: Wire the `bootstrap.ts` mode branch** — in `electron-app/src/main/bootstrap.ts`:

Change the existing import line

```typescript
import { runKiteLogin } from "./services/kite/kiteLogin";
```

to

```typescript
import { runKiteLogin, runKiteMcpOnlyLogin } from "./services/kite/kiteLogin";
```

(Combining into the existing import satisfies P8§9.4's "add the `runKiteMcpOnlyLogin` import alongside the existing `runKiteLogin` import" while keeping a single import statement per module — see Self-review judgment calls.)

In the `login()` closure, replace exactly this block:

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

with (verbatim from P8§9.1):

```typescript
        const openExternal = (url: string) => shell.openExternal(url);
        const onKiteResponse = (response: unknown) => handleKiteResponse(sessionState, response);
        const newSession =
          config.mode === "full"
            ? await runKiteLogin({ config, captureRequestToken, exchangeAccessToken, postForm, openExternal, onKiteResponse })
            : await runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse });
```

Leave every other line in `login()` (the `previousSession` close, `session = newSession`, the `driftWarning`/`dispatchBanner` wiring, `markAuthenticated`, the `catch`→`markNeedsLogin` + error `LoginResult`, the `finally` clearing `loginInFlight`) and the rest of `createApp()` byte-unchanged. `captureRequestToken`/`exchangeAccessToken`/`postForm` remain imported/defined — now referenced only in the `full` arm (P8§9.4), used conditionally, not removed. Do NOT touch `bootstrap.test.ts` or `kiteClient.test.ts` (invariant (a), P8§9.3).

- [ ] **Step 7: Update `.env.example` (doc-only, P8§4.3)** — replace the entire contents of `electron-app/.env.example` with:

```
# Kite Connect developer-console credentials (dev-only; never committed).
# Copy this file to electron-app/.env.
#
# Auth mode is auto-detected from these two values:
#   - Both KITE_API_KEY and KITE_API_SECRET set -> full mode (paid Kite Connect
#     Developer API key + OAuth request_token/access_token exchange).
#   - Both absent                               -> MCP-only mode (interactive
#     Zerodha login over the Kite MCP endpoint; no developer subscription needed).
#   - Exactly one set                           -> startup error (a half-filled
#     .env is a misconfiguration, never silently downgraded to MCP-only).
# KITE_API_KEY=your_kite_connect_api_key
# KITE_API_SECRET=your_kite_connect_api_secret
# Loopback OAuth redirect port; used by both modes.
KITE_LOGIN_PORT=3000
```

- [ ] **Step 8: Typecheck and run the full suite (the tree-wide gate + the P8§3 proof)**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` is now clean tree-wide: `config.mode === "full"` narrows `config` to `KiteFullConfig` for the `runKiteLogin` arm and to `KiteMcpOnlyConfig` for the `runKiteMcpOnlyLogin` arm; `runKiteLogin`'s body destructures the three fields present on `KiteFullConfig`. The **full suite is green**, including — verify explicitly — `kiteClient.test.ts`'s exact-11-method safety allowlist test and its write-tool-name assertions, which are **unmodified** and pass: the concrete proof that this phase did not touch the no-order-placement safety surface (P8§3, invariant (a), (h)). `bootstrap.test.ts`'s existing `handleKiteResponse` tests also pass unchanged (P8§9.3). The seven `kiteConfig` cases and the four `runKiteMcpOnlyLogin` cases (Task 4) are green; the existing `runKiteLogin` cases pass despite their `baseDeps()` config literal lacking `mode: "full"` (Vitest strips types without checking; `tsc` excludes test files).

- [ ] **Step 9: Commit**

```bash
git add electron-app/src/main/services/kite/kiteConfig.ts electron-app/test/main/services/kite/kiteConfig.test.ts electron-app/src/main/services/kite/kiteLogin.ts electron-app/src/main/bootstrap.ts electron-app/.env.example
git commit -m "fix(electron-app): auto-detect KiteConfig mode so a missing dev key runs MCP-only instead of crashing"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Copied from spec **P8§14**. This checklist is the **first real thing to try** and the **ONLY proof of the P8§12 open risk** — whether `https://mcp.kite.trade` actually implements the discovery/DCR/PKCE flow the SDK's `OAuthClientProvider`/`auth()`/transport `authProvider` path expects. **No task in this plan can resolve that risk with code** — the unit tests all inject fakes for the SDK transport and never touch the live endpoint by design (real network, real browser, real token exchange are exactly what a real login attempt exercises). If manual verification shows the SDK's strict flow does not match what the endpoint offers, that is a design-level finding that reopens P8§12's approach (e.g. dropping to the SDK's lower-level `discoverOAuthMetadata`/`startAuthorization`/`exchangeAuthorization` building blocks) — a separately-decided change, explicitly **not** a reversion to `mcp-remote` (locked decision 2), and **not** something to paper over inside this phase. The design fails safe (P8§11 item 2): a mismatch surfaces as an error banner, never a crash. Run with the `verify` skill after the tasks land.

1. Remove `KITE_API_KEY` and `KITE_API_SECRET` entirely from `electron-app/.env` (leave `KITE_LOGIN_PORT` as-is). This is the current on-disk state (both are commented out), so in practice this step is already done.
2. Launch the app. Confirm it **starts without crashing** (the pre-Phase-8 behavior was a startup crash) and reaches the normal UI with a "Kite needs login" banner.
3. Click "Login to Kite." Confirm a **real Zerodha login popup** opens in the system browser via the new MCP OAuth path (not the API-key `kite.zerodha.com/connect/login` URL — a `mcp.kite.trade`-driven OAuth authorize URL).
4. Complete the Zerodha login. Confirm the loopback "you can close this tab" page appears and the app transitions to authenticated.
5. Run a real analysis flow (Engine-Only is enough — no Claude auth needed) against a real Zerodha account **with no Kite Connect Developer subscription active**, and confirm real market data comes back.
6. Regression check the other direction: restore a valid `KITE_API_KEY`/`KITE_API_SECRET` in `.env`, relaunch, and confirm full mode still logs in exactly as before (byte-unchanged path).

---

## Self-review

**Spec coverage — every P8§ requirement maps to a task or the checklist:**
- **P8§1 purpose** (crash fix + capability gap) → Task 5 (crash fix + wiring) + Tasks 1–4 (MCP-only path). **P8§2 scope** (six in-scope items) → Task 5 (`kiteConfig.ts`, `bootstrap.ts`), Task 1 (`kiteMcpOAuthProvider.ts`), Task 2 (`kiteMcpOAuthCallback.ts`), Task 3 (`mcpConnection.ts`), Task 4 (`kiteLogin.ts`); `.env.example` folded into Task 5. Locked decisions 1–10 → invariants (f)/(g) (Task 5), (e)/(d) (Tasks 1/3), decision 4 (Task 2), decisions 6/7 (Tasks 3/4/5), decision 8 (invariant (i), Task 5), decision 9 (the manual checklist), decision 10/P8§9.3 (Task 5 makes no new module/test for the ternary).
- **P8§3** (no-order-placement holds by construction) → Global Constraints summary + the explicit `kiteClient.test.ts`-unchanged verification in **Task 5 Step 8** (the carried-into-testing proof) + invariants (a)/(h). `kiteClient.ts` and its test are on the "NOT changed" list; no task touches them.
- **P8§4** (union + mode detection: P8§4.1 type, P8§4.2 logic, P8§4.3 `.env.example`) → Task 5 (with `KiteMcpOnlyConfig` pre-added in Task 4). **P8§5** (`OAuthClientProvider`: P8§5.1 class, P8§5.2 metadata rationale, P8§5.3 in-memory, P8§5.4 `state()` omitted / `codeVerifier()` throws) → Task 1. **P8§6** (loopback capture) → Task 2. **P8§7** (`connectKiteMcpOAuth`: P8§7.1 dance, P8§7.2 ordering, P8§7.3 seams) → Task 3. **P8§8** (`runKiteMcpOnlyLogin` + config narrowing) → Task 4 (runner) + Task 5 (the narrowing, which is type-locked to the union). **P8§9** (bootstrap branch: P8§9.1 change, P8§9.2 untouched, P8§9.3 no extraction, P8§9.4 imports) → Task 5.
- **P8§10** (zero-change modules) → the Global Constraints "explicitly NOT changed" line; no task's Files list includes `kiteClient.ts`, `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, `kiteSessionState.ts`, `kiteOAuth.ts`, the renderer, `kiteClient.test.ts`, or `bootstrap.test.ts`.
- **P8§11** (error/edge cases 1–6) → items 1/2/3 handled by `connectKiteMcpOAuth`'s `UnauthorizedError`-vs-rethrow split (Task 3, tested) + the existing `login()` catch; item 4 (drift-fail close) → Task 4's `try/catch` (tested); item 5 (authorize-without-redirect abort) → Task 3's `abort.abort()` on the success branch (the P8§7.1 code, verbatim); item 6 (the crash) → Task 5. No new error path (invariant (i)).
- **P8§12** (the one open risk) → the manual checklist, marked as the ONLY proof, never blocking, unresolvable by code. **P8§13** (test cases) → every enumerated case is real test code (mapped below). **P8§14** (manual checklist) → the non-task checklist section verbatim. **P8§15** (global constraints) → copied verbatim into Global Constraints. **P8§16** (file layout) → matches the tasks' Create/Modify lists exactly. **P8§17** (out of scope) → no task adds a Settings toggle, persistence, an npm dep, `mcp-remote`, refresh-across-launch, multi-account, or golden-path-plus hardening.

**Every P8§13 test case is real, runnable test code:**
- `kiteMcpOAuthProvider.test.ts` (5 `it`s, Task 1 Step 1): exact `clientMetadata`, `redirectUrl` == the single `redirect_uris`, undefined-before-save + round-trip, `codeVerifier()` throws before save, `redirectToAuthorization` calls `openExternal` once with the exact URL.
- `kiteMcpOAuthCallback.test.ts` (4 `it`s, Task 2 Step 1): resolve `{code,state}` from a real loopback, `error=access_denied`→reject, stray→404 then still resolves a later real callback, abort→reject.
- `mcpConnection.test.ts` (3 new `it`s, Task 3 Step 1): happy `UnauthorizedError`→capture→`finishAuth(code)`→reconnect with identical adapter wiring, non-`UnauthorizedError` rethrow with `finishAuth` never called, custom-url + default-url. Existing `connectKiteMcp` cases unchanged.
- `kiteLogin.test.ts` (4 new `it`s, Task 4 Step 2): success delegating `getLTP`→`callTool("get_ltp",…)`, drift surfaced, `onKiteResponse` wired, close-on-drift-failure closes once + rethrows. Existing `runKiteLogin` cases unchanged.
- `kiteConfig.test.ts` (7 `it`s, Task 5 Step 1): full+port, full default-3000, mcpOnly both-absent-no-throw, mcpOnly honoring `KITE_LOGIN_PORT: "4100"`, only-key→throws naming `KITE_API_SECRET`, only-secret→throws naming `KITE_API_KEY`, non-numeric port→throws. (The two full-mode cases are the "existing assertions gain `mode: "full"`" update.)
- `kiteClient.test.ts`: **UNCHANGED**, asserted as passing in Task 5 Step 8 (the P8§3 proof). `bootstrap.test.ts`: **UNCHANGED** (P8§9.3).

**Type/signature consistency across dependent tasks (checked against the real current code + the SDK `.d.ts`):**
- Task 1's `KiteMcpOAuthProvider` `implements OAuthClientProvider` was verified against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts`: `redirectUrl: string | URL` (returns `string` — ok), `clientMetadata: OAuthClientMetadata`, `state?()` optional (omitted — ok), `clientInformation()`/`saveClientInformation?()`/`tokens()`/`saveTokens()`/`saveCodeVerifier()`/`codeVerifier()`/`redirectToAuthorization()` all match; the metadata literal typechecks against `OAuthClientMetadata` (only `redirect_uris` required, verified in `shared/auth.d.ts`); the round-trip test's minimal `{ client_id, redirect_uris }` and `{ access_token, token_type }` literals satisfy `OAuthClientInformationFull`/`OAuthTokens`' required fields.
- Task 3's `connectKiteMcpOAuth` signature is verbatim P8§15; it consumes Task 1's `KiteMcpOAuthProvider` (via `defaultCreateOAuthProvider`) and Task 2's `captureOAuthCallback` (as the default `captureCallback`); `captureOAuthCallback`'s real return `Promise<{ code: string; state: string | null }>` matches the dep's declared `captureCallback` type; `UnauthorizedError` is a real exported class in `auth.d.ts` (line 63) so `instanceof` works and the test constructs a real instance; `StreamableHTTPClientTransport(url, { authProvider })` + `transport.finishAuth(code)` verified in `streamableHttp.d.ts` (options line 51, `finishAuth` line 105).
- Task 4's `runKiteMcpOnlyLogin` calls `connectMcp({ loginPort, openExternal })` — matching `ConnectKiteMcpOAuthDeps`'s required `{ loginPort, openExternal }` (the seams are optional) — and returns the identical `KiteSession { kite, connection, drift, close }` as `runKiteLogin` (locked decision 6); its `config: KiteMcpOnlyConfig` matches the interface Task 4 adds and Task 5's union preserves.
- Task 5's union + narrowing + branch: verified empirically with strict `tsc` that (a) destructuring full-only fields from the union fails (TS2339) — hence `KiteLoginDeps.config` must narrow to `KiteFullConfig`; (b) passing the union where `KiteFullConfig` is expected fails (TS2322) — hence bootstrap must discriminate; (c) `config.mode === "full"` narrowing resolves both. The ternary is verbatim P8§15; `runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse })` matches `KiteMcpOnlyLoginDeps` (its `connectMcp`/`checkDrift` are optional).
- The `../../../../src/…` import depth in all four new/edited test files matches the existing sibling tests under `test/main/services/kite/`.

**No placeholders:** every step has runnable code, an exact command, and an expected result. No `<fill-in>` remains anywhere. The SDK import paths (`@modelcontextprotocol/sdk/client/auth.js`, `.../shared/auth.js`, `.../client/streamableHttp.js`) are the concrete `.js` specifiers the SDK's `package.json` `exports` map exposes and that `mcpConnection.ts` already uses.

**Documented judgment calls (details the spec left slightly open, or that the real code forced):**
1. **The task ordering inverts the guidance's "crash fix first" suggestion — deliberately, for a verified reason.** The guidance assumed the `kiteConfig` union had "zero dependencies"; the real code contradicts that. Converting `KiteConfig` to a union makes `runKiteLogin`'s body fail to typecheck (TS2339), which forces the `KiteLoginDeps.config` narrowing, which forces the `bootstrap.ts` branch, whose `mcpOnly` arm needs `runKiteMcpOnlyLogin` to exist — verified against a strict `tsc --noEmit` (Case A/Case C in the probe). So the crash fix + narrowing + branch are **type-locked** and land as the final Task 5, on top of the OAuth building blocks (Tasks 1–4). This keeps every commit's tree green (no red-typecheck intermediate state, no interim placeholder), which matters for subagent-driven-development's per-task verification gate. The crash fix landing last is harmless: the phase completes atomically and the manual verification runs only after all tasks land.
2. **`KiteMcpOnlyConfig` is added in Task 4 (its first consumer, `runKiteMcpOnlyLogin`), and `KiteFullConfig` + the union in Task 5.** Splitting the P8§4.1 interface block across two commits is a transient; the final `kiteConfig.ts` (Task 5's full-file rewrite) is spec-exact. This is the minimal per-task change that keeps each tree green (Task 4 needs only `KiteMcpOnlyConfig`; the union would break `runKiteLogin` if introduced in Task 4).
3. **`.env.example` folded into Task 5** (not its own task). It is a doc-only change (P8§4.3) documenting Task 5's mode-detection behavior; a separate task/commit would be noise. Committed with the config change.
4. **`bootstrap.ts` import combined into one statement** (Task 5 Step 6). P8§9.4 says "add the `runKiteMcpOnlyLogin` import alongside the existing `runKiteLogin` import"; a single `import { runKiteLogin, runKiteMcpOnlyLogin } from …` satisfies "alongside" and is cleaner/idiomatic than two imports from the same module. No behavior change.
5. **The injection seams (`createProvider`/`createClient`/`captureCallback`) are kept as three separate seams** exactly as P8§7.1/P8§15 pin them, rather than consolidated (P8§7.3 permits consolidation). Keeping them separate lets the happy-path test assert provider-construction, client-construction, and callback-capture wiring independently — stronger evidence, and it matches the spec's pinned signature verbatim.
6. **The abandoned `callbackPromise` on the authorize-without-redirect success branch** is carried verbatim from P8§7.1 (the spec's pinned orchestration): on that rare path, `abort.abort()` fires and the real `captureOAuthCallback` rejects a promise nobody awaits. The spec (P8§6) explicitly states "the orchestration ignores that rejection when it aborted deliberately," so this plan reproduces it without adding a swallow that would contradict the pinned code; the normal flow awaits `callbackPromise` in the `catch` branch, so this only affects the P8§11-item-5 edge case. Flagged as spec-pinned behavior, not a defect introduced here.
</content>
