# Phase 10 — UI Design System

Status: approved by user 2026-07-30 (brainstorming dialogue), pending implementation planning.
Author: design produced via `superpowers:brainstorming`. Section references: "P10§N" → this document; "P9B§N" → the immediately-prior UI phase, `docs/superpowers/specs/2026-07-29-phase9b-agent-activity-chat-ui-design.md`; "§N" → the master roadmap `docs/superpowers/specs/2026-07-18-trade-assistant-design.md`. The house structure/tone mirrors P9B.

This phase is **pure presentation-layer work**. Every prior phase built the app's data layer, algorithm layer, AI reasoning layer, and — in Phase 9-B specifically — a real, themed, componentized chat UI. But that phase's own scope was deliberately narrow (P9B§1): it styled the chat subtree and nothing else. Today the app is a two-tier UI: one screen (`ChatView` and its children) has hand-written CSS, a dark/light theme, spacing, and status iconography; every other screen — Home, Mode picker, Engine-Only analysis, Benchmark, Settings — renders on bare `className`s with no matching CSS at all, unstyled browser-default HTML. Phase 10 closes that gap: it builds a shared design-token/primitive-component foundation and reskins every screen in the app onto it, so the whole product reads as one coherent, professional system instead of one styled island surrounded by unstyled scaffolding.

## P10§1 Purpose

The app is a packaged desktop trading *assistant*: Electron + TypeScript + React, a Rust compute core (`rust-core/`) run as a sidecar subprocess, and Claude reached via the `claude` CLI. Two Electron windows exist — the main window, which hosts five screens (Home, Mode picker, Engine-Only analysis, AI-Assisted chat, Benchmark), and a separate Settings `BrowserWindow`. Rust computes; Claude reasons; **the human makes every buy/sell decision.**

**Permanent, non-negotiable safety property (re-stated because every spec re-states it):** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. It is an assistant, not a trader. This phase touches nothing that could affect that guarantee: it is a presentation-only reskin of existing screens with no IPC, data-shape, or main-process change of any kind (P10§7.1).

**The gap this phase closes.** Phase 9-B (P9B) gave `ChatView.tsx`, `AgentActivityPanel.tsx`, `TraceStepRow.tsx`, and `ThemeToggle.tsx` dedicated CSS files and a `.chat-view`-scoped dark/light theme (`theme.css`, CSS custom properties, persisted to `localStorage["chatTheme"]`). No other screen in the app has ever received an equivalent pass:

- `HomeScreen.tsx`, `ModePicker.tsx`, `InstrumentSearch.tsx`, `AnalysisResult.tsx`, `HistorySidebar.tsx`, `BenchmarkView.tsx`, and `SettingsWindow.tsx` render on bare `className`s with zero matching CSS rules anywhere in the codebase — unstyled browser-default HTML.
- No design-tokens file exists. Colors, spacing, radii, and type scale are either hardcoded per file (`style.css`'s `color: #92400e` / `color: #b91c1c` banner colors) or simply absent (zero border-radius, zero elevation/shadow anywhere in the app).
- `benchmarkChart.ts` maintains its own independent hardcoded outcome-color palette (`OUTCOME_COLOR = { correct: "#26a69a", incorrect: "#ef5350", neutral: "#9e9e9e" }`) that shares no relationship with `theme.css`'s status colors, and the confluence stat counts render as an unstyled `<dl>` with no color coding at all — three unrelated, ad hoc "is this bullish/bearish/neutral" color schemes across the app.
- No icon library exists. Status icons are raw Unicode (`⏳`/`✓`/`✗`) and emoji (sun/moon for the chat theme toggle) rather than a consistent icon set.
- `App.tsx` currently does all top-level view routing via local boolean/enum flags (`activeSession`, `showModePicker`, `showBenchmark`), swapping the *entire window contents* between screens rather than presenting a persistent shell — there is no sidebar, no persistent navigation, no consistent chrome across screens.

Phase 10 fixes this by building shared design tokens and a shared primitive component library first, then reskinning every screen onto them, and by introducing a persistent app-shell layout (sidebar + content pane) so navigation and connection-status chrome are consistent everywhere instead of living inside each individually-swapped screen.

## P10§2 Scope

**In scope (each specified precisely in its own section):**

1. `src/renderer/ui/tokens.css` — a new, app-wide design-tokens stylesheet: color (including a new unified semantic palette), spacing, typography, radius, and shadow scales (P10§3).
2. `AppShell.tsx` + `.css` — a new persistent sidebar/content-pane layout that repositions (not replaces) `App.tsx`'s existing view-switch logic (P10§4).
3. A shared primitive component library under `src/renderer/ui/`: `Button`, `TextField`, `Card`, `Badge`, `StatusDot`, `EmptyState`, `Banner`, `Spinner`, `Switch`, and `icons.ts` (P10§5).
4. Per-screen reskins, in this build order: sidebar/history → mode picker → engine-only analysis → chat refinement → benchmark → settings (P10§6).
5. Extending the existing `styleCssSplit.test.ts` pattern to `tokens.css`, plus a render test for each new primitive (P10§7).

**Not in scope (P10§8 has the full list):**

- Any IPC channel, preload surface, bridge, service, or data-shape change of any kind — every `TraceEvent`, `AnalysisResult`, `AnalysisEnvelope`, `SessionSummary`/`HistoryMessage`/`SessionDetail`, `BenchmarkResult`/`DecisionPoint`, and `ScanConfig`/`AppStatus` shape defined in `src/main/ipc/rendererApi.ts` stays byte-identical (P10§7.1).
- Any change to the no-order-placement safety invariant — unaffected by construction, for the same reason P9B§3 gave: this phase renders existing data, it does not add a new capability (P10§1).
- Folding the Settings window into the main-window shell as a route — it stays a separate `BrowserWindow` (P10§4.5, P10§6.6).
- List/session/watchlist search, filtering, pagination, or virtualization — every list in this phase is visual-only; none of today's data-fetching or list logic changes (P10§8).
- Redesigning `ChatView`'s palette from scratch — this phase extends and promotes it, it does not replace it (P10§3.1, P10§6.4).
- A bundled webfont, Tailwind, CSS-in-JS, or any headless component library — plain CSS + tokens only, with one explicit exception (`lucide-react` for icons, P10§5.10).

**Locked decisions written up verbatim (from the completed brainstorming session; none re-litigated here):**

1. **Token-first, bottom-up build sequencing.** Shared tokens and the shared primitive library are built before any screen reskin; screens are then reskinned in a fixed order (P10§2 item 4) so each pass has every primitive it needs already available, never inventing one-off markup that a later pass has to retrofit.
2. **Tokens are promoted app-wide, not chat-scoped.** `tokens.css` is a single global stylesheet applied at the app root (`:root` for dark, `[data-theme="light"]` override) — unlike today's `theme.css`, which is scoped to `.chat-view[data-theme]`. The theme toggle itself moves from chat-only to the sidebar footer (P10§4.3, P10§6.4).
3. **Settings stays a separate `BrowserWindow`.** Explicitly the lowest-risk option — no IPC/window rearchitecture — restyled internally to match tokens but structurally untouched, keeping its own preload/IPC/root (P10§4.5, P10§6.6).
4. **No router library.** `App.tsx`'s existing local `useState` view-switch logic (`activeSession`, `showModePicker`, `showBenchmark`) is kept as-is; it is repositioned to drive `AppShell`'s content pane instead of swapping the whole window (P10§4.1).
5. **One new npm dependency: `lucide-react`.** Chosen over hand-rolled SVG or keeping the existing Unicode/emoji icons, specifically to replace today's raw `⏳`/`✓`/`✗` glyphs and the sun/moon emoji theme toggle (P10§5.10).
6. **`HomeScreen.tsx` as a distinct full-screen view is retired.** Its two responsibilities — the new-session button and the history list — move into the persistent sidebar; there is no longer a screen dedicated solely to "home" (P10§4.2, P10§6.1).

## P10§3 Design tokens (`src/renderer/ui/tokens.css`)

New file, a single global stylesheet applied at the app root — not scoped to `.chat-view` — with a dark default and a light override:

```css
:root {
  /* dark theme (default) */
}

[data-theme="light"] {
  /* light theme override */
}
```

### P10§3.1 Color

Extends today's `theme.css` dark/light pairs rather than replacing them — `theme.css`'s existing variable names and values carry forward verbatim, since this phase promotes and extends the chat palette, it does not redesign it (P10§2's explicit non-goal):

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#0f1115` | `#ffffff` |
| `--fg` | `#e6e6e6` | `#111827` |
| `--border` | `#2a2f3a` | `#d1d5db` |
| `--code-bg` | `#1a1d24` | `#f3f4f6` |
| `--accent` | `#6366f1` | `#4f46e5` |
| `--status-running` | `#d97706` | `#b45309` |
| `--status-done` | `#16a34a` | `#15803d` |
| `--status-error` | `#dc2626` | `#b91c1c` |

New tokens added by this phase, none of which exist today:

- **Intermediate neutrals** — `--bg-subtle` (a step above `--bg`, used for hover states and the sidebar) and `--bg-elevated` (a further step up, used for `Card`'s surface so cards read as distinct from the page background they sit on) and `--border-strong` (a higher-contrast border for emphasis, e.g. the selected sidebar row's accent border sits alongside this, not instead of it).
- **Semantic direction colors** — `--bullish` / `--bearish` / `--neutral` (green / red / gray). This is a **new, unified palette that replaces three currently-independent ones**: `theme.css`'s status colors (which stay as `--status-*`, a distinct concept from direction — see below), `benchmarkChart.ts`'s own `OUTCOME_COLOR` map (`#26a69a`/`#ef5350`/`#9e9e9e`), and the confluence stat counts, which today have no color at all. After this phase, every place in the app that expresses "bullish/bearish/neutral" or "correct/incorrect/neutral" — the chat verdict badge, the confluence stat tiles, and the benchmark chart markers/summary strip — reads off this one palette.
- `--status-running`/`--status-done`/`--status-error` are **kept as a separate concept from `--bullish`/`--bearish`/`--neutral`**: the former describe a process's lifecycle (a persona/algorithm/analysis run that is in progress, finished, or failed), the latter describe a market-direction judgment (bullish/bearish/neutral, or a benchmark decision point's correct/incorrect/neutral). They are visually similar (amber/green/red-ish) but semantically distinct, and both are extended to non-chat screens for the first time in this phase — e.g. the sidecar/Kite banners in `App.tsx`'s ad hoc banner list currently hardcode `color: #92400e` (warning) and `color: #b91c1c` (error) directly in `style.css`; those hardcoded values are replaced by `--status-running`-family/`--status-error` tokens via the new `Banner` primitive (P10§5.7).

### P10§3.2 Spacing

`--space-1` through `--space-8`, a doubling-ish scale from 4px to 48px, used for all padding/margin/gap in every new and reskinned component:

| Token | Value |
| --- | --- |
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-7` | 40px |
| `--space-8` | 48px |

### P10§3.3 Typography

- `--font-sans: system-ui, sans-serif` and `--font-mono: ui-monospace, monospace` are **kept exactly as they are today** — no new webfont is bundled. This is an explicit decision, not an oversight: bundling a webfont raises font-loading/bundling concerns inside an Electron packaging pipeline that already has enough moving parts (the sidecar binary, `better-sqlite3`'s native rebuild step), for a purely cosmetic gain the system font stack already covers well enough.
- A proper type scale is added: `--text-xs`, `--text-sm`, `--text-md`, `--text-lg`, `--text-xl`, `--text-2xl`, plus `--font-weight-normal`, `--font-weight-medium`, `--font-weight-semibold`.
- **Numeric columns use monospace/tabular figures.** Prices, confluence stats, and benchmark P&L figures are rendered with `--font-mono` (or `font-variant-numeric: tabular-nums` where the surrounding text stays `--font-sans` but a number needs to align in a column) so that stacked numeric values — a confluence badge row, a benchmark summary strip, a price column in a results list — align vertically instead of drifting with each digit's proportional width.

### P10§3.4 Other

- `--radius-sm` / `--radius-md` / `--radius-lg` — the app has **zero** border-radius anywhere today; every new/reskinned surface (buttons, cards, badges, text fields, banners) adopts one of these three going forward.
- `--shadow-sm` / `--shadow-md` — the app has **zero** elevation/box-shadow anywhere today; `Card` uses `--shadow-sm` at rest and `--shadow-md` on hover where a card is interactive (e.g. the mode-picker cards, P10§6.2), and the benchmark results popover uses `--shadow-md` to read as clearly floating above the chart (P10§6.5).

## P10§4 App shell / layout architecture

New files: `src/renderer/AppShell.tsx` + `src/renderer/AppShell.css`. No router library is added (locked decision 4, P10§2) — `App.tsx`'s existing local `useState` view-switch logic (`activeSession`, `showModePicker`, `showBenchmark`, and the rest of today's state, P10§4.1) is kept verbatim and repositioned to drive `AppShell`'s main content pane instead of swapping the entire window's contents.

### P10§4.1 What changes structurally vs. what doesn't

Today, `App.tsx` renders one of several mutually-exclusive top-level branches directly under its root element, each occupying the full window (verified against the tree, `App.tsx:126-186` — e.g. `activeSession === null && showModePicker && <ModePicker .../>` at line 152). After this phase, `App.tsx`'s state and the conditions gating each branch are unchanged, but the branches render *inside* `AppShell`'s content pane instead of directly under the window root — `AppShell` becomes the thing `App.tsx` renders, and `App.tsx`'s existing JSX becomes the `children` (or an equivalent prop) `AppShell` places in its main pane. No view-selection logic is rewritten; only where its output is mounted changes.

### P10§4.2 Persistent sidebar (left, main window only)

- **Header:** app name/mark, and a full-width primary "New session" `Button` (P10§5.1) at the top — this is one of `HomeScreen.tsx`'s two retired responsibilities (locked decision 6, P10§2), now always visible rather than gated behind a dedicated home screen.
- **Body:** the session history list — a restyled `HistorySidebar` (P10§6.1), same data and fetch/selection logic as today, no new search/filter/virtualization (explicitly deferred, P10§8).
- **Footer:** connection-status rows (sidecar up/down, Kite session state), each a `StatusDot` (P10§5.5) + label, and the theme toggle — **promoted from chat-only to app-wide** (P10§4.3).

`HomeScreen.tsx` as a distinct full-screen view is retired: its "new session" button and its history list both move into this sidebar, so there is no longer a screen whose sole purpose is "home" — the sidebar is present on every main-window screen instead.

### P10§4.3 Theme promotion

`data-theme` moves from `.chat-view` (P9B§9.1's scoping) to the app root — the same element `tokens.css`'s `[data-theme="light"]` selector targets (P10§3). `ThemeToggle`'s underlying `useChatTheme` hook logic (P9B§9.2: `localStorage["chatTheme"]`, default dark, read-on-mount) carries forward unchanged — same persistence key, same default, same read/write behavior — but is now owned by `AppShell`/the sidebar footer instead of `ChatView`, and governs the app root's `data-theme` attribute instead of `.chat-view`'s. What changes is which component owns the hook and which DOM node receives the attribute; the hook's internal logic and the toggle button's own markup are otherwise reused as-is. `ChatView` no longer owns theme state or applies its own `data-theme` attribute (P10§6.4).

### P10§4.4 Main content pane

Swaps by active view, per `App.tsx`'s existing state (P10§4.1):

- **No active session** → an `EmptyState` (P10§5.6) welcome view.
- **New session** → `ModePicker`, rendered as a centered two-card choice *inside* the pane — no longer a full-screen swap (P10§6.2).
- **Engine-Only chosen** → the `InstrumentSearch` + `AnalysisResultView` flow, in-pane (P10§6.3).
- **AI-Assisted chosen** → `ChatView`, in-pane — it loses its own theme scoping and inherits the global theme instead (P10§4.3, P10§6.4).
- **Benchmark** → the existing three-stage `BenchmarkView` flow, in-pane, reached via a sidebar nav item rather than today's top-of-window button (P10§6.5).

**Banners** (`kiteLogin` / `mcpDrift` / `sidecarDown`) move from an ad hoc list rendered inline in `App.tsx` to a fixed strip at the top of the main content pane, built from the new `Banner` primitive (P10§5.7) — visible regardless of which view is currently active in the pane, rather than only appearing on whichever branch happened to render them inline before.

### P10§4.5 Settings

Settings **stays a separate `BrowserWindow`** — explicit decision, lowest risk, no IPC/window rearchitecture (locked decision 3, P10§2). It is opened via a sidebar button (replacing wherever today's entry point lives) and is restyled internally to consume `tokens.css` and the shared primitives (P10§6.6), but its own preload, IPC surface, and root component (`SettingsWindow.tsx` / `settingsMain.tsx` / `settings.html`) are structurally untouched — `tokens.css` is imported by the settings entry the same way `style.css` is imported by both entries today, so the settings window gets the same token values without gaining any new IPC surface.

## P10§5 Shared primitive component library (`src/renderer/ui/`)

New directory, one file per primitive, each tokens-only with no screen-specific logic — every primitive consumes `tokens.css` variables exclusively and contains no knowledge of which screen renders it.

### P10§5.1 `Button.tsx` + `.css`

Variants: `primary` / `secondary` / `ghost` / `danger`. Sizes: `sm` / `md`. Used everywhere an actionable button exists today with no styling (the sidebar's "New session" button, the mode-picker's implicit selection, the Engine-Only "Analyze" action, the benchmark "Copy raw result" action, and Settings' form actions).

### P10§5.2 `TextField.tsx` + `.css`

A text input plus a search variant (used by `InstrumentSearch` and the Settings watchlist add field). Tokens-driven border/radius/focus state; no debounce or search logic lives here — that stays exactly where it lives today in `InstrumentSearch.tsx` (P10§6.3).

### P10§5.3 `Card.tsx` + `.css`

An elevated container: `--bg-elevated` background, one of the `--radius-*` tokens, `--shadow-sm` at rest. The base surface for the mode-picker cards, sidebar history rows, `AnalysisResultView`'s prose container, the benchmark summary strip and results popover, and Settings' fieldset sections.

### P10§5.4 `Badge.tsx` + `.css`

A small label chip, semantic-color-aware — accepts a direction/status-like value and colors itself off `--bullish`/`--bearish`/`--neutral` or `--status-*` accordingly. Used for the sidebar's mode label, the chat verdict line, the confluence stat tiles, the benchmark summary strip's counts, and Settings' watchlist chips.

### P10§5.5 `StatusDot.tsx` + `.css`

A colored dot + label, driven off the semantic/status tokens. `TraceStepRow`'s bespoke running/done/error icon logic (today's `STATUS_ICON: Record<NodeStatus, string> = { running: "⟳", done: "✓", error: "✗" }`, P9B§8.1) is refactored to render through this shared primitive instead of its own inline glyph map — the icon-to-status mapping and the auto-expand/collapse/stay-expanded *behavior* around it (P9B§8.2–§8.4) are unchanged; only the leaf visual (glyph → `StatusDot`, sourced from `lucide-react` per P10§5.10) is swapped in. Also used for the sidebar footer's sidecar-up/down and Kite-session-state rows, and Settings' account-status block.

### P10§5.6 `EmptyState.tsx` + `.css`

Icon + message + optional CTA button. Used for: the main pane's no-active-session welcome (P10§4.4), the sidebar history list's empty state ("No sessions yet — start a new one," P10§6.1), and the benchmark screen's not-run-yet state (P10§6.5).

### P10§5.7 `Banner.tsx` + `.css`

Info / warning / error variants, replacing the `.banners` / `.error` classes in `style.css`. Covers both the existing app-wide banners (Kite login, MCP drift, sidecar down — now rendered as a fixed strip per P10§4.4) and new inline failure cases that today render as nothing or raw text: instrument-search failure, analysis-run failure, and benchmark-run failure, each an error `Banner` scoped to its own screen's content pane (P10§7.2's error-handling scope, detailed per-screen in P10§6).

### P10§5.8 `Spinner.tsx` + `.css`

A loading indicator. Used by the Engine-Only "Analyze" button while a run is in flight (P10§6.3) — there is no loading state on this action today; this phase adds one.

### P10§5.9 `Switch.tsx` + `.css`

A toggle switch, added specifically for Settings' proactive-scan enable/disable control, and reusable for any future boolean setting (P10§6.6).

### P10§5.10 `icons.ts`

A thin named re-export of the specific `lucide-react` icons actually used across the app (search, send, sun/moon, chevron, check, x, alert-triangle, and any others a given screen's reskin needs) — **one new npm dependency**, chosen over hand-rolled SVG or keeping the existing Unicode/emoji icons (locked decision 5, P10§2). This directly replaces: the chat's raw `⏳`/`✓`/`✗` status glyphs (now sourced through `StatusDot`, P10§5.5), the sun/moon emoji theme toggle (P10§4.3), and any other ad hoc glyph currently standing in for an icon anywhere in the app.

**All existing components get refactored during their screen's reskin pass to consume these primitives instead of bespoke markup — this is the mechanism by which the per-screen designs in P10§6 get built, not a separate task tracked on its own.**

## P10§6 Per-screen designs

Reskin order, as locked in P10§2: sidebar/history → mode picker → engine-only analysis → chat refinement → benchmark → settings.

### P10§6.1 Sidebar / history

Each session row renders as a `Card`-lite row (P10§5.3) containing: a mode `Badge` (P10§5.4, distinguishing `ai_assisted` vs `engine_only`), a truncated single-line preview of the session, a relative timestamp, a hover state (`--bg-subtle`), and an active/selected state (an accent left border using `--border-strong`/`--accent`). The empty state (no sessions yet) renders via `EmptyState` (P10§5.6): "No sessions yet — start a new one." The underlying data fetch and selection logic (today's `HistorySidebar.tsx`) is unchanged — this is a visual reskin only, consistent with P10§8's explicit deferral of search/filter/pagination/virtualization.

### P10§6.2 Mode picker

Two `Card`s (P10§5.3) side by side, stacking vertically if the pane is narrow, each showing a `lucide-react` icon (P10§5.10) and a one-line description: "Full reasoning chat with live agent trace" for AI-Assisted, "Deterministic instant verdict, no AI call" for Engine-Only. Both cards use `--shadow-sm` at rest and elevate to `--shadow-md` on hover, giving a clear affordance that the whole card is clickable. Rendered inside the main content pane (P10§4.4), not as a full-screen swap.

### P10§6.3 Engine-Only analysis

- `InstrumentSearch` → a `TextField` (P10§5.2, search variant) with its existing debounce logic unchanged; the results dropdown renders as a `Card` list (P10§5.3) instead of unstyled markup.
- Horizon (intraday/positional) becomes a segmented-control toggle group instead of today's bare radio inputs — visually a connected row of `Button`-like segments (built from `Button`'s primitives, not a new component) rather than native browser radios.
- "Analyze" becomes a primary `Button` (P10§5.1) that shows a `Spinner` (P10§5.8) and disables itself while a run is in flight — there is no loading state on this action today; this phase adds one.
- `AnalysisResultView` → the prose result renders inside a `Card` (P10§5.3); the confluence stat tile becomes a row of `Badge`s (P10§5.4) using the new `--bullish`/`--bearish`/`--neutral` semantic colors, replacing today's unstyled `<dl>`.
- The past-turns history stays a native `<details>` disclosure — unchanged interaction — restyled with tokens (border/radius/spacing) rather than left bare.
- Analysis-run failure renders as an error `Banner` (P10§5.7) scoped to this screen's content pane, replacing whatever renders (or fails to render) on failure today.

### P10§6.4 AI-Assisted chat (refinement, not rebuild)

The chat subtree is already this app's design baseline (P9B) — this pass refines it onto the promoted, app-wide tokens rather than rebuilding it:

- `theme.css`'s `.chat-view[data-theme]` scoping is removed; its variable values are merged into the global `tokens.css` (P10§3.1) and the `.chat-view`-scoping selector is dropped, since the theme now lives at the app root (P10§4.3).
- `ChatView` no longer owns theme state — the `useChatTheme` hook's logic (localStorage key, default dark) becomes the app-wide theme hook owned by `AppShell`/the sidebar footer; `ThemeToggle`'s button itself moves from inside `.chat-view` to the sidebar footer (P10§4.2, P10§4.3).
- Message bubbles are restyled onto `Card`/surface tokens, replacing hardcoded per-role colors (e.g. today's `.message-user { color: #fff }`-style rule) with token-driven surfaces that respond to the (now app-wide) theme.
- `AgentActivityPanel` / `TraceStepRow` status icons are refactored onto the shared `StatusDot` primitive (P10§5.5) — the auto-expand-while-running / collapse-on-done / stay-open-on-error *behavior* (P9B§8.2–§8.4) is unchanged; only the icon's rendering path changes.
- The verdict line (direction + conviction) is restyled with a `Badge` (P10§5.4) using the new semantic colors, replacing today's plain text rendering.
- The input row uses `TextField` + `Button` in place of today's unstyled `<input>`/`<button>` pair.

### P10§6.5 Benchmark

- Setup-form fields (cadence, manual every-N override, lookahead bars, date range) become `TextField`/segmented-control primitives (the same segmented-control pattern as P10§6.3's horizon toggle), replacing today's unstyled native form controls.
- The chart itself (`lightweight-charts`) is unchanged — this phase does not touch chart rendering logic — but `benchmarkChart.ts`'s hardcoded `OUTCOME_COLOR` map is replaced with the shared `--bullish`/`--bearish`/`--neutral` tokens (P10§3.1), so a decision-point marker's color now comes from the same palette the chat verdict badge and confluence stat tiles use.
- The summary strip becomes a row of `Badge`s (P10§5.4) inside a `Card` (P10§5.3).
- The results popover (`ResultsView`) becomes an elevated `Card` using `--shadow-md` so it reads as clearly floating above the chart.
- "Copy raw result" becomes a ghost-variant `Button` (P10§5.1).
- The benchmark-not-run-yet state uses `EmptyState` (P10§5.6).
- A benchmark-run failure renders as an error `Banner` (P10§5.7) scoped to this screen's content pane.
- Reached via a sidebar nav item rather than today's top-of-window button (P10§4.4).

### P10§6.6 Settings window

- Fieldsets are restyled as `Card` sections (P10§5.3).
- The proactive-scan enable/disable control uses the new `Switch` primitive (P10§5.9).
- The scan-interval select stays a styled native `<select>` — no custom dropdown primitive is built for it; a single control gets low value from a bespoke dropdown component (explicit, deliberate scope-limiting decision, not an oversight).
- Watchlist search/add/remove uses `TextField` + `Button` + removable `Badge` chips (P10§5.2, §5.1, §5.4).
- The account-status block (Kite/Claude connection state) uses `StatusDot` rows (P10§5.5) — the same visual pattern as the sidebar footer's connection-status rows (P10§4.2), so the two places the app shows "is X connected" look identical.
- Structurally untouched: own window, own preload, own IPC surface (P10§4.5).

## P10§7 Data flow / error handling / testing

### P10§7.1 Data flow

**No changes anywhere.** Every IPC channel, bridge method, service, and data shape defined in `src/main/ipc/rendererApi.ts` — `TraceEvent`, `AnalysisResult` (the `engine_only` | `ai_assisted` discriminated union), `AnalysisEnvelope`, `AlgoResultWire`/`ConfluenceWire`/`CandleWire`, `SessionSummary`/`HistoryMessage`/`SessionDetail`, `BenchmarkResult`/`DecisionPoint`, and `ScanConfig`/`AppStatus` — stays exactly as-is. This phase is presentation-layer only, full stop; nothing in `src/main/**` is touched by this phase.

### P10§7.2 Error handling

The `Banner` primitive (P10§5.7) covers two categories, both listed explicitly so there is no ambiguity about what's newly handled versus what already existed:

1. **Existing app-wide banners**, unchanged in trigger/content, only reskinned and repositioned: Kite-login-needed, MCP tool-list drift, sidecar-down — now rendered as a fixed strip at the top of the main content pane (P10§4.4) instead of an ad hoc inline list in `App.tsx`.
2. **New inline failure cases that currently render as nothing or raw text**, each becoming an error `Banner` scoped to its own screen's content pane: instrument-search failure (P10§6.3), analysis-run failure (P10§6.3), and benchmark-run failure (P10§6.5). These are net-new visible failure states, not a change to how or when the underlying operations fail — the app already surfaces these failures as rejected promises/thrown errors today; this phase gives them a visible, styled place to render instead of silently swallowing them or dumping raw error text.

### P10§7.3 Testing

Existing Vitest + Testing Library setup is unchanged; no new test framework is introduced.

- Each new primitive under `src/renderer/ui/` gets a small render test, matching the existing per-component test convention (e.g. `AgentActivityPanel.test.tsx`) — confirming it renders, accepts its documented variant/size/semantic props, and applies the corresponding class.
- The existing `test/renderer/styleCssSplit.test.ts` pattern (which today enforces that chat-specific CSS rules live in `ChatView.css`, not `style.css`) is extended with an equivalent check that `tokens.css` contains only custom-property declarations and resets — no component-specific selectors (e.g. no `.button`, no `.card`) — keeping the token layer strictly separate from the primitives that consume it, the same separation of concerns `styleCssSplit.test.ts` already enforces between global and chat-specific CSS.
- Screen-level behavior tests are unaffected in intent — no screen's underlying behavior (data fetching, selection, debounce, run-in-flight state, wizard flow) changes in this phase — but are re-run against every reskinned screen to catch className/structure assumptions baked into existing tests (e.g. a test asserting on a specific unstyled `<dl>` structure in `AnalysisResultView` needs updating once that structure becomes a `Badge` row, even though the underlying confluence data and computation are unchanged).

## P10§8 Out of scope

- **List/session/watchlist search, filtering, pagination, or virtualization** — every list touched in this phase (sidebar history, benchmark setup, Settings watchlist) is a visual-only reskin of what exists today; none of today's fetch/selection/rendering logic for these lists changes, and no new list-management feature is added.
- **Folding Settings into the main-window shell as a route** — it stays a separate `BrowserWindow` with its own preload/IPC/root (P10§4.5, §6.6).
- **Redesigning `ChatView`'s palette from scratch** — this phase extends and promotes the existing chat palette (P10§3.1); it is not replaced or reconceived.
- **A bundled webfont** — `--font-sans`/`--font-mono` stay the existing system-font stacks (P10§3.3).
- **Tailwind, CSS-in-JS, or any headless component library** — plain CSS + tokens only, with the one explicit exception of `lucide-react` for icons (P10§5.10).
- **Any IPC/data-shape change of any kind** — covered exhaustively in P10§7.1; restated here because it is the single most important non-goal of this phase, exactly as P9B§3/§16 restated the no-order-placement invariant for the same reason.

## P10§9 Scope note

This phase spans a design-tokens file, a new app-shell layout, nine new primitive components, and reskins of five screens (sidebar/history, mode picker, Engine-Only analysis, chat, benchmark) plus the Settings window. That is a wide *surface area*, but it is a single coherent unit of work with one clear dependency order (tokens → primitives → per-screen reskin, each screen consuming what the previous step built) and no independent sub-features that could ship or be evaluated in isolation of the others — a screen reskin has nothing to consume until the tokens and primitives exist, and the tokens/primitives have no reason to exist without the reskins that consume them. This is written up as one spec, matching how P9B was itself a single spec covering five new files and a cross-cutting theme; the natural unit of *implementation planning* is one task per numbered build step in P10§2's ordering, not a further split into separate specs.
