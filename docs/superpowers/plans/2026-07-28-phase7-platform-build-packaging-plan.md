# Phase 7 — Platform, Build, Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working dev tree into installable desktop apps and give the repo its first CI — packaging what already exists, shaping nothing new (P7§1). Four concrete deliverables plus one verify-only confirmation: (1) a **test-only** GitHub Actions workflow (`.github/workflows/test.yml`) that runs `cargo test --workspace` then `npm ci && npm run typecheck && npm test` on a single `ubuntu-latest` runner, triggered only on `pull_request` → `main`, building/packaging/signing/shipping **nothing** (P7§3, P7§4); (2) local packaging scripts `build:sidecar`/`package:mac`/`package:win` in `electron-app/package.json` run on the user's own machines, never in CI, no cross-compilation (P7§5); (3) a portable Node script `electron-app/scripts/buildSidecar.mjs` that release-compiles the Rust sidecar and stages the binary under `resources/sidecar-bin/` (P7§6); (4) `electron-app/electron-builder.yml` reusing `resources/` as `buildResources`, shipping the sidecar via `extraResources`, no custom icon, unsigned default targets (P7§7); and one new pure function `resolveSidecarBinaryPath` (`electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`) — the only real application logic and the only unit-tested code the phase adds — extracted from `bootstrap.ts`'s currently-inline dev-relative sidecar path so a packaged build can locate its shipped binary (P7§8). The rustls-not-openssl requirement of §11 is **already satisfied with zero code changes** and is confirmed verify-only (P7§9). This phase adds **zero** order-related surface (P7§13).

**Architecture:** No new architectural surface — this is build/CI tooling over the existing Electron+TypeScript shell and Rust sidecar. The one logic seam: `bootstrap.ts` (the Electron-runtime glue) reads the four Electron-derived values (`app.isPackaged`, `process.resourcesPath`, `process.platform`, `process.env.SIDECAR_BINARY`) and passes them as plain parameters into the new pure `resolveSidecarBinaryPath`, exactly as `appLifecycle.ts`'s `shouldQuitOnAllWindowsClosed` precedent reads `process.platform` in glue and receives it as a parameter — no Electron import in the function body, its own sibling Vitest test, no mocking framework. `SidecarSupervisor` is **not** touched: it still stores `binaryPath` and passes it unchanged to `spawnFn(this.binaryPath, ["--lake-root", this.lakeRoot])` (confirmed in `sidecarSupervisor.ts`) — only the *source* of that argument changes. `buildSidecar.mjs` (Node ESM, `node:fs`/`node:path`/`node:child_process`/`node:url` only) clears+recreates `resources/sidecar-bin/`, runs `cargo build --release -p sidecar` from `../rust-core`, and copies the platform binary (`sidecar` / `sidecar.exe`) to exactly where `resolveSidecarBinaryPath`'s packaged branch looks (`process.resourcesPath/sidecar-bin/…`, placed there by `electron-builder.yml`'s `extraResources` as a real spawnable on-disk file, never inside the asar). CI is deliberately the *narrowest possible* shape — one Linux job, tests only.

**Tech Stack:** TypeScript, Electron 33 (`electron` `33.2.0`), Vitest `2.1.8` (`environment: node`, `test/**/*.test.ts`), electron-vite `2.3.0` (bundles the main process into `out/main`, so module-scope `__dirname` stays `out/main` at runtime regardless of source-file location); Node 22 (matching `@types/node` `22.10.0`); `electron-builder` (new devDependency, a version compatible with `electron` `33.2.0` — `^25`); Node ESM for `buildSidecar.mjs` (no external dep); Rust workspace `rust-core/` (5 crates; `cargo build --release -p sidecar` produces the `sidecar` bin — crate and `[[bin]]` both named `sidecar`, confirmed); GitHub Actions (`actions/checkout@v4`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/setup-node@v4`). No Rust source / `Cargo.toml` / `Cargo.lock` change anywhere in this phase.

## Global Constraints

Every task's requirements implicitly include this section. Values below are copied verbatim from spec **P7§14**.

- **Hard safety invariant (non-negotiable, restated every phase):** the app NEVER places, modifies, cancels, or automates any order. This phase adds **zero** order-related surface: no Kite write-tool method, no new Claude tool grant, no code path reaching `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order`. It is pure build/CI tooling: a test-only CI workflow, local packaging scripts, a sidecar-build helper, an electron-builder config, one pure path-resolution function, and a rustls confirmation. Nothing here touches Kite, Claude, the MCP client, or any order-adjacent code (P7§13).
- **Why CI is a single Linux test job, not a macOS+Windows build matrix (P7§3 — read before editing `test.yml`):** the master design §11 and the original roadmap called for a `macos-latest`+`windows-latest` CI *build* matrix producing installers. This phase **deliberately and explicitly narrows that**, by the user's direct decision, purely for GitHub Actions minute-cost control: `macos-latest` bills at a **10x** multiplier and `windows-latest` at **2x** vs `ubuntu-latest`'s **1x**, and a build matrix (native Rust release compile + Electron bundle + installer packaging per OS) is the heaviest, most expensive job kind. Testing here is platform-agnostic, so one fast Ubuntu test job catches regressions; producing installers needs no CI for a personal, never-distributed tool built on hardware the user already owns. **All building/packaging moves to the user's own machines** (`package:mac`/`package:win`, P7§5). Re-introducing any CI build/matrix step re-opens P7§3 as a separately-approved decision — it is NOT an incremental edit.
- **Binding invariants (P7§14, verbatim):** (a) CI is `ubuntu-latest`-only, single job, **no matrix**, `pull_request`→`main` only, and builds/packages/signs/ships **nothing** (P7§4.3); (b) `SidecarSupervisor` internals are NOT modified — only its `binaryPath` argument's *source* changes (P7§8.4); (c) the dev/unpackaged sidecar path is **byte-identical to today's** (`path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar")`); (d) `envOverride` (`SIDECAR_BINARY`) wins **unconditionally** over both branches; (e) no custom app/installer icon, no new icon asset, tray icons NOT repurposed (P7§7.2); (f) unsigned output only, no code signing/notarization (P7§7.3); (g) no Rust source / `Cargo.toml` / `Cargo.lock` change for rustls — verify-only (P7§9); (h) no order-related surface is added (P7§13).
- **Exact new file paths (P7§14/P7§15):** `.github/workflows/test.yml`; `electron-app/scripts/buildSidecar.mjs`; `electron-app/electron-builder.yml`; `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`; `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts`.
- **Exact modified file paths (P7§14):** `electron-app/src/main/bootstrap.ts` (the `SidecarSupervisor` construction calls `resolveSidecarBinaryPath(...)` instead of the inline path expression; `lakeRoot` untouched); `electron-app/package.json` (three new scripts + one new devDependency `electron-builder`). Plus `electron-app/.gitignore` gains one line ignoring the generated `resources/sidecar-bin/` staging dir — a hygiene addition the spec did not enumerate; see Self-review judgment calls.
- **Exact new npm script names + values (P7§5, P7§14):**
  - `"build:sidecar": "node scripts/buildSidecar.mjs"`
  - `"package:mac": "npm run build:sidecar && electron-vite build && electron-builder --mac"`
  - `"package:win": "npm run build:sidecar && electron-vite build && electron-builder --win"`
- **Exact function signature (pure, no Electron import in the body — P7§8.3/P7§14):**
  ```typescript
  resolveSidecarBinaryPath({ isPackaged, resourcesPath, platform, envOverride }: {
    isPackaged: boolean;
    resourcesPath: string;
    platform: NodeJS.Platform;
    envOverride?: string;
  }): string
  ```
  Behavior: `envOverride` truthy → return it. Else `isPackaged` → `path.join(resourcesPath, "sidecar-bin", platform === "win32" ? "sidecar.exe" : "sidecar")`. Else → `path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar")` (today's dev path, unchanged).
- **Exact `resources/` layout (P7§14):** existing, unchanged — `electron-app/resources/icons/trayIconTemplate.png`, `electron-app/resources/icons/trayIconTemplate@2x.png` (confirmed the only current contents). New, created+cleared by `buildSidecar.mjs` — `electron-app/resources/sidecar-bin/` containing `sidecar` (mac/linux) or `sidecar.exe` (win32).
- **Exact `electron-builder.yml` keys/values (P7§7.1/P7§14):** `directories.buildResources: resources`; `extraResources: [{ from: resources/sidecar-bin, to: sidecar-bin, filter: ["**/*"] }]`; `files: [out/**, resources/icons/**]`; `mac.target: [dmg, zip]`; `win.target: [nsis, zip]`; **no** `icon`, **no** `publish`, **no** signing/notarization config; `appId: com.tradeassistant.app`, `productName: Trade Assistant` (mechanical, adjustable — pinned per P7§7.4, not an open question).
- **Exact CI workflow shape (`.github/workflows/test.yml`, P7§14):** `on: pull_request: branches: [main]` — nothing else. One job, `runs-on: ubuntu-latest`, **no matrix**. Steps in order: checkout → Rust toolchain (+cache) → `cargo test --workspace` (cwd `rust-core/`) → Node 22 setup (+npm cache) → `npm ci` → `npm run typecheck` → `npm test` (all cwd `electron-app/`).
- **Exact Rust build command (in `buildSidecar.mjs`, P7§14):** `cargo build --release -p sidecar`, cwd `../rust-core` relative to the script → binary at `rust-core/target/release/sidecar` (mac/linux) or `rust-core/target/release/sidecar.exe` (win32).
- **New dependency (P7§14):** `electron-app/package.json` devDependencies gains `electron-builder` (`^25`, compatible with `electron` `33.2.0`; exact pin is the implementer's choice). No new Rust dependency, no `Cargo.toml`/`Cargo.lock` change.
- **Comments:** default to none. Only add one when the *why* isn't obvious (a hidden invariant, a workaround, a formula's source). The single warranted comment in this phase is the anti-staleness `fs.rmSync` note in `buildSidecar.mjs` (P7§6, verbatim below). Never restate the next line; never a numbered step block. (From `CLAUDE.md`.)
- **Naming:** TypeScript `camelCase` functions/vars, `PascalCase` types, no Hungarian notation; domain terms (`oi`/`pcr`/`ltp`/`ts`) fine. File names describe responsibility, not kind (`sidecarBinaryPath.ts`, not `utils.ts`). Pure logic (`resolveSidecarBinaryPath`) stays separate from I/O/glue (`bootstrap.ts`, `buildSidecar.mjs`). This phase touches **no** Rust source. (From `CLAUDE.md`.)
- **Commit convention:** each task's implementer commits as the repo's own configured git user (`hadetan <aquibsyed83@gmail.com>`) via plain `git commit` — NEVER pass `--author`, NEVER add a `Co-Authored-By` trailer, NEVER use `--no-verify`. Conventional-commit subjects, matching the sibling plans.
- **One toolchain here (TypeScript/Node), plus GitHub Actions YAML and one Rust build invocation (not a Rust source change).** TypeScript tests run from `electron-app/`: `npx vitest run <path>` (per-file), `npm test` (full suite, its `pretest` runs `npm rebuild better-sqlite3`), `npm run typecheck` (`tsc --noEmit`, `src/**`). The new `sidecarBinaryPath.ts`/`.test.ts` touch **no** `better-sqlite3`, so a single-file `npx vitest run` needs no rebuild prefix; the full `npm test` still rebuilds via its own `pretest`. `buildSidecar.mjs`, `electron-builder.yml`, and `test.yml` are build/CI tooling and are **not** unit-tested (project convention — Phase 5d's tray assets were validated by running the app, not by tests); they are validated by running them (Task 2/Task 3 verification steps + the manual checklist).
- **This is a small phase.** Task 1 is fully independent; Task 4 is fully independent; Task 2 is fully independent; Task 3 references Task 2's file (`scripts/buildSidecar.mjs`) in a script string and adds the `electron-builder` dep, so it should land after Task 2 for its `npm run build:sidecar` to resolve, though its text is authorable in parallel. Speed comes from the plan being unambiguous, not from skipping the one real TDD cycle (Task 1) or the self-review pass.

---

### Task 1: `resolveSidecarBinaryPath` — pure function, unit tests, `bootstrap.ts` wiring

The only piece of real application logic and the only unit-tested code this phase adds (P7§8, P7§11). Extract `bootstrap.ts`'s currently-inline hardcoded dev-relative sidecar path into a pure function so a packaged build can locate its shipped binary, leaving the dev path byte-identical to today's. Mirrors `appLifecycle.ts`'s `shouldQuitOnAllWindowsClosed` precedent exactly: small, single-responsibility, pure, takes Electron-derived values as plain parameters, its own sibling Vitest test, no Electron import, no mocking framework. This is the phase's one genuine TDD cycle (write failing test → implement → pass). Fully independent of Tasks 2/3/4.

**Files:**
- Create: `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`
- Create: `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts`
- Modify: `electron-app/src/main/bootstrap.ts`

**Interfaces:**
- Consumes: `node:path` (`path.join`); module-scope `__dirname` (Node/CommonJS ambient, not an Electron import — the purity rule is "no Electron import in the body"; `__dirname` is available under both electron-vite's `out/main` bundle at runtime and under Vitest, exactly as `tray.ts`'s module-scope `path.join(__dirname, …)` already relies on and its `tray.test.ts` exercises). `NodeJS.Platform` (ambient TS type).
- Produces: `export function resolveSidecarBinaryPath(...)` with the P7§14 signature. `bootstrap.ts`'s `SidecarSupervisor` construction consumes it; `SidecarSupervisor` itself is unchanged (`binaryPath` still stored and passed to `spawnFn(this.binaryPath, …)`).

- [ ] **Step 1: Write the failing test** — create `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts` (import path `../../../../src/…` matches the sibling `sidecarSupervisor.test.ts`/`sidecarProtocol.test.ts`; plain `describe`/`it` with no mocking framework, mirroring `appLifecycle.test.ts`):

```typescript
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSidecarBinaryPath } from "../../../../src/main/services/sidecar/sidecarBinaryPath";

describe("resolveSidecarBinaryPath", () => {
  it("resolves a packaged darwin build to resources/sidecar-bin/sidecar with no .exe", () => {
    const resourcesPath = "/Applications/Trade Assistant.app/Contents/Resources";
    expect(resolveSidecarBinaryPath({ isPackaged: true, resourcesPath, platform: "darwin" })).toBe(
      path.join(resourcesPath, "sidecar-bin", "sidecar"),
    );
  });

  it("resolves a packaged win32 build to resources/sidecar-bin/sidecar.exe", () => {
    const resourcesPath = "/Applications/Trade Assistant.app/Contents/Resources";
    expect(resolveSidecarBinaryPath({ isPackaged: true, resourcesPath, platform: "win32" })).toBe(
      path.join(resourcesPath, "sidecar-bin", "sidecar.exe"),
    );
  });

  it("resolves an unpackaged build to today's dev debug path (asserting only the tail, so it is checkout-location-independent)", () => {
    const result = resolveSidecarBinaryPath({ isPackaged: false, resourcesPath: "/unused", platform: "darwin" });
    expect(result.endsWith(path.join("rust-core", "target", "debug", "sidecar"))).toBe(true);
  });

  it("returns the env override unconditionally, short-circuiting both the packaged and unpackaged branches", () => {
    for (const isPackaged of [true, false]) {
      expect(
        resolveSidecarBinaryPath({ envOverride: "/custom/sidecar", isPackaged, resourcesPath: "/x", platform: "win32" }),
      ).toBe("/custom/sidecar");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarBinaryPath.test.ts`
Expected: FAIL — cannot resolve the import `../../../../src/main/services/sidecar/sidecarBinaryPath` (the module does not exist yet).

- [ ] **Step 3: Implement the pure function** — create `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`:

```typescript
import path from "node:path";

export function resolveSidecarBinaryPath({
  isPackaged,
  resourcesPath,
  platform,
  envOverride,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  envOverride?: string;
}): string {
  if (envOverride) return envOverride;
  if (isPackaged) {
    return path.join(resourcesPath, "sidecar-bin", platform === "win32" ? "sidecar.exe" : "sidecar");
  }
  return path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `electron-app/`): `npx vitest run test/main/services/sidecar/sidecarBinaryPath.test.ts`
Expected: PASS — all four `it` cases green.

- [ ] **Step 5: Wire `bootstrap.ts`** — in `electron-app/src/main/bootstrap.ts`:

Add the import immediately after the `SidecarSupervisor` import (line 6):

```typescript
import { resolveSidecarBinaryPath } from "./services/sidecar/sidecarBinaryPath";
```

Replace the current `SidecarSupervisor` construction:

```typescript
  const supervisor = new SidecarSupervisor({
    binaryPath:
      process.env.SIDECAR_BINARY ??
      path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
```

with:

```typescript
  const supervisor = new SidecarSupervisor({
    binaryPath: resolveSidecarBinaryPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      envOverride: process.env.SIDECAR_BINARY,
    }),
    lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
  });
```

The `lakeRoot` line is untouched. Do **not** remove the `import path from "node:path"` — `path` is still used elsewhere in `bootstrap.ts` (`.env` load, `lakeRoot`, window/preload/renderer paths). `SidecarSupervisor` is **not** modified.

- [ ] **Step 6: Typecheck and run the full suite**

Run (from `electron-app/`): `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean; the four new `sidecarBinaryPath` tests pass; the existing suite stays green (`bootstrap.test.ts` only exercises `handleKiteResponse` and never calls `createApp()`, so the construction change cannot break it; the change is behavior-preserving in dev because the unpackaged branch is byte-identical to the old inline expression).

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarBinaryPath.ts electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts electron-app/src/main/bootstrap.ts
git commit -m "feat(electron-app): extract resolveSidecarBinaryPath for packaged sidecar lookup"
```

---

### Task 2: `buildSidecar.mjs` — release-compile the sidecar and stage it

A small, portable Node ESM script (P7§6) — deliberately Node, not bash, because `cd`-chaining in a package.json script is not reliably portable to Windows, and this must run on both macOS and Windows. It establishes the new `electron-app/scripts/` directory (does not exist today — confirmed). Per the project's build/tooling-not-unit-tested convention (P7§11), it is **not** unit-tested; it is validated by actually running it (Step 3 below, and the manual checklist). Uses only `node:fs`/`node:path`/`node:child_process`/`node:url` — no external dependency. Fully independent of Tasks 1/3/4.

**Files:**
- Create: `electron-app/scripts/buildSidecar.mjs`
- Modify: `electron-app/.gitignore` (ignore the generated `resources/sidecar-bin/` staging dir)

**Interfaces:**
- Consumes: `cargo build --release -p sidecar` (the `sidecar` crate + `[[bin]]`, both named `sidecar` — confirmed; produces `rust-core/target/release/sidecar` or `…/sidecar.exe`); `process.platform`; the repo layout (`electron-app/scripts/` → `../../rust-core`, `../resources/sidecar-bin`).
- Produces: a cleared+recreated `electron-app/resources/sidecar-bin/` containing exactly one binary named `sidecar` (mac/linux) or `sidecar.exe` (win32) — the exact filename `resolveSidecarBinaryPath`'s packaged branch (Task 1) and `electron-builder.yml`'s `extraResources` (Task 3) expect.

- [ ] **Step 1: Create `buildSidecar.mjs`** — create `electron-app/scripts/buildSidecar.mjs`:

```javascript
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustCoreDir = path.resolve(scriptDir, "..", "..", "rust-core");
const sidecarBinDir = path.resolve(scriptDir, "..", "resources", "sidecar-bin");

// Wipe first so a stale binary from a different platform or an earlier
// build can never silently survive into the packaged app.
fs.rmSync(sidecarBinDir, { recursive: true, force: true });
fs.mkdirSync(sidecarBinDir, { recursive: true });

const build = spawnSync("cargo", ["build", "--release", "-p", "sidecar"], {
  cwd: rustCoreDir,
  stdio: "inherit",
});
if (build.error) {
  console.error(`failed to run cargo (is it on PATH?): ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error(`cargo build --release -p sidecar failed (exit ${build.status ?? "null"})`);
  process.exit(build.status ?? 1);
}

const binaryName = process.platform === "win32" ? "sidecar.exe" : "sidecar";
const compiled = path.join(rustCoreDir, "target", "release", binaryName);
const staged = path.join(sidecarBinDir, binaryName);
fs.copyFileSync(compiled, staged);
console.log(`staged ${compiled} -> ${staged}`);
```

- [ ] **Step 2: Ignore the generated staging dir** — append to `electron-app/.gitignore` so a running of the script (Step 3, and every `package:*`) never leaves a large platform-specific binary as a `git add` candidate (`dist/`/`out/`/`target/` are already ignored via the root `.gitignore`, but `resources/sidecar-bin/` is not):

```
resources/sidecar-bin/
```

- [ ] **Step 3: Verify by running it once (not an automated test — the prescribed validation per P7§11)**

Run (from `electron-app/`): `node scripts/buildSidecar.mjs && ls -la resources/sidecar-bin/`
Expected: cargo release-compiles the workspace and the script prints `staged …/rust-core/target/release/sidecar -> …/electron-app/resources/sidecar-bin/sidecar`; the `ls` shows exactly one file — `sidecar` on macOS/Linux (executable bit set) or `sidecar.exe` on Windows. Re-running is idempotent (the dir is wiped+recreated each time). Confirm `git status` does **not** list `resources/sidecar-bin/` (Step 2 ignores it). (This is a real one-time run to validate the script, not a permanent CI/test step; requires a working Rust toolchain.)

- [ ] **Step 4: Commit** (script + gitignore only — never the generated binary)

```bash
git add electron-app/scripts/buildSidecar.mjs electron-app/.gitignore
git commit -m "build(electron-app): buildSidecar.mjs release-compiles and stages the sidecar"
```

---

### Task 3: `electron-builder.yml` + `package.json` packaging scripts and `electron-builder` devDependency

The packaging config and the three npm scripts that drive it (P7§5, P7§7). `electron-builder.yml` reuses the existing `resources/` folder as `buildResources`, ships the sidecar as a real unpacked file via `extraResources` (a native process cannot be spawned from inside an asar, so this must be on-disk — P7§7.1/P7§10 item 5), ships the app bundle + tray icons via `files`, configures no custom icon (P7§7.2), and emits unsigned default targets (P7§7.3). All mechanical fields (`appId`/`productName`/`files`) are already pinned by P7§7.4 and are **not** open questions. References `scripts/buildSidecar.mjs` (Task 2) in the `build:sidecar` script, so land after Task 2.

**Files:**
- Create: `electron-app/electron-builder.yml`
- Modify: `electron-app/package.json` (three new scripts + `electron-builder` devDependency)

**Interfaces:**
- Consumes: `resources/sidecar-bin/` (staged by `buildSidecar.mjs`, Task 2); `out/**` (produced by `electron-vite build`); the existing `resources/icons/**` (Phase 5d tray icons, required in the packaged app because `tray.ts` resolves them relative to `__dirname` → `path.join(__dirname, "..", "..", "resources", "icons", "trayIconTemplate.png")` — confirmed; after bundling `__dirname` is `…/app.asar/out/main`, so the icons must ship at `…/app.asar/resources/icons/`).
- Produces: `electron-builder`-readable config; `npm run build:sidecar`/`package:mac`/`package:win`; unsigned installers under `dist/` (already gitignored) when the `package:*` scripts run on their target OS.

- [ ] **Step 1: Create `electron-builder.yml`** — create `electron-app/electron-builder.yml` (keys/values verbatim from P7§7.1/P7§14):

```yaml
appId: com.tradeassistant.app
productName: Trade Assistant
directories:
  buildResources: resources
files:
  - out/**
  - resources/icons/**
extraResources:
  - from: resources/sidecar-bin
    to: sidecar-bin
    filter:
      - "**/*"
asarUnpack: []
mac:
  target:
    - dmg
    - zip
win:
  target:
    - nsis
    - zip
```

Do **not** add an `icon`, a `publish` block, or any signing/notarization config (P7§7.2/P7§7.3).

- [ ] **Step 2: Add the `electron-builder` devDependency** — run (from `electron-app/`):

```bash
npm install --save-dev electron-builder@^25
```

This resolves the latest `25.x` (compatible with `electron` `33.2.0`), updating `package.json`'s `devDependencies` and `package-lock.json`. Its own `postinstall` (`electron-rebuild -f -w better-sqlite3`) will run — expected and unchanged.

- [ ] **Step 3: Add the three packaging scripts** — in `electron-app/package.json`, add to the `"scripts"` block (values verbatim from P7§5/P7§14; place them after `"postinstall"`):

```json
    "build:sidecar": "node scripts/buildSidecar.mjs",
    "package:mac": "npm run build:sidecar && electron-vite build && electron-builder --mac",
    "package:win": "npm run build:sidecar && electron-vite build && electron-builder --win"
```

(Remember JSON comma rules — the line before these must now end with a comma; these three are the last entries in `"scripts"`.)

- [ ] **Step 4: Verify config wiring and that nothing regressed**

Run (from `electron-app/`):

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "package.json parses"
npm pkg get scripts.build:sidecar scripts.package:mac scripts.package:win
npx electron-builder --version
npm run typecheck && npm test
```

Expected: `package.json parses`; `npm pkg get` prints the three exact script strings; `electron-builder --version` prints a `25.x` version (proving the devDependency installed and its binary resolves); `typecheck` clean and the full test suite green (adding config + scripts changes no runtime behavior the tests exercise). The full `npm run package:mac`/`package:win` build (producing installers under `dist/`) is exercised in the manual checklist, not here — it needs the real sidecar compile and produces platform installers.

- [ ] **Step 5: Commit**

```bash
git add electron-app/electron-builder.yml electron-app/package.json electron-app/package-lock.json
git commit -m "build(electron-app): electron-builder config + package:mac/package:win scripts"
```

---

### Task 4: `.github/workflows/test.yml` — test-only CI on `ubuntu-latest`

The repo's first and only CI (`.github/` does not exist anywhere in the repo — confirmed; the only `.github` dirs are under `node_modules/` and `__references/`, so this is additive with zero merge-conflict risk). Test-only: `cargo test --workspace` then `npm ci && npm run typecheck && npm test`, one `ubuntu-latest` job, no matrix, `pull_request`→`main` only. Builds/packages/signs/ships **nothing** (P7§3, P7§4). Not unit-tested; validated by opening a real PR (manual checklist). Fully independent of Tasks 1/2/3.

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `rust-core/` (5-crate workspace — `cargo test --workspace` runs all); `electron-app/` (`package-lock.json` exists — `npm ci` requires it; `postinstall`/`pretest` rebuild `better-sqlite3`, which works out of the box on `ubuntu-latest`'s preinstalled build toolchain). Node 22 (matching `@types/node` `22.10.0`).
- Produces: a single GitHub Actions check that appears and passes on PRs to `main`.

- [ ] **Step 1: Create the workflow** — create `.github/workflows/test.yml`:

```yaml
name: test

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo registry and target
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: rust-core

      - name: cargo test --workspace
        working-directory: rust-core
        run: cargo test --workspace

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: electron-app/package-lock.json

      - name: npm ci
        working-directory: electron-app
        run: npm ci

      - name: typecheck
        working-directory: electron-app
        run: npm run typecheck

      - name: test
        working-directory: electron-app
        run: npm test
```

- [ ] **Step 2: Verify the cost invariant structurally (P7§4.3)**

Run (from the repo root):

```bash
test "$(grep -c 'runs-on:' .github/workflows/test.yml)" = "1" && echo "OK: exactly one job runner"
grep -q 'runs-on: ubuntu-latest' .github/workflows/test.yml && echo "OK: runner is ubuntu-latest"
grep -Eq 'macos-latest|windows-latest|strategy:|matrix:' .github/workflows/test.yml && echo "COST INVARIANT VIOLATED" || echo "OK: no matrix, no macOS/Windows runner"
```

Expected: `OK: exactly one job runner`, `OK: runner is ubuntu-latest`, `OK: no matrix, no macOS/Windows runner`. This enforces P7§4.3 (single hardcoded `ubuntu-latest` job, no matrix, no expensive-runner minutes). YAML validity and the real green run are confirmed by opening a PR (manual checklist); GitHub validates the workflow syntax on push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: test-only workflow on ubuntu-latest for PRs to main"
```

---

## Manual verification checklist (not a task — never blocks phase completion)

Mirrors prior phases' checklists (an automatable/local golden path plus live follow-ups) and — per the roadmap and P7§12 — **never blocks calling Phase 7 done**. Run with the `verify` skill after the tasks land. Phase 7's definition of done is: (a) `test.yml` exists, is `ubuntu-latest`-only and test-only, and its check appears and passes on a real PR to `main`; (b) `package:mac` on a Mac and `package:win` on real Windows each produce an installable unsigned build whose packaged sidecar spawns and drives a real analysis flow end-to-end (P7§3).

**macOS (on a Mac):**
1. `npm run package:mac` → produces a `dmg` (and `zip`) under `dist/`.
2. Install/open the `dmg`, launch the app once.
3. Confirm the packaged sidecar spawns (status is not stuck "down") and a real analysis flow works end-to-end. (This exercises `buildSidecar.mjs` + `resolveSidecarBinaryPath`'s packaged branch + `extraResources` staging together.)

**Windows (on real Windows hardware/VM — the user has direct access):**
1. `npm run package:win` → produces an `nsis` installer (and `zip`) under `dist/`.
2. Run the installer, launch the app once.
3. Confirm the same: the sidecar spawns and a real analysis flow works end-to-end. (This is the roadmap's surviving "Windows build manually run at least once on real Windows hardware" requirement — P7§3 — now sourced from a local build, not a CI artifact.)

**CI (after the phase lands):**
1. Open a throwaway PR against `main`.
2. Confirm the `test.yml` GitHub Actions check appears and passes (`cargo test --workspace` + `npm ci`/`typecheck`/`test` on `ubuntu-latest`).
3. Confirm no macOS/Windows runner minutes were consumed (only the single Ubuntu job ran).

**rustls acceptance evidence (verify-only, no code change — P7§9):** re-run from `rust-core/` and record the output; this is the written confirmation the phase owes (P7§1 item 4). No task, no commit — nothing to change.
1. `cargo tree -i native-tls` → errors `package ID specification 'native-tls' did not match any packages` (not in the real build graph).
2. `cargo tree -i openssl-sys` → errors `package ID specification 'openssl-sys' did not match any packages` (not in the real build graph).
3. `cargo tree -i rustls` → shows `rustls` / `hyper-rustls` / `tokio-rustls` reached via `reqwest` ← `ingestion` (the only networking crate declaration is `rust-core/crates/ingestion/Cargo.toml`'s `reqwest = { version = "0.12", default-features = false, features = ["blocking", "rustls-tls"] }` — confirmed, `default-features = false` disables reqwest's default `native-tls` and `rustls-tls` selects rustls). The requirement is satisfied by construction with zero changes.

---

## Self-review

**Spec coverage — every P7§ requirement maps to a task or the checklist:**
- P7§1 purpose (four deliverables + one confirmation) → Tasks 1–4 + the rustls checklist item. P7§2 scope → identical mapping. P7§3 CI-scope narrowing → Task 4 + summarized verbatim in Global Constraints and enforced by Task 4 Step 2. P7§4 CI workflow (P7§4.1 trigger/runner, P7§4.2 step order, P7§4.3 cost invariant) → Task 4. P7§5 packaging scripts → Task 3 Step 3. P7§6 `buildSidecar.mjs` (clear+recreate, `cargo build --release -p sidecar` cwd `../rust-core`, platform-branched copy) → Task 2. P7§7 `electron-builder.yml` (P7§7.1 buildResources/extraResources/files, P7§7.2 no icon, P7§7.3 unsigned targets, P7§7.4 pinned mechanical fields) → Task 3 Step 1. P7§8 `resolveSidecarBinaryPath` (P7§8.1 precedent, P7§8.2 location, P7§8.3 signature/behavior, P7§8.4 bootstrap wiring, P7§8.5 location judgment call [settled], P7§8.6 four unit tests) → Task 1. P7§9 rustls → checklist "rustls acceptance evidence" (verify-only, no task — correct per the spec's "no code change"). P7§10 error/edge cases: item 1 (missing binary → existing supervisor "down", no new code) respected by leaving `SidecarSupervisor` untouched (Task 1); item 2 (stale binary) → Task 2's wipe+recreate; item 3 (CI minutes) → Task 4 Step 2 invariant check; item 4 (`better-sqlite3`) → existing unchanged scripts, noted in Task 4 interfaces; item 5 (asar spawn) → Task 3's `extraResources` on-disk staging. P7§11 testing strategy → only Task 1 has real unit tests; Tasks 2/3/4 are run-validated (Task 2 Step 3, Task 3 Step 4, Task 4 Step 2 + checklist). P7§12 manual checklist → the non-task checklist section. P7§13 no-order invariant → Global Constraints (restated) + true of every task. P7§14 global constraints → copied verbatim into Global Constraints. P7§15 file layout → matches the tasks' Create/Modify lists exactly. P7§16 out of scope → nothing in any task adds a CI build/matrix, code signing, cross-compile, custom icon, auto-update, a "both platforms" script, a `SidecarSupervisor` behavior change, or Linux packaging.

**Every enumerated test case is real test code:** P7§8.6's four cases (`packaged_darwin…`, `packaged_win32…`, `unpackaged…tail-only`, `env_override_wins…both-branches`) are the four `it` blocks in Task 1 Step 1 — the env-override case loops over `[true, false]` to prove the unconditional short-circuit, and the unpackaged case asserts only the `path.join("rust-core","target","debug","sidecar")` tail so it is checkout-location-independent (the `__dirname` prefix differs per checkout and between the Vitest source-dir context and the runtime `out/main` bundle).

**Type/signature consistency (checked against the real current code):** the function signature matches P7§14 verbatim; `resolveSidecarBinaryPath`'s unpackaged branch is byte-identical to `bootstrap.ts`'s current inline `path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar")`; `bootstrap.ts` reads `app.isPackaged`/`process.resourcesPath`/`process.platform`/`process.env.SIDECAR_BINARY` (all real Electron/Node globals) and passes them positionally into the object arg, mirroring how it already passes `process.platform` into `shouldQuitOnAllWindowsClosed`; `SidecarSupervisor`'s constructor still takes `{ binaryPath, lakeRoot }` and stores/forwards `binaryPath` unchanged (confirmed — zero supervisor change); `tray.ts`'s `path.join(__dirname, "..", "..", "resources", "icons", "trayIconTemplate.png")` confirms the P7§7.1 rationale for `resources/icons/**` in `files`; the `sidecar` crate + `[[bin]]` are both named `sidecar` (confirmed in `rust-core/crates/sidecar/Cargo.toml`), so `cargo build --release -p sidecar` yields `target/release/sidecar`; `electron-app/package-lock.json` exists (confirmed), so Task 4's `npm ci` and `cache-dependency-path` are valid; the new test's `../../../../src/…` import depth matches the existing sibling tests in `test/main/services/sidecar/`.

**No placeholders:** every step has runnable code, an exact command, and an expected result. `electron-builder@^25` is a concrete, resolvable install spec (npm picks the latest `25.x`); no `<fill-in>` remains anywhere.

**Documented judgment calls (details the spec left slightly open):**
1. **`.gitignore` addition (Task 2 Step 2) — the one deviation from P7§14's enumerated file list.** The spec did not list `electron-app/.gitignore` among modified files, but `buildSidecar.mjs` (and every `package:*` run) generates a large, platform-specific binary under `resources/sidecar-bin/`, and `git check-ignore` confirms that path is **not** currently ignored (only `dist/`/`out/`/`target/`/`node_modules/` are, via the root `.gitignore`). Ignoring `resources/sidecar-bin/` prevents an accidental commit of a build artifact — pure hygiene, touching no invariant, no runtime behavior, no order surface. Flagged here as an additive deviation; the Task 2 commit also scopes its `git add` to only the script + gitignore as belt-and-suspenders.
2. **`electron-builder` pinned as `^25`** (P7§14 explicitly leaves the exact pin to the implementer; `^25` is compatible with `electron` `33.2.0` and matches the spec's own example). Task 3 installs it via `npm install --save-dev electron-builder@^25` so the lockfile resolves a concrete `25.x`.
3. **rustls given no task, folded into the manual checklist** (per the orchestrator's steer and P7§9's explicit "no code change") — it is verify-only acceptance evidence (three `cargo tree` commands), not a TDD cycle, so a task with a commit would be an empty commit.
4. **The two P7§7.4/P7§8.5 flags are treated as settled, not re-litigated:** `electron-builder.yml`'s `files`/`appId`/`productName` are transcribed verbatim from P7§7.1, and `resolveSidecarBinaryPath` lives under `services/sidecar/` (not top-level `src/main/`) exactly as P7§8.2/P7§8.5 resolved.
5. **Task ordering:** Tasks 1, 2, 4 are fully independent; Task 3 references Task 2's `scripts/buildSidecar.mjs` in a script string, so it lands after Task 2 (its text is authorable in parallel, but `npm run build:sidecar` only resolves once the file exists). This is a small phase — parallelism barely matters; the value is in each task being unambiguous and self-contained.
