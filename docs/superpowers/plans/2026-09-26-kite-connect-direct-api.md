# Kite Connect Direct API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Kite MCP tool-call transport with a native Kite Connect REST + WebSocket client, behind the existing `KiteClient`/`McpToolCaller` interface, so both AI-Assisted and Engine-Only modes keep working unchanged while gaining a genuine real-time tick feed for a future live dashboard.

**Architecture:** `KiteClient` already depends only on a small `McpToolCaller` interface (`callTool(name, args)`), not on MCP itself. This plan writes a new REST-backed implementation of that same interface (`kiteRestCaller.ts`), a local instrument-search replacement (`kiteInstrumentMaster.ts`, since Kite Connect's REST API has no search endpoint), and a `KiteTicker` wrapper (`kiteTicker.ts`) that is connected but not yet consumed by any UI. Everything MCP-specific (`mcpConnection.ts`, `kiteMcpLoginFlow.ts`, `mcpDriftMonitor.ts`, `mcpClientAdapter.ts`, MCP-only auth mode) is deleted, since there is no longer a free/fallback mode — this app now requires a registered Kite Connect developer app unconditionally.

**Tech Stack:** TypeScript, Electron main process, Vitest, Node's built-in `fetch`, the official `kiteconnect` npm package (used only for its `KiteTicker` class).

## Global Constraints

- Full replace, not hybrid: Kite MCP is deleted everywhere, not kept alongside the new native connection.
- Zero free fallback, accepted knowingly: `loadKiteConfig` throws at startup unless both `KITE_API_KEY` and `KITE_API_SECRET` are set — there is no MCP-only mode anymore.
- REST calls are hand-rolled `fetch` (matching this codebase's existing style); only the WebSocket ticker uses the official `kiteconnect` npm package (its binary tick-packet parsing is not hand-rolled).
- `KiteClient`'s method surface must never grow to cover a Kite write tool (order placement/modification/cancellation) — this is a permanent, load-bearing safety invariant restated in every phase that touches this area.
- No token/session persistence of any kind — a fresh login is required every app launch, unchanged from today.
- No new Settings UI for credentials — `.env` only (`KITE_API_KEY`, `KITE_API_SECRET`, `KITE_LOGIN_PORT`).
- Nothing in this plan subscribes to or consumes ticks. `kiteTicker.ts` is built and tested in isolation only — a future live-dashboard project is the first real consumer.
- Full spec: `docs/superpowers/specs/2026-09-26-phase16-kite-connect-direct-api-design.md`.

---

### Task 1: `kiteConfig.ts` — collapse to a single required shape

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteConfig.ts`
- Test: `electron-app/test/main/services/kite/kiteConfig.test.ts`

**Interfaces:**
- Produces: `KiteConfig { apiKey: string; apiSecret: string; loginPort: number }`, `KiteConfigError`, `loadKiteConfig(env?: NodeJS.ProcessEnv): KiteConfig` — consumed by Task 6 (`kiteLogin.ts`) and Task 7 (`bootstrap.ts`).

- [ ] **Step 1: Rewrite the test file to describe the single-shape contract**

Replace the entire contents of `electron-app/test/main/services/kite/kiteConfig.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { KiteConfigError, loadKiteConfig } from "../../../../src/main/services/kite/kiteConfig";

describe("loadKiteConfig", () => {
  it("parses a fully populated env", () => {
    const config = loadKiteConfig({ KITE_API_KEY: "k123", KITE_API_SECRET: "s456", KITE_LOGIN_PORT: "4100" });
    expect(config).toEqual({ apiKey: "k123", apiSecret: "s456", loginPort: 4100 });
  });

  it("defaults loginPort to 3000 when KITE_LOGIN_PORT is absent", () => {
    expect(loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s" })).toEqual({
      apiKey: "k",
      apiSecret: "s",
      loginPort: 3000,
    });
  });

  it("throws KiteConfigError when both credentials are absent", () => {
    expect(() => loadKiteConfig({})).toThrow(KiteConfigError);
    expect(() => loadKiteConfig({})).toThrow(/KITE_API_KEY and KITE_API_SECRET are both required/);
  });

  it("throws KiteConfigError when only KITE_API_KEY is present", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k" })).toThrow(KiteConfigError);
  });

  it("throws KiteConfigError when only KITE_API_SECRET is present", () => {
    expect(() => loadKiteConfig({ KITE_API_SECRET: "s" })).toThrow(KiteConfigError);
  });

  it("throws KiteConfigError on a non-numeric KITE_LOGIN_PORT", () => {
    expect(() => loadKiteConfig({ KITE_API_KEY: "k", KITE_API_SECRET: "s", KITE_LOGIN_PORT: "abc" })).toThrow(
      KiteConfigError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteConfig.test.ts` (from `electron-app/`)
Expected: FAIL — the current `loadKiteConfig` still returns `{ mode: "full" | "mcpOnly", ... }`, so every `toEqual` assertion mismatches, and the both-absent case does not throw.

- [ ] **Step 3: Rewrite the source file**

Replace the entire contents of `electron-app/src/main/services/kite/kiteConfig.ts`:

```typescript
export class KiteConfigError extends Error {}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  loginPort: number;
}

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
  if (!apiKey || !apiSecret) {
    throw new KiteConfigError(
      "KITE_API_KEY and KITE_API_SECRET are both required — register a Kite Connect developer app " +
        "at developers.kite.trade (₹500/month) and set both in electron-app/.env. There is no fallback mode.",
    );
  }
  return { apiKey, apiSecret, loginPort };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteConfig.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteConfig.ts electron-app/test/main/services/kite/kiteConfig.test.ts
git commit -m "kite config: require a registered Kite Connect app, drop MCP-only mode"
```

---

### Task 2: `kiteInstrumentMaster.ts` — instrument master cache + search

**Files:**
- Create: `electron-app/src/main/services/kite/kiteInstrumentMaster.ts`
- Test: `electron-app/test/main/services/kite/kiteInstrumentMaster.test.ts`

**Interfaces:**
- Produces: `KiteInstrumentRow { instrument_token: string; tradingsymbol: string; exchange: string; segment: string; name: string }`, `parseInstrumentCsv(csv: string): KiteInstrumentRow[]`, `class KiteInstrumentMaster` with constructor `(deps: { apiKey: string; accessToken: string; cacheDir: string; fetchFn?: typeof fetch; now?: () => Date })` and `async search(query: string): Promise<KiteInstrumentRow[]>` — consumed by Task 3 (`kiteRestCaller.ts`) and Task 6 (`kiteLogin.ts`).

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/kite/kiteInstrumentMaster.test.ts`:

```typescript
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiteInstrumentMaster, parseInstrumentCsv } from "../../../../src/main/services/kite/kiteInstrumentMaster";

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ta-kite-instruments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const SAMPLE_CSV =
  "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" +
  '408065,1594,INFY,"INFOSYS LIMITED",0,,0,0.05,1,EQ,NSE,NSE\n' +
  '779521,3045,TCS,"TATA CONSULTANCY SERVICES, LTD",0,,0,0.05,1,EQ,NSE,NSE\n';

function fakeResponse(overrides: Partial<{ ok: boolean; status: number; text: () => Promise<string> }> = {}) {
  return { ok: true, status: 200, text: async () => SAMPLE_CSV, ...overrides };
}

describe("parseInstrumentCsv", () => {
  it("parses rows and handles a quoted field containing a literal comma", () => {
    const rows = parseInstrumentCsv(SAMPLE_CSV);
    expect(rows).toEqual([
      { instrument_token: "408065", tradingsymbol: "INFY", name: "INFOSYS LIMITED", segment: "NSE", exchange: "NSE" },
      {
        instrument_token: "779521",
        tradingsymbol: "TCS",
        name: "TATA CONSULTANCY SERVICES, LTD",
        segment: "NSE",
        exchange: "NSE",
      },
    ]);
  });

  it("returns an empty array for an empty/header-only CSV", () => {
    expect(parseInstrumentCsv("")).toEqual([]);
    expect(parseInstrumentCsv("instrument_token,tradingsymbol,name,segment,exchange\n")).toEqual([]);
  });
});

describe("KiteInstrumentMaster", () => {
  it("downloads and caches on first search, then searches case-insensitively by symbol or name", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({
      apiKey: "k123",
      accessToken: "at999",
      cacheDir: tempCacheDir(),
      fetchFn,
      now: () => new Date("2026-09-26T05:00:00.000Z"),
    });

    const bySymbol = await master.search("infy");
    expect(bySymbol).toEqual([
      { instrument_token: "408065", tradingsymbol: "INFY", name: "INFOSYS LIMITED", segment: "NSE", exchange: "NSE" },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.kite.trade/instruments",
      { headers: { Authorization: "token k123:at999", "X-Kite-Version": "3" } },
    );

    const byName = await master.search("tata consultancy");
    expect(byName).toHaveLength(1);
    expect(byName[0].tradingsymbol).toBe("TCS");

    // A second search on the same instance must not re-download.
    await master.search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("caps results at 25", async () => {
    const manyRows = Array.from({ length: 40 }, (_, i) => `${i},1,SYM${i},"NAME ${i}",0,,0,0.05,1,EQ,NSE,NSE`).join("\n");
    const csv = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" + manyRows;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => csv });
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    expect(await master.search("sym")).toHaveLength(25);
  });

  it("reuses a same-day on-disk cache across instances without re-downloading", async () => {
    const cacheDir = tempCacheDir();
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const now = () => new Date("2026-09-26T05:00:00.000Z");

    await new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn, now }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // A fresh instance (simulating a new app launch) reads the on-disk cache instead of re-downloading.
    const second = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn, now });
    await second.search("tcs");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-downloads when the on-disk cache is from a prior IST day", async () => {
    const cacheDir = tempCacheDir();
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());

    await new KiteInstrumentMaster({
      apiKey: "k",
      accessToken: "a",
      cacheDir,
      fetchFn,
      now: () => new Date("2026-09-25T05:00:00.000Z"),
    }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await new KiteInstrumentMaster({
      apiKey: "k",
      accessToken: "a",
      cacheDir,
      fetchFn,
      now: () => new Date("2026-09-26T05:00:00.000Z"),
    }).search("infy");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("treats a corrupt on-disk cache file as stale rather than crashing", async () => {
    const cacheDir = tempCacheDir();
    writeFileSync(path.join(cacheDir, "kite-instruments.json"), "not valid json{{{", "utf8");
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir, fetchFn });

    await expect(master.search("infy")).resolves.toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when the download fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    await expect(master.search("infy")).rejects.toThrow(/kite instrument master download failed: HTTP 403/);
  });

  it("returns an empty array for a blank query without downloading", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse());
    const master = new KiteInstrumentMaster({ apiKey: "k", accessToken: "a", cacheDir: tempCacheDir(), fetchFn });

    expect(await master.search("   ")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteInstrumentMaster.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../../src/main/services/kite/kiteInstrumentMaster'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/kite/kiteInstrumentMaster.ts`:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface KiteInstrumentRow {
  instrument_token: string;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  name: string;
}

export interface KiteInstrumentMasterDeps {
  apiKey: string;
  accessToken: string;
  cacheDir: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface CacheFile {
  fetchedOnIstDate: string;
  rows: KiteInstrumentRow[];
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_RESULTS = 25;

function istDateString(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

// Kite's instrument dump is RFC4180-ish CSV: a double-quoted field may
// contain a literal comma (some company names do), so a naive split(",")
// would misalign columns on those rows.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseInstrumentCsv(csv: string): KiteInstrumentRow[] {
  const lines = csv.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  const col = (name: string): number => header.indexOf(name);
  const tokenCol = col("instrument_token");
  const symbolCol = col("tradingsymbol");
  const nameCol = col("name");
  const segmentCol = col("segment");
  const exchangeCol = col("exchange");
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return {
      instrument_token: fields[tokenCol] ?? "",
      tradingsymbol: fields[symbolCol] ?? "",
      name: fields[nameCol] ?? "",
      segment: fields[segmentCol] ?? "",
      exchange: fields[exchangeCol] ?? "",
    };
  });
}

export class KiteInstrumentMaster {
  private readonly deps: KiteInstrumentMasterDeps;
  private cache: CacheFile | null = null;

  constructor(deps: KiteInstrumentMasterDeps) {
    this.deps = deps;
  }

  private cachePath(): string {
    return path.join(this.deps.cacheDir, "kite-instruments.json");
  }

  // Private: search() is the only public entry point, so a caller can never
  // search a stale/never-downloaded cache by forgetting to call this first.
  private async ensureFresh(): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const today = istDateString(now);
    if (this.cache?.fetchedOnIstDate === today) return;

    if (!this.cache) {
      try {
        const raw = await readFile(this.cachePath(), "utf8");
        const parsed = JSON.parse(raw) as CacheFile;
        if (parsed.fetchedOnIstDate === today) {
          this.cache = parsed;
          return;
        }
      } catch {
        // No cache file yet, or it's corrupt/unreadable -- fall through to a
        // fresh download either way, same as a first-ever launch.
      }
    }

    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn("https://api.kite.trade/instruments", {
      headers: { Authorization: `token ${this.deps.apiKey}:${this.deps.accessToken}`, "X-Kite-Version": "3" },
    });
    if (!response.ok) {
      throw new Error(`kite instrument master download failed: HTTP ${response.status}`);
    }
    const csv = await response.text();
    const rows = parseInstrumentCsv(csv);
    this.cache = { fetchedOnIstDate: today, rows };
    await mkdir(this.deps.cacheDir, { recursive: true });
    await writeFile(this.cachePath(), JSON.stringify(this.cache), "utf8");
  }

  async search(query: string): Promise<KiteInstrumentRow[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    await this.ensureFresh();
    return (this.cache?.rows ?? [])
      .filter((row) => row.tradingsymbol.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteInstrumentMaster.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteInstrumentMaster.ts electron-app/test/main/services/kite/kiteInstrumentMaster.test.ts
git commit -m "kite: add instrument master download/cache/search, replacing MCP search_instruments"
```

---

### Task 3: `kiteRestCaller.ts` — the REST-backed `McpToolCaller`

**Files:**
- Create: `electron-app/src/main/services/kite/kiteRestCaller.ts`
- Test: `electron-app/test/main/services/kite/kiteRestCaller.test.ts`

**Interfaces:**
- Consumes: `KiteInstrumentMaster.search(query: string): Promise<KiteInstrumentRow[]>` (Task 2).
- Produces: `createKiteRestCaller(deps: { apiKey: string; accessToken: string; instrumentMaster: Pick<KiteInstrumentMaster, "search">; baseUrl?: string; fetchFn?: typeof fetch }): McpToolCaller` — consumed by Task 6 (`kiteLogin.ts`). `McpToolCaller` is the existing interface from `kiteClient.ts` (`{ callTool(name, args): Promise<unknown> }`) — unchanged.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/main/services/kite/kiteRestCaller.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createKiteRestCaller } from "../../../../src/main/services/kite/kiteRestCaller";

function fakeResponse(body: unknown, overrides: Partial<{ ok: boolean; status: number }> = {}) {
  return { ok: true, status: 200, json: async () => body, ...overrides };
}

function baseDeps(fetchFn = vi.fn()) {
  return {
    apiKey: "k123",
    accessToken: "at999",
    instrumentMaster: { search: vi.fn().mockResolvedValue([{ instrument_token: "408065", tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", name: "INFOSYS" }]) },
    fetchFn,
  };
}

describe("createKiteRestCaller", () => {
  it("search_instruments delegates to instrumentMaster.search and wraps the result as {data: [...]}", async () => {
    const deps = baseDeps();
    const caller = createKiteRestCaller(deps);

    const result = await caller.callTool("search_instruments", { query: "infy" });

    expect(deps.instrumentMaster.search).toHaveBeenCalledWith("infy");
    expect(result).toEqual({ data: [{ instrument_token: "408065", tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", name: "INFOSYS" }] });
  });

  it("get_historical_data builds the correct URL and query params", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { candles: [] } }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool("get_historical_data", {
      instrument_token: "408065",
      interval: "5minute",
      from: "2026-09-01 09:15:00",
      to: "2026-09-26 15:30:00",
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.kite.trade/instruments/historical/408065/5minute?from=2026-09-01+09%3A15%3A00&to=2026-09-26+15%3A30%3A00",
    );
    expect(init.headers).toEqual({ Authorization: "token k123:at999", "X-Kite-Version": "3" });
  });

  it("get_quotes/get_ohlc/get_ltp send repeated i= params for each instrument", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: {} }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool("get_quotes", { instruments: ["NSE:INFY", "NSE:TCS"] });
    expect(String(fetchFn.mock.calls[0][0])).toBe("https://api.kite.trade/quote?i=NSE%3AINFY&i=NSE%3ATCS");

    await caller.callTool("get_ohlc", { instruments: ["NSE:INFY"] });
    expect(String(fetchFn.mock.calls[1][0])).toBe("https://api.kite.trade/quote/ohlc?i=NSE%3AINFY");

    await caller.callTool("get_ltp", { instruments: ["NSE:INFY"] });
    expect(String(fetchFn.mock.calls[2][0])).toBe("https://api.kite.trade/quote/ltp?i=NSE%3AINFY");
  });

  it.each([
    ["get_margins", "https://api.kite.trade/user/margins"],
    ["get_holdings", "https://api.kite.trade/portfolio/holdings"],
    ["get_positions", "https://api.kite.trade/portfolio/positions"],
    ["get_profile", "https://api.kite.trade/user/profile"],
    ["get_gtts", "https://api.kite.trade/gtt/triggers"],
  ])("%s calls %s with no query params", async (toolName, expectedUrl) => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: {} }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await caller.callTool(toolName, {});

    expect(String(fetchFn.mock.calls[0][0])).toBe(expectedUrl);
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { user_id: "AB1234" } }));
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await expect(caller.callTool("get_profile", {})).resolves.toEqual({ data: { user_id: "AB1234" } });
  });

  it("throws an error embedding the raw error_type on a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({ error_type: "TokenException", message: "Invalid access token" }, { ok: false, status: 403 }),
    );
    const caller = createKiteRestCaller(baseDeps(fetchFn));

    await expect(caller.callTool("get_profile", {})).rejects.toThrow(
      /Kite API error \(403 TokenException\): Invalid access token/,
    );
  });

  it("throws for an unsupported tool name", async () => {
    const caller = createKiteRestCaller(baseDeps());
    await expect(caller.callTool("place_order", {})).rejects.toThrow(/unsupported tool "place_order"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteRestCaller.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../../src/main/services/kite/kiteRestCaller'"

- [ ] **Step 3: Write the implementation**

Create `electron-app/src/main/services/kite/kiteRestCaller.ts`:

```typescript
import type { McpToolCaller } from "./kiteClient";
import type { KiteInstrumentMaster } from "./kiteInstrumentMaster";

export interface KiteRestCallerDeps {
  apiKey: string;
  accessToken: string;
  instrumentMaster: Pick<KiteInstrumentMaster, "search">;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function createKiteRestCaller(deps: KiteRestCallerDeps): McpToolCaller {
  const baseUrl = deps.baseUrl ?? "https://api.kite.trade";
  const fetchFn = deps.fetchFn ?? fetch;
  const authHeaders = {
    Authorization: `token ${deps.apiKey}:${deps.accessToken}`,
    "X-Kite-Version": "3",
  };

  async function getJson(pathname: string, query?: Record<string, string | string[]>): Promise<unknown> {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    const response = await fetchFn(url, { headers: authHeaders });
    const body = await response.json();
    if (!response.ok) {
      // error_type/message are Kite Connect's own documented error envelope
      // shape; embedding error_type verbatim keeps kiteSessionState.ts's
      // looksLikeSessionExpiry matching with zero changes to that file (it
      // already regexes for "tokenexception").
      const errorType = (body as { error_type?: string })?.error_type ?? "unknown";
      const message = (body as { message?: string })?.message ?? response.statusText;
      throw new Error(`Kite API error (${response.status} ${errorType}): ${message}`);
    }
    return body;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      switch (name) {
        case "search_instruments":
          return { data: await deps.instrumentMaster.search(String(args.query)) };
        case "get_historical_data":
          return getJson(`/instruments/historical/${args.instrument_token}/${args.interval}`, {
            from: String(args.from),
            to: String(args.to),
          });
        case "get_quotes":
          return getJson("/quote", { i: args.instruments as string[] });
        case "get_ohlc":
          return getJson("/quote/ohlc", { i: args.instruments as string[] });
        case "get_ltp":
          return getJson("/quote/ltp", { i: args.instruments as string[] });
        case "get_margins":
          return getJson("/user/margins");
        case "get_holdings":
          return getJson("/portfolio/holdings");
        case "get_positions":
          return getJson("/portfolio/positions");
        case "get_profile":
          return getJson("/user/profile");
        case "get_gtts":
          return getJson("/gtt/triggers");
        default:
          throw new Error(`kiteRestCaller: unsupported tool "${name}"`);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteRestCaller.test.ts`
Expected: PASS (11 tests, incl. the 5 `it.each` cases)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteRestCaller.ts electron-app/test/main/services/kite/kiteRestCaller.test.ts
git commit -m "kite: add REST-backed McpToolCaller, replacing the MCP tool-call transport"
```

---

### Task 4: `kiteTicker.ts` — the WebSocket ticker wrapper

**Files:**
- Modify: `electron-app/package.json` (add `kiteconnect` dependency)
- Create: `electron-app/src/main/services/kite/kiteTicker.ts`
- Test: `electron-app/test/main/services/kite/kiteTicker.test.ts`

**Interfaces:**
- Produces: `KiteTickerClient { connect(); subscribe(instrumentTokens: number[], mode?: "ltp"|"quote"|"full"); onTick(handler); onConnectionChange(handler); disconnect() }`, `createKiteTicker(apiKey: string, accessToken: string, deps?: { createTicker? }): KiteTickerClient` — consumed by Task 6 (`kiteLogin.ts`). Not consumed by any UI in this plan.

- [ ] **Step 1: Add the `kiteconnect` dependency**

In `electron-app/package.json`, add to `"dependencies"` (alongside the existing `"better-sqlite3"` etc.):

```json
    "kiteconnect": "^5.3.0",
```

Run: `cd electron-app && npm install`
Expected: `kiteconnect` appears in `package-lock.json`; installs cleanly (Node >= 18, already satisfied by this project's engine requirements).

- [ ] **Step 2: Write the failing test**

Create `electron-app/test/main/services/kite/kiteTicker.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createKiteTicker } from "../../../../src/main/services/kite/kiteTicker";
import type { KiteTickerLike } from "../../../../src/main/services/kite/kiteTicker";

function fakeTickerLike(): KiteTickerLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    modeLTP: "ltp",
    modeQuote: "quote",
    modeFull: "full",
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    setMode: vi.fn(),
    autoReconnect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    emit: (event: string, ...args: unknown[]) => {
      (handlers.get(event) ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe("createKiteTicker", () => {
  it("constructs with api_key/access_token and enables auto-reconnect with infinite retries", () => {
    const fake = fakeTickerLike();
    const createTicker = vi.fn().mockReturnValue(fake);

    createKiteTicker("k123", "at999", { createTicker });

    expect(createTicker).toHaveBeenCalledWith({ api_key: "k123", access_token: "at999" });
    expect(fake.autoReconnect).toHaveBeenCalledWith(true, -1, 5);
  });

  it("connect() and disconnect() delegate to the underlying ticker", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.connect();
    client.disconnect();

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("subscribe() calls subscribe then setMode with the resolved mode constant, defaulting to full", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.subscribe([408065]);
    expect(fake.subscribe).toHaveBeenCalledWith([408065]);
    expect(fake.setMode).toHaveBeenCalledWith("full", [408065]);

    client.subscribe([408065], "ltp");
    expect(fake.setMode).toHaveBeenLastCalledWith("ltp", [408065]);
  });

  it("maps connect/reconnect/noreconnect/error events to onConnectionChange", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const statuses: string[] = [];
    client.onConnectionChange((status) => statuses.push(status));

    fake.emit("connect");
    fake.emit("reconnect");
    fake.emit("noreconnect");
    fake.emit("error", new Error("boom"));

    expect(statuses).toEqual(["connected", "reconnecting", "error", "error"]);
  });

  it("forwards the ticks payload to onTick handlers", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const received: unknown[] = [];
    client.onTick((ticks) => received.push(ticks));

    fake.emit("ticks", [{ instrument_token: 408065, last_price: 101.5 }]);

    expect(received).toEqual([[{ instrument_token: 408065, last_price: 101.5 }]]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- kiteTicker.test.ts` (from `electron-app/`)
Expected: FAIL with "Cannot find module '../../../../src/main/services/kite/kiteTicker'"

- [ ] **Step 4: Write the implementation**

Create `electron-app/src/main/services/kite/kiteTicker.ts`:

```typescript
import { KiteTicker } from "kiteconnect";

export type TickerConnectionStatus = "connected" | "reconnecting" | "error";

export interface KiteTickerClient {
  connect(): void;
  subscribe(instrumentTokens: number[], mode?: "ltp" | "quote" | "full"): void;
  onTick(handler: (ticks: unknown[]) => void): void;
  onConnectionChange(handler: (status: TickerConnectionStatus) => void): void;
  disconnect(): void;
}

// The subset of the kiteconnect npm package's real KiteTicker surface this
// wrapper depends on -- named so a test can inject a fake without importing
// the real (network-opening) class. Verified against kiteconnectjs's own
// lib/ticker.ts (github.com/zerodha/kiteconnectjs), not guessed from docs.
export interface KiteTickerLike {
  connect(): void;
  disconnect(): void;
  subscribe(tokens: number[]): void;
  setMode(mode: string, tokens: number[]): void;
  autoReconnect(enable: boolean, maxRetry: number, maxDelaySeconds: number): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  modeLTP: string;
  modeQuote: string;
  modeFull: string;
}

export interface KiteTickerFactoryDeps {
  createTicker?: (opts: { api_key: string; access_token: string }) => KiteTickerLike;
}

function defaultCreateTicker(opts: { api_key: string; access_token: string }): KiteTickerLike {
  return new KiteTicker(opts) as unknown as KiteTickerLike;
}

export function createKiteTicker(
  apiKey: string,
  accessToken: string,
  deps: KiteTickerFactoryDeps = {},
): KiteTickerClient {
  const ticker = (deps.createTicker ?? defaultCreateTicker)({ api_key: apiKey, access_token: accessToken });
  // -1 max_retry means retry forever, per kiteconnectjs's own autoReconnect contract.
  ticker.autoReconnect(true, -1, 5);

  const tickHandlers: ((ticks: unknown[]) => void)[] = [];
  const connectionHandlers: ((status: TickerConnectionStatus) => void)[] = [];
  const notifyConnection = (status: TickerConnectionStatus): void => connectionHandlers.forEach((h) => h(status));

  ticker.on("connect", () => notifyConnection("connected"));
  ticker.on("reconnect", () => notifyConnection("reconnecting"));
  ticker.on("noreconnect", () => notifyConnection("error"));
  ticker.on("error", () => notifyConnection("error"));
  ticker.on("ticks", (...args: unknown[]) => tickHandlers.forEach((h) => h(args[0] as unknown[])));

  return {
    connect: () => ticker.connect(),
    subscribe: (instrumentTokens, mode = "full") => {
      ticker.subscribe(instrumentTokens);
      const modeValue = mode === "ltp" ? ticker.modeLTP : mode === "quote" ? ticker.modeQuote : ticker.modeFull;
      ticker.setMode(modeValue, instrumentTokens);
    },
    onTick: (handler) => tickHandlers.push(handler),
    onConnectionChange: (handler) => connectionHandlers.push(handler),
    disconnect: () => ticker.disconnect(),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- kiteTicker.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add electron-app/package.json electron-app/package-lock.json electron-app/src/main/services/kite/kiteTicker.ts electron-app/test/main/services/kite/kiteTicker.test.ts
git commit -m "kite: add KiteTicker websocket wrapper (connected, not yet consumed by any UI)"
```

---

### Task 5: `kiteClient.ts` — drop the `login()` method

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteClient.ts`
- Test: `electron-app/test/main/services/kite/kiteClient.test.ts`

**Interfaces:**
- Produces: `KiteClient` with 10 methods (was 11) — `searchInstruments`, `getHistoricalData`, `getQuotes`, `getOHLC`, `getLTP`, `getMargins`, `getHoldings`, `getPositions`, `getProfile`, `getGtts`. `KITE_READ_TOOL_NAMES` loses its `login` entry. Consumed unchanged by Task 6, `analysisBridge.ts`, `readinessGate.ts`, the Claude persona pipeline, and `claudeProvider.ts`'s `KITE_READ_TOOL_ALLOWLIST` (which is *derived* from `Object.values(KITE_READ_TOOL_NAMES)`, so it automatically drops `mcp__kite__login` with no source or test edit needed there — confirmed by reading `claudeProvider.test.ts`, whose one assertion on the allowlist's exact contents also computes it from `KITE_READ_TOOL_NAMES` rather than a hardcoded string).

- [ ] **Step 1: Update the failing test**

In `electron-app/test/main/services/kite/kiteClient.test.ts`, change the `EXPECTED_METHODS` array (remove `"login"`):

```typescript
const EXPECTED_METHODS = [
  "getGtts",
  "getHistoricalData",
  "getHoldings",
  "getLTP",
  "getMargins",
  "getOHLC",
  "getPositions",
  "getProfile",
  "getQuotes",
  "searchInstruments",
];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteClient.test.ts` (from `electron-app/`)
Expected: FAIL — `methodNames()` still returns `login` among the 11 current methods, so `toEqual(EXPECTED_METHODS)` mismatches.

- [ ] **Step 3: Remove `login()` from the implementation**

In `electron-app/src/main/services/kite/kiteClient.ts`, remove the `login: "login"` line from `KITE_READ_TOOL_NAMES`:

```typescript
export const KITE_READ_TOOL_NAMES = {
  searchInstruments: "search_instruments",
  getHistoricalData: "get_historical_data",
  getQuotes: "get_quotes",
  getOHLC: "get_ohlc",
  getLTP: "get_ltp",
  getMargins: "get_margins",
  getHoldings: "get_holdings",
  getPositions: "get_positions",
  getProfile: "get_profile",
  getGtts: "get_gtts",
} as const;
```

And remove the `login()` method entirely:

```typescript
  login(): Promise<unknown> {
    return this.call(KITE_READ_TOOL_NAMES.login, {});
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteClient.test.ts`
Expected: PASS (6 tests)

Also run: `npm test -- claudeProvider.test.ts`
Expected: PASS unchanged — its allowlist assertion is computed from `KITE_READ_TOOL_NAMES`, so it automatically reflects the 10-tool set with no edit.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteClient.ts electron-app/test/main/services/kite/kiteClient.test.ts
git commit -m "kite client: drop login() -- dead code once MCP-only mode is gone"
```

---

### Task 6: `kiteLogin.ts` — rewire `runKiteLogin` onto the native client

**Files:**
- Modify: `electron-app/src/main/services/kite/kiteLogin.ts`
- Test: `electron-app/test/main/services/kite/kiteLogin.test.ts`

**Interfaces:**
- Consumes: `loadKiteConfig`/`KiteConfig` (Task 1), `KiteInstrumentMaster` (Task 2), `createKiteRestCaller` (Task 3), `createKiteTicker`/`KiteTickerClient` (Task 4), `KiteClient` (Task 5, unchanged constructor), `captureRequestToken`/`exchangeAccessToken` (`kiteOAuth.ts`, unchanged).
- Produces: `KiteSession { kite: KiteClient; ticker: KiteTickerClient; close(): Promise<void> }`, `runKiteLogin(deps): Promise<KiteSession>` — consumed by Task 7 (`bootstrap.ts`). `runKiteMcpOnlyLogin` and `KiteMcpOnlyConfig` no longer exist.

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `electron-app/test/main/services/kite/kiteLogin.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runKiteLogin } from "../../../../src/main/services/kite/kiteLogin";

function baseDeps() {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const ticker = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    onTick: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  return {
    callTool,
    ticker,
    deps: {
      config: { apiKey: "k123", apiSecret: "s456", loginPort: 3000 },
      cacheDir: "/tmp/does-not-matter",
      captureRequestToken: vi.fn().mockResolvedValue("req_tok"),
      exchangeAccessToken: vi.fn().mockResolvedValue({ data: { access_token: "at_999" } }),
      postForm: vi.fn(),
      openExternal: vi.fn(),
      createRestCaller: vi.fn().mockReturnValue({ callTool }),
      createTicker: vi.fn().mockReturnValue(ticker),
    },
  };
}

describe("runKiteLogin", () => {
  it("runs capture -> exchange -> builds a REST-backed KiteClient and a ticker", async () => {
    const { deps, callTool, ticker } = baseDeps();

    const session = await runKiteLogin(deps);

    expect(deps.captureRequestToken).toHaveBeenCalledWith({
      port: 3000,
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=k123&v=3",
      openExternal: deps.openExternal,
    });
    expect(deps.exchangeAccessToken).toHaveBeenCalledWith({
      apiKey: "k123",
      apiSecret: "s456",
      requestToken: "req_tok",
      postForm: deps.postForm,
    });
    expect(deps.createRestCaller).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "k123", accessToken: "at_999" }),
    );
    expect(deps.createTicker).toHaveBeenCalledWith("k123", "at_999");
    expect(session.ticker).toBe(ticker);

    await session.kite.getLTP(["NSE:INFY"]);
    expect(callTool).toHaveBeenCalledWith("get_ltp", { instruments: ["NSE:INFY"] });
  });

  it("wires onKiteResponse through to the session's KiteClient", async () => {
    const { deps, callTool } = baseDeps();
    callTool.mockResolvedValue({ data: { user_id: "AB1234" } });
    const onKiteResponse = vi.fn();

    const session = await runKiteLogin({ ...deps, onKiteResponse });
    await session.kite.getProfile();

    expect(onKiteResponse).toHaveBeenCalledWith({ data: { user_id: "AB1234" } });
  });

  it("rejects with a clear error when the token exchange has no access_token", async () => {
    const { deps } = baseDeps();
    deps.exchangeAccessToken = vi.fn().mockResolvedValue({ data: {} });

    await expect(runKiteLogin(deps)).rejects.toThrow(/did not include data.access_token/);
    expect(deps.createRestCaller).not.toHaveBeenCalled();
  });

  it("close() disconnects the ticker", async () => {
    const { deps, ticker } = baseDeps();
    const session = await runKiteLogin(deps);

    await session.close();

    expect(ticker.disconnect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- kiteLogin.test.ts` (from `electron-app/`)
Expected: FAIL — the current `runKiteLogin` calls `connectMcp`/`checkDrift`, not `createRestCaller`/`createTicker`, and there is no `cacheDir` param yet.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `electron-app/src/main/services/kite/kiteLogin.ts`:

```typescript
import { KiteInstrumentMaster } from "./kiteInstrumentMaster";
import { createKiteRestCaller } from "./kiteRestCaller";
import { createKiteTicker } from "./kiteTicker";
import type { KiteTickerClient } from "./kiteTicker";
import { captureRequestToken, exchangeAccessToken } from "./kiteOAuth";
import { KiteClient } from "./kiteClient";
import type { KiteConfig } from "./kiteConfig";

export interface KiteLoginDeps {
  config: KiteConfig;
  cacheDir: string;
  captureRequestToken: typeof captureRequestToken;
  exchangeAccessToken: typeof exchangeAccessToken;
  postForm: (url: string, form: Record<string, string>) => Promise<unknown>;
  openExternal: (url: string) => void;
  onKiteResponse?: (response: unknown) => void;
  createRestCaller?: typeof createKiteRestCaller;
  createTicker?: typeof createKiteTicker;
}

export interface KiteSession {
  kite: KiteClient;
  ticker: KiteTickerClient;
  close(): Promise<void>;
}

function extractAccessToken(tokenResponse: unknown): string {
  const token = (tokenResponse as { data?: { access_token?: unknown } })?.data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("kite session/token response did not include data.access_token");
  }
  return token;
}

export async function runKiteLogin(deps: KiteLoginDeps): Promise<KiteSession> {
  const { apiKey, apiSecret, loginPort } = deps.config;
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  const requestToken = await deps.captureRequestToken({ port: loginPort, loginUrl, openExternal: deps.openExternal });
  const tokenResponse = await deps.exchangeAccessToken({ apiKey, apiSecret, requestToken, postForm: deps.postForm });
  const accessToken = extractAccessToken(tokenResponse);

  const instrumentMaster = new KiteInstrumentMaster({ apiKey, accessToken, cacheDir: deps.cacheDir });
  const createRestCaller = deps.createRestCaller ?? createKiteRestCaller;
  const caller = createRestCaller({ apiKey, accessToken, instrumentMaster });
  const kite = new KiteClient(caller, { onResponse: deps.onKiteResponse });
  const createTicker = deps.createTicker ?? createKiteTicker;
  const ticker = createTicker(apiKey, accessToken);

  return {
    kite,
    ticker,
    close: async () => ticker.disconnect(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- kiteLogin.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/kiteLogin.ts electron-app/test/main/services/kite/kiteLogin.test.ts
git commit -m "kite login: build the native REST client and ticker instead of connecting MCP"
```

---

### Task 7: `bootstrap.ts` + `rendererApi.ts` + `SettingsWindow.tsx` — collapse the mode branch, remove drift wiring

**Files:**
- Modify: `electron-app/src/main/bootstrap.ts`
- Modify: `electron-app/src/main/ipc/rendererApi.ts`
- Modify: `electron-app/src/renderer/SettingsWindow.tsx`
- Test (mechanical fixture updates, see Step 5): `electron-app/test/renderer/testBridge.ts`, `electron-app/test/renderer/App.test.tsx`, `electron-app/test/renderer/AppShell.test.tsx`, `electron-app/test/renderer/SettingsWindow.test.tsx`, `electron-app/test/main/ipc/rendererApi.test.ts`, `electron-app/test/main/ipc/settingsBridge.test.ts`

**Interfaces:**
- Consumes: `runKiteLogin`/`KiteSession` (Task 6).
- Produces: `AppStatus { sidecar, kiteSession }` (no more `driftWarning`), `BannerKind = "kiteLogin" | "sidecarDown"` (no more `"mcpDrift"`).

There is no `runKiteMcpOnlyLogin`/`KiteMcpOnlyConfig` left to import once Task 6 lands, so this task's `bootstrap.ts` edit both collapses the branch and removes the now-dead drift-warning wiring in the same pass — they're the same `login()` closure.

- [ ] **Step 1: Update `rendererApi.ts`**

In `electron-app/src/main/ipc/rendererApi.ts`, change:

```typescript
export interface AppStatus {
  sidecar: SidecarStatus;
  kiteSession: KiteSessionStatus;
  driftWarning: string | null;
}

export type BannerKind = "kiteLogin" | "mcpDrift" | "sidecarDown";
```

to:

```typescript
export interface AppStatus {
  sidecar: SidecarStatus;
  kiteSession: KiteSessionStatus;
}

export type BannerKind = "kiteLogin" | "sidecarDown";
```

- [ ] **Step 2: Update `bootstrap.ts`**

In `electron-app/src/main/bootstrap.ts`:

Remove the import: `import { runKiteLogin, runKiteMcpOnlyLogin } from "./services/kite/kiteLogin";` becomes `import { runKiteLogin } from "./services/kite/kiteLogin";`.

Remove the line `let driftWarning: string | null = null;`.

Change `currentStatus`:

```typescript
  const currentStatus = (): AppStatus => ({ sidecar: sidecarStatus, kiteSession: sessionState.status });
```

Change the `login()` closure's session-creation block from:

```typescript
        const newSession =
          config.mode === "full"
            ? await runKiteLogin({ config, captureRequestToken, exchangeAccessToken, postForm, openExternal, onKiteResponse })
            : await runKiteMcpOnlyLogin({ config, openExternal, onKiteResponse });
        // Defense in depth: the "change" listener above already closes a
        // session as soon as it goes stale, but close whatever is still
        // referenced here too so a redundant login() call can never leak it.
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        driftWarning = newSession.drift.hasDrift
          ? `MCP tools changed: added [${newSession.drift.added.join(", ")}], removed [${newSession.drift.removed.join(", ")}]`
          : null;
        if (newSession.drift.hasDrift) {
          dispatchBanner({ kind: "mcpDrift", message: driftWarning as string });
        }
        sessionState.markAuthenticated();
```

to:

```typescript
        const newSession = await runKiteLogin({
          config,
          cacheDir: app.getPath("userData"),
          captureRequestToken,
          exchangeAccessToken,
          postForm,
          openExternal,
          onKiteResponse,
        });
        // Defense in depth: the "change" listener above already closes a
        // session as soon as it goes stale, but close whatever is still
        // referenced here too so a redundant login() call can never leak it.
        if (previousSession && previousSession !== newSession) {
          void previousSession.close().catch(() => {});
        }
        session = newSession;
        sessionState.markAuthenticated();
```

- [ ] **Step 3: Update `SettingsWindow.tsx`**

In `electron-app/src/renderer/SettingsWindow.tsx`, remove line 133:

```typescript
        {status?.driftWarning && <Banner variant="warning">{status.driftWarning}</Banner>}
```

(Leave the two `StatusDot` lines immediately above it untouched.)

- [ ] **Step 4: Run the typecheck to find every fixture that must change**

Run: `cd electron-app && npm run typecheck`
Expected: FAIL, listing every test file constructing an `AppStatus`-typed object literal with an excess `driftWarning` property (`testBridge.ts`, `App.test.tsx`, `AppShell.test.tsx`, `rendererApi.test.ts`, `settingsBridge.test.ts`, `SettingsWindow.test.tsx`).

- [ ] **Step 5: Strip the now-removed field from every test fixture**

Every occurrence is the literal substring `, driftWarning: null` immediately before a closing `}` — remove it everywhere with:

```bash
cd electron-app
sed -i '' 's/, driftWarning: null//g' \
  test/renderer/testBridge.ts \
  test/renderer/App.test.tsx \
  test/renderer/AppShell.test.tsx \
  test/main/ipc/rendererApi.test.ts \
  test/main/ipc/settingsBridge.test.ts \
  test/renderer/SettingsWindow.test.tsx
```

Then, in `electron-app/test/renderer/AppShell.test.tsx`, reword the one test title that references the now-removed banner kind (its body only ever exercised `kiteLogin`, never actually asserted on `mcpDrift` — the title just over-claimed):

```typescript
  it("renders a warning Banner for a kiteLogin banner", () => {
```

(was: `it("renders a warning Banner for kiteLogin/mcpDrift banners", () => {`)

- [ ] **Step 6: Run the typecheck and full test suite to verify everything passes**

Run: `npm run typecheck`
Expected: PASS, no errors.

Run: `npm test`
Expected: PASS across the whole suite (this is the first point where a full run makes sense, since Steps 1-3 touched three files no single earlier task owned).

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/bootstrap.ts electron-app/src/main/ipc/rendererApi.ts electron-app/src/renderer/SettingsWindow.tsx \
  electron-app/test/renderer/testBridge.ts electron-app/test/renderer/App.test.tsx electron-app/test/renderer/AppShell.test.tsx \
  electron-app/test/main/ipc/rendererApi.test.ts electron-app/test/main/ipc/settingsBridge.test.ts electron-app/test/renderer/SettingsWindow.test.tsx
git commit -m "bootstrap: collapse to one native login path, remove MCP drift-warning wiring"
```

---

### Task 8: Delete every MCP-specific file and the SDK dependency

**Files:**
- Modify: `electron-app/src/main/services/claude/claudeProvider.ts` (stale comment referencing deleted `mcpDriftMonitor.ts`)
- Delete: `electron-app/src/main/services/kite/mcpConnection.ts`
- Delete: `electron-app/src/main/services/kite/kiteMcpLoginFlow.ts`
- Delete: `electron-app/src/main/services/kite/mcpDriftMonitor.ts`
- Delete: `electron-app/src/main/services/kite/mcpClientAdapter.ts`
- Delete: `electron-app/test/main/services/kite/mcpConnection.test.ts`
- Delete: `electron-app/test/main/services/kite/kiteMcpLoginFlow.test.ts`
- Delete: `electron-app/test/main/services/kite/mcpDriftMonitor.test.ts`
- Delete: `electron-app/test/main/services/kite/mcpClientAdapter.test.ts`
- Modify: `electron-app/package.json` (remove `@modelcontextprotocol/sdk`)
- Modify: `electron-app/.env.example`

**Interfaces:** None — by this point (after Tasks 5-7), nothing in `src/` *imports* any of the eight files below. This task only removes dead code; it changes no interface any other task depends on. One file (`claudeProvider.ts`) has a stale *comment* mentioning `mcpDriftMonitor.ts` by name with no actual import — fixed in Step 1 so it doesn't dangle after that file is deleted.

- [ ] **Step 1: Fix the stale comment in `claudeProvider.ts`**

In `electron-app/src/main/services/claude/claudeProvider.ts`, this comment names `mcpDriftMonitor.ts`, which is about to be deleted:

```typescript
// A positive allowlist, not a subtraction from any baseline that might grow:
// Task 5's EXPECTED_KITE_TOOLS is explicitly slated to absorb the live
// tools/list surface (see mcpDriftMonitor.ts), which would include any
// currently-unnamed write tool -- deriving this allowlist from that baseline
// would silently widen it to cover a write tool the moment that happens.
// KITE_READ_TOOL_NAMES is KiteClient's own closed, hand-curated method set
// instead, so this allowlist can only ever grow when a human adds a new
// method to KiteClient itself.
```

Replace it with:

```typescript
// A positive allowlist, not a subtraction from any baseline that might grow:
// KITE_READ_TOOL_NAMES is KiteClient's own closed, hand-curated method set,
// so this allowlist can only ever grow when a human adds a new method to
// KiteClient itself -- there is no live remote tool listing it could
// silently inherit a write tool from (the MCP-era tools/list drift check
// this comment used to reference no longer exists).
```

Run: `npm test -- claudeProvider.test.ts` (from `electron-app/`)
Expected: PASS, unchanged — this is a comment-only edit.

- [ ] **Step 2: Confirm nothing still imports the files about to be deleted**

Run: `grep -rn "mcpConnection\|kiteMcpLoginFlow\|mcpDriftMonitor\|mcpClientAdapter" electron-app/src`

Expected: no output. (If anything appears, stop — it means an earlier task's edit was incomplete, or Step 1 above was skipped; do not proceed with deletion until this is empty.)

- [ ] **Step 3: Delete the eight files**

```bash
cd electron-app
git rm src/main/services/kite/mcpConnection.ts \
  src/main/services/kite/kiteMcpLoginFlow.ts \
  src/main/services/kite/mcpDriftMonitor.ts \
  src/main/services/kite/mcpClientAdapter.ts \
  test/main/services/kite/mcpConnection.test.ts \
  test/main/services/kite/kiteMcpLoginFlow.test.ts \
  test/main/services/kite/mcpDriftMonitor.test.ts \
  test/main/services/kite/mcpClientAdapter.test.ts
```

- [ ] **Step 4: Remove the `@modelcontextprotocol/sdk` dependency**

In `electron-app/package.json`, remove this line from `"devDependencies"`:

```json
    "@modelcontextprotocol/sdk": "1.12.0",
```

Run: `npm install`
Expected: `package-lock.json` updates to drop the dependency; installs cleanly.

- [ ] **Step 5: Update `.env.example`**

Replace the contents of `electron-app/.env.example`:

```
# Kite Connect developer-console credentials (dev-only; never committed).
# Copy this file to electron-app/.env.
#
# Both are required -- register a Kite Connect developer app at
# developers.kite.trade (paid, ₹500/month) and set both values here.
# There is no fallback/free mode.
KITE_API_KEY=your_kite_connect_api_key
KITE_API_SECRET=your_kite_connect_api_secret
# Loopback OAuth redirect port.
KITE_LOGIN_PORT=3000
```

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — no remaining reference to any deleted file, no remaining reference to `@modelcontextprotocol/sdk`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "kite: delete all MCP-specific code and the modelcontextprotocol/sdk dependency"
```

---

### Task 9: Manual verification (not automatable — requires a live, paid Kite Connect account)

This task has no code changes and no automated test; it is the only real proof this works, since Kite Connect's live REST/WebSocket behavior cannot be fully faked in unit tests. Perform each step in order; do not skip ahead if one fails.

- [ ] **Step 1:** Register a Kite Connect developer app at `developers.kite.trade` (requires the ₹500/month subscription active). Set `KITE_API_KEY`/`KITE_API_SECRET` in `electron-app/.env` to the real values.

- [ ] **Step 2:** Temporarily comment out `KITE_API_KEY`/`KITE_API_SECRET` in `.env` and launch the app (`npm run dev` from `electron-app/`). Confirm it fails fast at startup with the new `KiteConfigError` message ("KITE_API_KEY and KITE_API_SECRET are both required...") rather than a silent degrade or an unrelated crash.

- [ ] **Step 3:** Restore the real credentials in `.env`, relaunch, click "Login to Kite." Confirm the same request_token → access_token OAuth browser flow works exactly as before.

- [ ] **Step 4:** Run a real Engine-Only analysis end to end. Confirm instrument search returns real results (proves `KiteInstrumentMaster`'s download+search), and confirm the analysis produces real algo output (proves `kiteRestCaller`'s historical-data call).

- [ ] **Step 5:** Run the AI-Assisted chat mode end to end at least once. Confirm no behavior change from before this migration — this proves the shared `KiteClient` transport swap didn't regress it.

- [ ] **Step 6:** Write a small throwaway Node script (not committed) that imports `createKiteTicker` from the built app, connects, subscribes to one real NSE instrument token in `"full"` mode, and logs incoming ticks for about 30 seconds during live market hours. Confirm continuously-arriving, changing price data — this is the actual proof this plan exists for, since nothing in the shipped app calls `kiteTicker.ts` yet.

- [ ] **Step 7:** If practical, let an `access_token` sit until the next trading day (Kite Connect tokens expire daily), then make a call. Confirm a "needs login" banner appears via the existing `markNeedsLogin` path, not an unhandled crash.

- [ ] **Step 8:** Report back that this is done. Per the project's two-phase plan, the next step is the live Engine-Only dashboard itself (full-screen chart, continuous re-compute on candle close, visual-only verdict) — that is separate, future work, not part of this plan.
