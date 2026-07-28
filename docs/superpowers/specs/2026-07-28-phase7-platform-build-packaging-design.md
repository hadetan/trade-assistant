# Phase 7 — Platform, Build, Packaging

Status: approved by user 2026-07-28 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`, concretizing §11 (Platform & Build) of `docs/superpowers/specs/2026-07-18-trade-assistant-design.md` and the roadmap's Phase 7 entry (`docs/superpowers/plans/2026-07-18-implementation-roadmap.md` §"Phase 7"). Section references: "§N" → master design; "P7§N" → this document. **This document deliberately and explicitly narrows the CI scope of both §11 and the roadmap's Phase 7 definition-of-done — see P7§3, which a future reader must read before trusting the master design's literal §11 text on CI.**

## P7§1 Purpose

Phase 7 is the final phase. It **packages what already exists and shapes nothing new architecturally** (roadmap §"Why this order": "Platform/build (7) comes last because it packages what already exists rather than shaping it"). By the end of Phase 6 the app is a complete, working desktop trading *assistant*: an Electron + TypeScript + React shell, a Rust compute core (`rust-core/`) spawned as a sidecar subprocess, and Claude reached via the `claude` CLI subprocess as the AI reasoning layer. What has never existed is a way to turn that working dev tree into an installable desktop application, and there is no CI of any kind (`.github/` does not exist — confirmed).

This phase adds exactly four things and one confirmation:

1. A test-only GitHub Actions workflow that runs on pull requests targeting `main`, on a single `ubuntu-latest` runner (P7§4).
2. Local packaging scripts (`package:mac` / `package:win`) that build the Rust sidecar in release mode, bundle the Electron app, and produce unsigned installers — run on the user's own Mac and Windows machines, never in CI (P7§5, P7§6, P7§7).
3. One new pure function, `resolveSidecarBinaryPath`, extracted from `bootstrap.ts`'s currently-hardcoded dev-relative sidecar path so a packaged build can locate its shipped sidecar binary (P7§8) — the only piece of real application logic this phase adds, and the only piece with unit tests.
4. A written confirmation that the rustls-not-openssl requirement of §11 is **already satisfied with zero code changes** (P7§9).

Everything obeys the master hard constraints (§2, §4). This phase adds **zero** order-related surface — no Kite write-tool method, no new Claude tool grant, no order/GTT code path of any kind. It is pure build/CI tooling (P7§13).

## P7§2 Scope

**In scope:**

1. CI: a new `.github/workflows/test.yml` that runs **tests only** — `cargo test --workspace` (from `rust-core/`), then `npm ci && npm run typecheck && npm test` (from `electron-app/`) — on a single `ubuntu-latest` runner, triggered only on `pull_request` targeting `main`. CI never builds, packages, signs, or ships any artifact (P7§3, P7§4).
2. Local packaging: new npm scripts `build:sidecar`, `package:mac`, `package:win` in `electron-app/package.json` (P7§5).
3. A new portable Node script `electron-app/scripts/buildSidecar.mjs` that compiles the Rust sidecar in release mode and copies the binary into `electron-app/resources/sidecar-bin/` (P7§6).
4. A new `electron-app/electron-builder.yml` that reuses the existing `electron-app/resources/` folder as `buildResources`, ships the sidecar binary via `extraResources`, configures no custom icon, and emits unsigned installers (P7§7).
5. A new pure function `resolveSidecarBinaryPath` (new file `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`), unit-tested, replacing `bootstrap.ts`'s inline hardcoded sidecar path (P7§8).
6. A written verify-only confirmation of the rustls stack (P7§9). **No Rust source or `Cargo.toml`/`Cargo.lock` change.**

**Not in scope (deferred, or permanently out of scope — P7§16 has the full list):**

- Any change to the no-order-placement safety invariant (§2, §4) — unaffected (P7§13).
- **Any macOS or Windows CI runner** — CI is `ubuntu-latest`-only, test-only (P7§3). This is the deliberate narrowing of §11 and the roadmap.
- **Any CI build/package/sign/ship step** — CI produces no artifact of any kind (P7§3, P7§4).
- **Code signing / notarization** — unsigned output only, unchanged from §11's explicit stance (P7§7.3).
- **Cross-compilation** — each packaging script runs on the OS it targets (P7§5).
- **A custom app/installer icon** — electron-builder's default Electron icon is used; the Phase 5d tray icons are **not** reused/repurposed as app icons, and no new icon asset is added (P7§7.2).
- **Any change to `SidecarSupervisor`'s spawn/restart/timeout machinery** — `binaryPath` is now sourced from `resolveSidecarBinaryPath` instead of an inline expression; nothing inside the supervisor changes (P7§8.4).
- Auto-update, delta updates, a release/publish channel, changelog generation — none exist and none are added (P7§16).

**Locked decisions this document writes up verbatim (from the completed brainstorming session):** (1) CI does only testing, nothing else, on `ubuntu-latest` only, on `pull_request` to `main` only — an explicit, cost-driven narrowing of §11/roadmap; (2) all packaging happens locally on the user's own machines via `package:mac`/`package:win`, never in CI, no cross-compilation; (3) `electron-builder.yml` reuses `resources/` as `buildResources`, ships the sidecar via `extraResources`, configures no custom icon, and emits unsigned default targets; (4) `buildSidecar.mjs` is a portable Node script (not bash) that clears `resources/sidecar-bin/` first, runs `cargo build --release -p sidecar`, and copies the platform-appropriate binary, and is not unit-tested; (5) `resolveSidecarBinaryPath` is a pure function extracted from `bootstrap.ts`, mirroring the `shouldQuitOnAllWindowsClosed` precedent, unit-tested; (6) rustls is already satisfied — verify-only, no code change; (7) manual Windows verification stays a manual, never-blocking step, now sourced from a local `package:win` build instead of a CI artifact.

## P7§3 The CI-scope narrowing (deliberate, user-directed divergence from §11 and the roadmap)

**This section exists because this phase contradicts the literal text of the master design doc and the original roadmap, on purpose, by the user's explicit direction. A future reader (or a future phase's plan-writer) must read this before trusting §11 on CI.**

What the master design **originally said** (§11, verbatim): *"The lowest-friction, most reliable build path (matching what the wider ecosystem's own tooling defaults to) is a GitHub Actions CI matrix building each target natively on its own OS runner (`macos-latest` + `windows-latest`, comfortably inside the free tier for infrequent personal builds) rather than cross-compiling from one machine."*

What the roadmap **originally said** (§"Phase 7", verbatim):
- Scope bullet: *"GitHub Actions CI matrix (`macos-latest` + `windows-latest`), each building the Rust sidecar natively on its own OS runner (§11) — no cross-compilation from a single machine."*
- Definition of done: *"a CI run produces installable (unsigned) builds for both macOS and Windows from the same commit, and the Windows build has been manually run at least once on real Windows hardware, not just built by CI."*

**What was decided instead (and why):** CI does **testing only**, on a **single `ubuntu-latest` runner**, triggered **only on `pull_request` targeting `main`**. CI never builds, packages, signs, or ships any artifact. All building/packaging moves to the user's own machines (P7§5).

The reason is GitHub Actions minute-cost control. GitHub bills `macos-latest` minutes at a **10x** multiplier and `windows-latest` at **2x** against a private repo's included-minutes allowance, while `ubuntu-latest` bills at **1x**. A macOS+Windows *build* matrix — the heaviest kind of job (native Rust release compile + Electron bundle + installer packaging on each OS) — would burn the allowance fastest exactly on the most expensive runners. During brainstorming the user asked directly, *"you sure this is going to be cheap right?"*, and the design that satisfied that concern is the one written here: a single fast `ubuntu-latest` test job that only runs when a PR is opened against `main`. Testing is platform-agnostic here (the Rust core and the Electron main/renderer logic are not OS-specific in a way the test suite depends on), so a single Linux runner is sufficient to catch regressions; producing the actual installers does not need CI at all for a personal, never-distributed tool the user builds on hardware they already own.

**Consequence for the definition of done:** Phase 7's definition of done is *not* "a CI run produces installable builds for both platforms." It is: (a) `.github/workflows/test.yml` exists, is `ubuntu-latest`-only and test-only, and its check appears and passes on a real PR to `main`; (b) `npm run package:mac` on a Mac and `npm run package:win` on real Windows hardware/VM each produce an installable unsigned build whose packaged sidecar spawns and drives a real analysis flow end-to-end (P7§12). The "Windows build manually run at least once on real Windows hardware" requirement from the roadmap **survives unchanged in spirit** — only its source changes, from a CI-built artifact to a locally-built one (P7§12).

## P7§4 CI workflow (`.github/workflows/test.yml`, new)

`.github/` does not currently exist anywhere in the repo (confirmed). This workflow is the first and only CI in the project.

### P7§4.1 Triggering and runner

- Trigger: `on: pull_request: branches: [main]` — **only** pull requests targeting `main`. Not `push`, not `schedule`, not `workflow_dispatch`.
- Runner: exactly one job, `runs-on: ubuntu-latest`, **no `strategy.matrix`**. This is a hard invariant (P7§4.3).

### P7§4.2 Job steps (in order)

1. `actions/checkout@v4`.
2. Rust toolchain: install a stable Rust toolchain (e.g. `dtolnay/rust-toolchain@stable`) and cache the cargo registry/target (e.g. `Swatinem/rust-cache@v2`) — caching is an efficiency nicety, not a correctness requirement.
3. `cargo test --workspace` with working directory `rust-core/`.
4. Node toolchain: `actions/setup-node@v4` pinned to the project's Node major (Node 22, matching `@types/node` `22.10.0`), with npm caching keyed on `electron-app/package-lock.json`.
5. `npm ci` with working directory `electron-app/`. `npm ci` runs the existing `postinstall` (`electron-rebuild -f -w better-sqlite3`), which rebuilds the `better-sqlite3` native module against the Electron ABI on the Linux runner — this is the same script that already runs on the user's dev machines, unchanged.
6. `npm run typecheck` (`tsc --noEmit`) with working directory `electron-app/`.
7. `npm test` (`vitest run`; its existing `pretest` runs `npm rebuild better-sqlite3`) with working directory `electron-app/`.

The two working-directory hops (`rust-core/` for cargo, `electron-app/` for npm) mirror the repo's existing two-package layout; there is no root-level `package.json` or `Cargo.toml` step.

### P7§4.3 The cost invariant (binding on all future edits)

The workflow has **exactly one job**, hardcoded `runs-on: ubuntu-latest`, with **no matrix**. This is a hard invariant a future edit must not violate: adding a `macos-latest`/`windows-latest` matrix entry, or any build/package step, silently re-introduces the 10x/2x-multiplier cost this design exists to avoid (P7§3). Any future desire to build in CI must be a deliberate, separately-approved decision that re-opens P7§3 — not an incremental edit to this file.

## P7§5 Local packaging scripts (`electron-app/package.json`)

Three new npm scripts. `package:mac` must be run on a Mac; `package:win` must be run on Windows (real hardware or VM). There is no cross-compilation and no single-machine both-targets script — each script produces only its own OS's installer, consistent with §11's no-cross-compile stance and the sidecar being a native release binary that must be compiled on its target OS.

```json
"build:sidecar": "node scripts/buildSidecar.mjs",
"package:mac": "npm run build:sidecar && electron-vite build && electron-builder --mac",
"package:win": "npm run build:sidecar && electron-vite build && electron-builder --win"
```

Order, per script: (1) `build:sidecar` compiles the Rust sidecar in release mode and stages the binary under `resources/sidecar-bin/` (P7§6); (2) `electron-vite build` produces the bundled main/preload/renderer under `out/` (the existing `build` script's tool, reused); (3) `electron-builder --mac`/`--win` reads `electron-builder.yml` (P7§7) and emits the unsigned installer(s). `electron-builder` is added as a new `devDependency` (P7§14).

The existing `postinstall`/`predev`/`prestart` `electron-rebuild -f -w better-sqlite3` scripts are **unchanged**; electron-builder natively understands electron-rebuild'd native modules and repackages `better-sqlite3` per platform automatically, so this phase adds no new native-module step (P7§10, item 4).

## P7§6 `buildSidecar.mjs` (`electron-app/scripts/buildSidecar.mjs`, new)

A small, portable Node ESM script. It is deliberately Node, not bash: `cd`-chaining in a package.json script is not reliably portable to Windows, and this script must run correctly on both macOS and Windows (a standing project requirement that the app "must be built in a way that it can be built and used for macOS and Windows"). `electron-app/scripts/` does not exist today (confirmed — the Phase 5d tray PNGs were checked in as static placeholder assets, not generated by any script); this file establishes that directory. Consistent with the project's convention that build/tooling assets are not unit-tested, this script is **not** unit-tested — it is validated by actually running it once per platform during manual verification (P7§12).

Behavior, in order:

1. **Clear and recreate `electron-app/resources/sidecar-bin/`.** This is deliberate anti-staleness: a binary left over from a different platform or a prior build must never silently linger and get packaged. This is the one place in the script that warrants a why-comment per CLAUDE.md's comment convention (the `why`, not the `what`):

   ```js
   // Wipe first so a stale binary from a different platform or an earlier
   // build can never silently survive into the packaged app.
   fs.rmSync(sidecarBinDir, { recursive: true, force: true });
   fs.mkdirSync(sidecarBinDir, { recursive: true });
   ```

2. **Compile the sidecar in release mode:** run `cargo build --release -p sidecar`, with the child process's `cwd` set to `../rust-core` resolved relative to the script's own location (`path.resolve(scriptDir, "..", "..", "rust-core")` from `electron-app/scripts/`). Use `child_process.spawnSync` with `stdio: "inherit"` so cargo output streams through, and fail the script (non-zero exit) if cargo fails. The sidecar crate and its `[[bin]]` are both named `sidecar`, so `-p sidecar` produces the binary named `sidecar` (confirmed).

3. **Copy the compiled binary** into `resources/sidecar-bin/` under the same platform-appropriate name, branching on `process.platform`:
   - `win32`: copy `rust-core/target/release/sidecar.exe` → `resources/sidecar-bin/sidecar.exe`.
   - otherwise (mac/linux): copy `rust-core/target/release/sidecar` → `resources/sidecar-bin/sidecar`.

   The destination filename matches exactly what `resolveSidecarBinaryPath` will look for in the packaged app (P7§8): `sidecar.exe` on Windows, `sidecar` elsewhere.

The script uses only `node:fs`, `node:path`, `node:child_process`, and `node:url` (for `import.meta.url` → `scriptDir`) — no external dependency, no image/build library.

## P7§7 `electron-builder.yml` (`electron-app/electron-builder.yml`, new)

### P7§7.1 buildResources and extraResources

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

- **`directories.buildResources: resources`** reuses the **existing** `electron-app/resources/` folder (created in Phase 5d for the tray icons, `resources/icons/trayIconTemplate.png` + `trayIconTemplate@2x.png`). It does **not** introduce a new `build/` folder. `buildResources` is electron-builder's lookup folder for its own build inputs (a named `icon`, entitlements, an installer background, etc.); since none of those named assets exist and no `icon` is configured (P7§7.2), electron-builder reads nothing special from it and ignores the tray PNGs sitting alongside — pointing `buildResources` at `resources/` is harmless and simply avoids inventing a second resources folder.
- **`extraResources`** copies `resources/sidecar-bin/**` (the compiled binary staged by `buildSidecar.mjs`, P7§6) to `<app>/…/Resources/sidecar-bin/` — i.e. to `process.resourcesPath/sidecar-bin/` at runtime. This is a real, unpacked, on-disk file, **not** an asar-embedded one. That matters: `SidecarSupervisor` spawns the binary as a child process, and a native process cannot be spawned from inside an asar archive (asar is a virtual filesystem). `extraResources` is precisely what places the binary as a spawnable real file, and `resolveSidecarBinaryPath`'s packaged branch (P7§8) points at exactly this location (`process.resourcesPath/sidecar-bin/…`).
- **`files`** ships the bundled app (`out/**`) plus the tray icons (`resources/icons/**`). The tray icons must be inside the packaged app because `tray.ts` resolves them relative to its own `__dirname` (`path.join(__dirname, "..", "..", "resources", "icons", "trayIconTemplate.png")`); after bundling, `__dirname` is `…/app.asar/out/main`, so the icons must exist at `…/app.asar/resources/icons/`. Including `resources/icons/**` in `files` keeps the existing Phase 5d tray icon working in the packaged build with no code change. (See P7§7.4 — this `files` value is a mechanical detail I pinned, flagged there.)

### P7§7.2 No custom icon (deliberate)

No `icon` field is configured, so electron-builder falls back to its own default Electron icon. This is a deliberate simplicity choice (YAGNI) for a personal, never-distributed tool. The Phase 5d tray icons are **not** suitable as full app/installer icons — they are 16×16/32×32 macOS menu-bar *template* glyphs (monochrome masks), whereas an app/installer icon needs multiple resolutions up to 512×512+ for a `.icns`/`.ico`. They are explicitly **not** reused or repurposed here, and this phase adds **no new icon asset of any kind**. A polished app icon later is a pure additive file+config change, not a Phase 7 concern.

### P7§7.3 Unsigned output (unchanged from §11)

No code signing and no notarization — unchanged from §11's explicit stance that these are "unnecessary for a locally-built, never-distributed personal app (Gatekeeper/SmartScreen only trigger on files carrying quarantine/Mark-of-the-Web attributes, which locally-built binaries don't carry)." The targets are electron-builder's own defaults for each OS: `dmg` + `zip` on macOS, `nsis` (installer) + `zip` on Windows. No `publish` config, no auto-update.

### P7§7.4 Mechanical fields (flagged judgment calls)

The brainstorm's locked scope pinned `buildResources`, `extraResources`, no-icon, and unsigned targets, but electron-builder requires a few fields to produce a working build that the brainstorm did not pin. These are resolved here and flagged for the plan-writer as unpinned mechanical details, not new scope:

- `appId` (`com.tradeassistant.app`) and `productName` (`Trade Assistant`) — electron-builder requires an `appId`; both are cosmetic for a never-distributed tool and may be adjusted freely. `productName`/`name` should stay consistent with `package.json`'s `name` (`trade-assistant-app`) only insofar as electron-builder derives output filenames from it.
- `files` including `resources/icons/**` — necessary to keep the tray icon working in the packaged app (P7§7.1). The alternative is relying on electron-builder's default `files` (which packs the whole app dir, including `resources/`); the explicit form is pinned here to document the tray-icon dependency and avoid shipping `src/`/`test/` into the asar.

## P7§8 `resolveSidecarBinaryPath` (new pure function)

This is the only real application-logic change in the phase, and the only unit-tested code it adds. It extracts `bootstrap.ts`'s currently-hardcoded inline sidecar path into a pure function so a packaged build can locate its shipped sidecar binary, while leaving the dev path byte-identical to today's.

### P7§8.1 Precedent it mirrors

It follows `electron-app/src/main/appLifecycle.ts`'s `shouldQuitOnAllWindowsClosed` precedent exactly: a small, single-responsibility, **pure** function that takes the Electron-derived values as plain parameters (rather than importing Electron or reading `process.*` itself), with its own sibling unit-test file and no Electron in the test. `shouldQuitOnAllWindowsClosed` takes `platform: NodeJS.Platform` as a parameter instead of reading `process.platform`; this function takes `isPackaged`, `resourcesPath`, `platform`, and `envOverride` as parameters instead of reading `app.isPackaged`/`process.resourcesPath`/`process.platform`/`process.env.SIDECAR_BINARY` itself.

### P7§8.2 Location

New file `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`, sibling to `sidecarSupervisor.ts`. The file name describes its responsibility (per CLAUDE.md), and grouping it under `services/sidecar/` matches the recent refactor that consolidated sidecar modules there (it is the module `bootstrap.ts` already imports `SidecarSupervisor` from). Its unit test lives at `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts`, mirroring the existing `test/main/services/sidecar/` tree (which already holds `sidecarSupervisor.test.ts`/`sidecarProtocol.test.ts`) and the `appLifecycle.ts` → `test/main/appLifecycle.test.ts` sibling-test convention. (See P7§8.5 — the top-level `src/main/appLifecycle.ts` location was the literal alternative; grouping under `services/sidecar/` is the resolved judgment call.)

### P7§8.3 Signature and behavior

```typescript
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

- **`envOverride` wins unconditionally** if set (truthy), exactly as `process.env.SIDECAR_BINARY ?? …` does today — regardless of `isPackaged` or `platform`. This preserves the existing dev/test escape hatch verbatim.
- **Packaged** (`isPackaged === true`, no override): `path.join(resourcesPath, "sidecar-bin", platform === "win32" ? "sidecar.exe" : "sidecar")` — the `extraResources` destination (P7§7.1), with the `.exe` suffix on Windows matching what `buildSidecar.mjs` stages (P7§6).
- **Unpackaged** (`isPackaged === false`, no override): **today's existing dev-relative path, unchanged** — `path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar")`. This phase does not change the dev path; it only makes packaged-vs-unpackaged a real branch where previously only the unpackaged case existed inline.

The function references module-scope `__dirname` in the unpackaged branch only. `__dirname` is a Node/CommonJS ambient, not an Electron import, so the "no Electron import in the function body" purity rule (the actual stated rule) still holds. electron-vite bundles the main process into `out/main`, so `__dirname` remains `out/main` at runtime whether the expression lives in `bootstrap.ts` or in this new sibling module — the resolved dev path is therefore byte-identical to today's (P7§8.6 covers how the unpackaged test stays location-independent).

### P7§8.4 `bootstrap.ts` wiring (the only change to bootstrap)

`createApp()`'s current `SidecarSupervisor` construction:

```typescript
const supervisor = new SidecarSupervisor({
  binaryPath:
    process.env.SIDECAR_BINARY ??
    path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar"),
  lakeRoot: process.env.TRADE_ASSISTANT_LAKE ?? path.join(app.getPath("userData"), "candle-lake"),
});
```

becomes:

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

`SidecarSupervisor` itself is **not** changed: `binaryPath` is stored and passed to `spawnFn(this.binaryPath, ["--lake-root", this.lakeRoot])` exactly as today (confirmed in `sidecarSupervisor.ts`). The `lakeRoot` line is untouched. The Electron-derived values (`app.isPackaged`, `process.resourcesPath`, `process.platform`, `process.env.SIDECAR_BINARY`) are read in `bootstrap.ts` — the Electron-runtime glue — and passed as plain parameters, exactly as `bootstrap.ts`/`appLifecycle` glue reads `process.platform` and passes it to `shouldQuitOnAllWindowsClosed`.

### P7§8.5 Location judgment call

The task left the exact home to "wherever makes sense per the `appLifecycle.ts` precedent — possibly the same file or a new small sibling file." `appLifecycle.ts` sits at the top level of `src/main/`; the literal-mirror alternative would be a top-level `src/main/sidecarBinaryPath.ts`. This design instead places it under `services/sidecar/` because (a) it is a sidecar-specific concern feeding `SidecarSupervisor`, grouping cleanly with the module `bootstrap.ts` already imports the supervisor from post-refactor, and (b) it still preserves the *essence* of the precedent — a small, single-responsibility, separately-tested pure function in its own responsibility-named file. Flagged so the plan-writer knows the top-level location was considered and deliberately not chosen.

### P7§8.6 Unit tests (`electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts`, new)

Plain Vitest, no real Electron, mirroring `appLifecycle.test.ts`'s style (a `describe` with focused `it`s, no mocking framework):

- `packaged_darwin_resolves_to_resources_sidecar_bin_without_exe` — `{ isPackaged: true, resourcesPath: "/Applications/Trade Assistant.app/Contents/Resources", platform: "darwin" }` → `path.join(resourcesPath, "sidecar-bin", "sidecar")` (no `.exe`).
- `packaged_win32_resolves_to_resources_sidecar_bin_with_exe` — same with `platform: "win32"` → `path.join(resourcesPath, "sidecar-bin", "sidecar.exe")`.
- `unpackaged_resolves_to_todays_dev_debug_path` — `{ isPackaged: false, platform: "darwin" }` (no override) → asserts the result ends with the platform-appropriate `path.join("rust-core", "target", "debug", "sidecar")` tail rather than pinning an absolute prefix, so the test is location-independent (the `__dirname` prefix differs per checkout).
- `env_override_wins_regardless_of_isPackaged` — `{ envOverride: "/custom/sidecar", isPackaged: true, … }` → `/custom/sidecar`, and the same with `isPackaged: false` → `/custom/sidecar`, proving the override short-circuits both branches.

## P7§9 rustls — already satisfied, verify-only (no code change)

§11 requires: *"`reqwest`/networking crates use `rustls`, not `native-tls`/`openssl`, to avoid the OpenSSL cross-compile pain class entirely."* This phase makes **no** Rust change for it — it documents that the requirement is already met, as evidence.

Confirmed on the current tree:

- The only networking crate declaration is in `rust-core/crates/ingestion/Cargo.toml`: `reqwest = { version = "0.12", default-features = false, features = ["blocking", "rustls-tls"] }` — `default-features = false` disables reqwest's default `native-tls`, and `rustls-tls` selects the rustls backend explicitly.
- `cargo tree` on the real compiled graph shows only the rustls stack — `rustls v0.23.42`, `hyper-rustls v0.27.9`, `tokio-rustls v0.26.4` — reached via `reqwest v0.12.28` ← `ingestion` ← `backtest` ← `sidecar`.
- `cargo tree -i native-tls` → `error: package ID specification 'native-tls' did not match any packages`.
- `cargo tree -i openssl-sys` → `error: package ID specification 'openssl-sys' did not match any packages`.

Both inverse queries erroring means `native-tls`/`openssl-sys` are **not part of the real build graph**. They appear in `Cargo.lock` only as unused registry-graph artifacts (`Cargo.lock` records the resolved registry universe, including features/crates that no enabled feature actually pulls in). The requirement is satisfied by construction with zero changes; this section is the written verification, nothing more. (Re-run the four commands above from `rust-core/` to re-confirm at plan/implementation time — they are the acceptance evidence.)

## P7§10 Error handling / edge cases

Worked through in brainstorming; no new error-handling code is invented for any of these.

1. **Packaged build made without running `build:sidecar` first (missing `resources/sidecar-bin/`).** `resolveSidecarBinaryPath` still returns the packaged path; it simply won't exist on disk. The **existing** `SidecarSupervisor` spawn-failure/auto-restart handling (built in an earlier phase) surfaces this as the sidecar being perpetually "down" — identical to any other missing-binary case today. No new error-handling code. In practice the `package:*` scripts always run `build:sidecar` first (P7§5), so a hand-run `electron-builder` is the only way to hit this.
2. **Stale cross-platform binary lingering in `resources/sidecar-bin/`.** Prevented structurally by `buildSidecar.mjs` clearing/recreating that folder at the start of every run (P7§6, step 1).
3. **CI accidentally spending macOS/Windows minutes.** Structurally prevented: the workflow has exactly one job, hardcoded `runs-on: ubuntu-latest`, no matrix, and only builds/packages nothing (P7§4.3). Stated as a hard invariant future edits must not violate.
4. **`better-sqlite3` native module in a packaged build.** Already handled by the **existing** `postinstall`/`predev`/`prestart` `electron-rebuild -f -w better-sqlite3` scripts (unchanged); electron-builder natively understands electron-rebuild'd native modules and repackages them correctly per platform. This phase adds no new step for it.
5. **Sidecar spawn from asar.** Not a bug to handle so much as a design constraint honored: the binary ships via `extraResources` (real on-disk file under `process.resourcesPath`), never inside the asar, so it is spawnable (P7§7.1).

## P7§11 Testing strategy

Deliberately minimal — this phase is almost entirely build/CI tooling, whose correctness is proven by running it, not by unit tests. It follows the project's established convention that build/tooling scripts and config files are not unit-tested (Phase 5d's tray-icon assets were validated by running the app, not by tests).

- **`resolveSidecarBinaryPath` — real unit tests** (the one piece of actual application logic in the phase): the four cases in P7§8.6, mirroring `appLifecycle.test.ts`'s exact style (no real Electron, pure function, plain Vitest).
- **`buildSidecar.mjs` — not unit-tested.** Validated by actually running it once per platform during manual verification (P7§12), matching the Phase 5d build/tooling-not-unit-tested precedent.
- **`electron-builder.yml` / `test.yml` — not unit-tested.** Validated by actually running `npm run package:mac`/`package:win` locally, and by opening a real PR after this phase merges and confirming the new GitHub Actions check appears and passes (P7§12).
- **rustls — verify-only**, via the four `cargo tree` commands in P7§9 (acceptance evidence, not a unit test).
- CI runs the **existing, unchanged** suites: `cargo test --workspace` and `npm run typecheck && npm test`. This phase adds those runs to CI; it does not change what they contain (beyond the one new `sidecarBinaryPath.test.ts`).

## P7§12 Manual verification checklist

Mirrors prior phases' checklists (an automatable/local golden path plus a live follow-up), and — per the roadmap — **never blocks calling Phase 7 done**.

**macOS (on a Mac):**
1. `npm run package:mac` → produces a `dmg` (and `zip`) under `dist/` (electron-builder's default output dir).
2. Install/open the `dmg`, launch the app once.
3. Confirm the packaged sidecar spawns (status is not stuck "down") and a real analysis flow works end-to-end.

**Windows (on real Windows hardware/VM — the user has direct access):**
1. `npm run package:win` → produces an `nsis` installer (and `zip`).
2. Run the installer, launch the app once.
3. Confirm the same: the sidecar spawns and a real analysis flow works end-to-end. (This is the roadmap's surviving "Windows build manually run at least once on real Windows hardware" requirement — P7§3 — now sourced from a local build, not a CI artifact.)

**CI (after the phase lands):**
1. Open a throwaway PR against `main`.
2. Confirm the `test.yml` GitHub Actions check appears and passes (`cargo test --workspace` + `npm ci`/`typecheck`/`test` on `ubuntu-latest`).
3. Confirm no macOS/Windows runner minutes were consumed (only the single Ubuntu job ran).

## P7§13 The permanent no-order-placement safety invariant is unaffected

This phase adds no Kite write-tool method, no new Claude tool grant, and no code path that could reach `place_order`/`modify_order`/`cancel_order`/`place_gtt_order`/`modify_gtt_order`/`delete_gtt_order` — indeed it adds no order-related surface of any kind. It is pure build/CI tooling: a test-only CI workflow, local packaging scripts, a sidecar-build helper, an electron-builder config, one pure path-resolution function, and a rustls confirmation. Nothing here touches Kite, Claude, the MCP client, or any order-adjacent code. The permanent §2/§4 constraint — the app never places, modifies, cancels, or automates any order, ever — is restated here for completeness, as in every phase, precisely because nothing in this phase touches it.

## P7§14 Global Constraints (binding, verbatim for the plan-writer and task-implementers)

**Exact new file paths:**
- `.github/workflows/test.yml`
- `electron-app/scripts/buildSidecar.mjs`
- `electron-app/electron-builder.yml`
- `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts`
- `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts`

**Exact modified file paths:**
- `electron-app/src/main/bootstrap.ts` — `SidecarSupervisor` construction calls `resolveSidecarBinaryPath(...)` instead of the inline path expression (P7§8.4); `lakeRoot` unchanged.
- `electron-app/package.json` — three new scripts (`build:sidecar`, `package:mac`, `package:win`) and one new devDependency (`electron-builder`).

**Exact new npm script names + values:**
- `"build:sidecar": "node scripts/buildSidecar.mjs"`
- `"package:mac": "npm run build:sidecar && electron-vite build && electron-builder --mac"`
- `"package:win": "npm run build:sidecar && electron-vite build && electron-builder --win"`

**Exact function signature (pure, no Electron import in the body):**
```typescript
resolveSidecarBinaryPath({ isPackaged, resourcesPath, platform, envOverride }: {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  envOverride?: string;
}): string
```
Behavior: `envOverride` truthy → return it. Else `isPackaged` → `path.join(resourcesPath, "sidecar-bin", platform === "win32" ? "sidecar.exe" : "sidecar")`. Else → `path.join(__dirname, "..", "..", "..", "rust-core", "target", "debug", "sidecar")` (today's dev path, unchanged).

**Exact `resources/` layout:**
- Existing (unchanged): `electron-app/resources/icons/trayIconTemplate.png`, `electron-app/resources/icons/trayIconTemplate@2x.png`.
- New (created and cleared by `buildSidecar.mjs`): `electron-app/resources/sidecar-bin/` containing `sidecar` (mac/linux) or `sidecar.exe` (win32).

**Exact `electron-builder.yml` keys/values:**
- `directories.buildResources: resources`
- `extraResources: [{ from: resources/sidecar-bin, to: sidecar-bin, filter: ["**/*"] }]`
- `files: [out/**, resources/icons/**]`
- `mac.target: [dmg, zip]`; `win.target: [nsis, zip]`
- No `icon` field; no `publish`; no signing/notarization config.
- `appId: com.tradeassistant.app`, `productName: Trade Assistant` (mechanical, adjustable — P7§7.4).

**Exact CI workflow shape (`.github/workflows/test.yml`):**
- `on: pull_request: branches: [main]` — nothing else.
- One job, `runs-on: ubuntu-latest`, **no matrix**.
- Steps in order: checkout → Rust toolchain (+cache) → `cargo test --workspace` (cwd `rust-core/`) → Node 22 setup (+npm cache) → `npm ci` → `npm run typecheck` → `npm test` (all cwd `electron-app/`).

**Exact Rust build command (in `buildSidecar.mjs`):** `cargo build --release -p sidecar`, cwd `../rust-core` relative to the script → binary at `rust-core/target/release/sidecar` (mac/linux) or `rust-core/target/release/sidecar.exe` (win32).

**Exact rustls acceptance evidence (verify-only, run from `rust-core/`):**
- `cargo tree -i native-tls` → errors "did not match any packages".
- `cargo tree -i openssl-sys` → errors "did not match any packages".
- `cargo tree -i rustls` → shows `rustls`/`hyper-rustls`/`tokio-rustls` via `reqwest` ← `ingestion`.

**New dependency:** `electron-app/package.json` devDependencies gains `electron-builder` (a version compatible with `electron` `33.2.0`, e.g. `^25`; exact pin is the implementer's choice). No new Rust dependency, no `Cargo.toml`/`Cargo.lock` change.

**Binding invariants:** (a) CI is `ubuntu-latest`-only, single job, no matrix, `pull_request`→`main` only, and builds/packages/signs/ships **nothing** (P7§4.3); (b) `SidecarSupervisor` internals are NOT modified — only its `binaryPath` argument's source changes (P7§8.4); (c) the dev/unpackaged sidecar path is byte-identical to today's; (d) `envOverride` (`SIDECAR_BINARY`) wins unconditionally; (e) no custom app/installer icon, no new icon asset, tray icons NOT repurposed (P7§7.2); (f) unsigned output only, no code signing/notarization (P7§7.3); (g) no Rust source/`Cargo.*` change for rustls — verify-only (P7§9); (h) no order-related surface is added (P7§13).

## P7§15 File layout summary

**New:**
- `.github/workflows/test.yml` — test-only CI, `ubuntu-latest`, PR→`main` (P7§4).
- `electron-app/scripts/buildSidecar.mjs` — release-compile the sidecar + stage it under `resources/sidecar-bin/` (P7§6). First file in a new `electron-app/scripts/` directory.
- `electron-app/electron-builder.yml` — packaging config (P7§7).
- `electron-app/src/main/services/sidecar/sidecarBinaryPath.ts` — `resolveSidecarBinaryPath` (P7§8).
- `electron-app/test/main/services/sidecar/sidecarBinaryPath.test.ts` — its four unit tests (P7§8.6).

**Modified:**
- `electron-app/src/main/bootstrap.ts` — call `resolveSidecarBinaryPath(...)` in the `SidecarSupervisor` construction (P7§8.4).
- `electron-app/package.json` — `build:sidecar`/`package:mac`/`package:win` scripts; `electron-builder` devDependency (P7§5, P7§14).

**Explicitly considered, not changed:**
- `electron-app/src/main/services/sidecar/sidecarSupervisor.ts` — spawn/restart/timeout logic untouched; only its `binaryPath` input's source changes (P7§8.4).
- `rust-core/**` — no source, `Cargo.toml`, or `Cargo.lock` change; rustls is verify-only (P7§9).
- `electron-app/resources/icons/**` — the Phase 5d tray icons are packaged as-is, not modified, not repurposed as app icons (P7§7.2).
- The existing `electron-rebuild`/`npm rebuild better-sqlite3` scripts — unchanged (P7§10, item 4).

## P7§16 Out of scope for this phase

- **Any change to the hard no-order-placement safety invariant (§2, §4).** Unaffected — this phase adds no order-related surface at all (P7§13).
- **A macOS/Windows CI build matrix, or any CI build/package/sign/ship step.** CI is test-only on `ubuntu-latest` (P7§3, P7§4). This is the deliberate narrowing of §11 and the roadmap's Phase 7 definition-of-done; re-introducing CI builds re-opens P7§3.
- **Code signing and notarization.** Unsigned output only, unchanged from §11 (P7§7.3).
- **Cross-compilation.** Each `package:*` script runs on its own OS (P7§5).
- **A custom app/installer icon or any new icon asset.** electron-builder's default icon is used; tray icons are not repurposed (P7§7.2).
- **Auto-update / delta updates / a release or publish channel / changelog generation.** None exist and none are added; `dist/` output is installed manually.
- **A universal/single-machine "build both platforms" script.** No cross-compile, so each OS builds only its own installer.
- **Any change to `SidecarSupervisor`'s spawn/restart/timeout behavior**, or any new runtime error-handling for a missing sidecar binary — the existing supervisor already surfaces that as "down" (P7§10, item 1).
- **Linux packaging.** §11's targets are macOS and Windows; the `ubuntu-latest` CI runner is for *testing* only and produces no Linux installer.
