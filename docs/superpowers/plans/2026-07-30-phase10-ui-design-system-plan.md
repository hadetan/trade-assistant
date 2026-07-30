# Phase 10 — UI Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the app-wide design-tokens stylesheet and shared primitive component library (`src/renderer/ui/`), a persistent `AppShell` sidebar/content-pane layout, and reskin every existing screen (sidebar/history, mode picker, Engine-Only analysis, AI-Assisted chat, benchmark, Settings) onto them, closing the gap where only the Phase 9-B chat subtree had real styling and everything else rendered on bare, unstyled `className`s.

**Architecture:** Bottom-up, dependency-ordered build: a single global `tokens.css` (color/spacing/typography/radius/shadow custom properties, dark-default with a `[data-theme="light"]` override) is built first; nine tokens-only primitive components (`Button`, `TextField`, `Card`, `Badge`, `StatusDot`, `EmptyState`, `Banner`, `Spinner`, `Switch`) plus a thin `lucide-react` icon re-export (`icons.ts`) are built on top of it; a new `AppShell.tsx` repositions (not replaces) `App.tsx`'s existing view-switch `useState` logic inside a persistent sidebar + content-pane layout, retiring `HomeScreen.tsx` and promoting the chat's `useChatTheme`/`ThemeToggle` to the app root; every existing screen is then reskinned onto the primitives, in the fixed order the spec locks: sidebar/history → mode picker → Engine-Only analysis → chat refinement → benchmark → Settings. No IPC channel, preload surface, bridge, service, or data shape changes anywhere in this plan — this is a presentation-layer phase, full stop.

**Tech Stack:** Electron + TypeScript + React (existing), Vitest + Testing Library (existing), plain CSS + custom properties (existing pattern, now promoted app-wide), **one new npm dependency: `lucide-react`** (icons only — no Tailwind, no CSS-in-JS, no headless component library, no bundled webfont).

## Global Constraints

- **Permanent, non-negotiable safety invariant:** the app never places, modifies, cancels, or automates any order on Zerodha Kite — ever. This phase is presentation-layer work only. **No task in this plan may add, remove, or modify an IPC channel, an `ipcMain.handle`, a preload surface, or any file under `src/main/**`.** This is stricter than most prior phases' constraints because P10§7.1/§2/§8 each independently restate it as "the single most important non-goal of this phase" — every `TraceEvent`, `AnalysisResult`, `AnalysisEnvelope`, `SessionSummary`/`HistoryMessage`/`SessionDetail`, `BenchmarkResult`/`DecisionPoint`, and `ScanConfig`/`AppStatus` shape defined in `src/main/ipc/rendererApi.ts` stays byte-identical, and nothing under `src/main/**` is touched by any task below.
- **Resolved tension — Settings entry point (read before Task 12 or Task 18):** P10§4.5 says Settings "is opened via a sidebar button." Today, the *only* way to open the Settings `BrowserWindow` is `bootstrap.ts`'s tray menu (`showSettingsWindow`, wired only to `Tray`/`app.dock`) — verified by grep: no `src/renderer/**` file references `showSettingsWindow`, and `bootstrap.ts`'s `setWindowOpenHandler` denies every `window.open()` target except `https?:`/`mailto:` URLs. Making a sidebar button *actually open* the window requires a new `ipcMain.handle` (main-process change) or relaxing `setWindowOpenHandler` (also a main-process change) — both are exactly the class of change the phase's own non-goal list forbids "of any kind," restated three times. Per this plan's instructions to resolve spec ambiguity by leaning on the spec's own wording rather than inventing scope: the repeated, emphatic non-goal wins over the single incidental "sidebar button" mention. **Resolution:** no task in this plan adds a sidebar/Settings-window-opening control of any kind; the tray remains the sole, unchanged entry point. Task 18 restyles `SettingsWindow.tsx`'s own internals only.
- **`IntentLensSelector.tsx` is out of scope.** P10§1's inventory of unstyled screens (`HomeScreen.tsx`, `ModePicker.tsx`, `InstrumentSearch.tsx`, `AnalysisResult.tsx`, `HistorySidebar.tsx`, `BenchmarkView.tsx`, `SettingsWindow.tsx`) and every P10§6 per-screen subsection omit it entirely (confirmed by grep — zero mentions anywhere in the spec). No task below touches it.
- All commands in this plan run from `electron-app/` (the working directory).
- Exactly one new npm dependency across the whole plan: `lucide-react` (Task 2). Nothing else is installed.
- `npx tsc --noEmit` only type-checks `src/**` (test files are executed by Vitest with types stripped, not type-checked).
- Coding conventions (`CLAUDE.md`): no comments except for non-obvious *why*; TypeScript `camelCase` functions/variables, `PascalCase` types/classes/components; file names describe responsibility, not file kind (no `utils.ts`); small, focused files, one per primitive; pure logic separate from I/O (every `src/renderer/ui/*` primitive is pure render logic, no `fetch`/IPC calls of its own).
- Commit scope convention (established on this branch): every commit is scoped `(electron-app)` — e.g. `feat(electron-app): ...`, `refactor(electron-app): ...`. Plain `git commit -m "..."` — no `--author`, no `--no-verify`, no `Co-Authored-By` trailer.
- Reference names used throughout: "P10§N" → `docs/superpowers/specs/2026-07-30-phase10-ui-design-system-design.md`; "P9B§N" → `docs/superpowers/specs/2026-07-29-phase9b-agent-activity-chat-ui-design.md`.
- **Build order is locked (P10§2 item 4, locked decision 1) and this plan's task order must not be reordered:** tokens → primitives → app shell → per-screen reskins in the fixed sequence sidebar/history → mode picker → engine-only analysis → chat refinement → benchmark → settings → final regression gate. `AppShell` is placed after every primitive (Task 12, not earlier) because it consumes `Button`, `StatusDot`, `EmptyState`, and `Banner` directly (P10§4.2/§4.4) — it cannot be built before they exist.

## File touch-point summary

| File | Change | Task |
| --- | --- | --- |
| `electron-app/src/renderer/ui/tokens.css` | **New** — global color/spacing/typography/radius/shadow custom properties | 1 |
| `electron-app/src/renderer/main.tsx` | Add `import "./ui/tokens.css"` | 1 |
| `electron-app/src/renderer/settingsMain.tsx` | Add `import "./ui/tokens.css"` | 1 |
| `electron-app/test/renderer/styleCssSplit.test.ts` | Extended with a tokens.css-purity check | 1 |
| `electron-app/package.json` | Add `lucide-react` dependency | 2 |
| `electron-app/src/renderer/ui/icons.ts` | **New** — named lucide-react re-exports | 2 |
| `electron-app/src/renderer/ui/Button.tsx` + `.css` | **New** | 3 |
| `electron-app/test/renderer/ui/Button.test.tsx` | **New** | 3 |
| `electron-app/src/renderer/ui/TextField.tsx` + `.css` | **New** | 4 |
| `electron-app/test/renderer/ui/TextField.test.tsx` | **New** | 4 |
| `electron-app/src/renderer/ui/Card.tsx` + `.css` | **New** | 5 |
| `electron-app/test/renderer/ui/Card.test.tsx` | **New** | 5 |
| `electron-app/src/renderer/ui/Badge.tsx` + `.css` | **New** | 6 |
| `electron-app/test/renderer/ui/Badge.test.tsx` | **New** | 6 |
| `electron-app/src/renderer/ui/StatusDot.tsx` + `.css` | **New** | 7 |
| `electron-app/test/renderer/ui/StatusDot.test.tsx` | **New** | 7 |
| `electron-app/src/renderer/ui/EmptyState.tsx` + `.css` | **New** | 8 |
| `electron-app/test/renderer/ui/EmptyState.test.tsx` | **New** | 8 |
| `electron-app/src/renderer/ui/Banner.tsx` + `.css` | **New** | 9 |
| `electron-app/test/renderer/ui/Banner.test.tsx` | **New** | 9 |
| `electron-app/src/renderer/ui/Spinner.tsx` + `.css` | **New** | 10 |
| `electron-app/test/renderer/ui/Spinner.test.tsx` | **New** | 10 |
| `electron-app/src/renderer/ui/Switch.tsx` + `.css` | **New** | 11 |
| `electron-app/test/renderer/ui/Switch.test.tsx` | **New** | 11 |
| `electron-app/src/renderer/AppShell.tsx` + `.css` | **New** | 12 |
| `electron-app/test/renderer/AppShell.test.tsx` | **New** | 12 |
| `electron-app/src/renderer/App.tsx` | Renders `AppShell`; drops inline banners/Home/Benchmark buttons; retires `HomeScreen` usage | 12 |
| `electron-app/src/renderer/HomeScreen.tsx` | **Deleted** | 12 |
| `electron-app/test/renderer/HomeScreen.test.tsx` | **Deleted** | 12 |
| `electron-app/test/renderer/App.test.tsx` | Updated for "New session" rename, `AppShell` chrome, dropped Home button | 12 |
| `electron-app/src/renderer/HistorySidebar.tsx` + new `.css` | Reskinned; gains `activeSessionId` prop | 13 |
| `electron-app/test/renderer/HistorySidebar.test.tsx` | Updated for new prop/markup | 13 |
| `electron-app/src/renderer/ModePicker.tsx` + new `.css` | Reskinned onto `Card` | 14 |
| `electron-app/src/renderer/InstrumentSearch.tsx` + new `.css` | Reskinned; `onSubmit` may return `Promise<void>`; adds loading state | 15 |
| `electron-app/test/renderer/InstrumentSearch.test.tsx` | Updated + new loading-state test | 15 |
| `electron-app/src/renderer/AnalysisResult.tsx` + new `.css` | Reskinned onto `Card`/`Badge` | 15 |
| `electron-app/test/renderer/AnalysisResult.test.tsx` | Updated for new markup | 15 |
| `electron-app/test/renderer/App.test.tsx` | Horizon-toggle query updated (Engine-Only run test) | 15 |
| `electron-app/src/renderer/ChatView.tsx` / `.css` | Theme ownership removed; `Card`/`Badge`/`TextField`/`Button` adopted | 16 |
| `electron-app/src/renderer/theme.css` | **Deleted** (values already merged into `tokens.css` in Task 1) | 16 |
| `electron-app/src/renderer/AgentActivityPanel.tsx` / `.css` | Caret glyphs → `ChevronDown`/`ChevronRight` | 16 |
| `electron-app/src/renderer/TraceStepRow.tsx` / `.css` | Status glyphs → `StatusDot`; caret glyphs → chevrons | 16 |
| `electron-app/test/renderer/ChatView.test.tsx`, `AgentActivityPanel.test.tsx`, `TraceStepRow.test.tsx` | Updated for new markup | 16 |
| `electron-app/src/renderer/BenchmarkView.tsx` + new `.css` | Reskinned onto `Card`/`Badge`/`TextField`/`Button`/`EmptyState`/`Banner`/`Spinner` | 17 |
| `electron-app/src/renderer/benchmarkChart.ts` | `OUTCOME_COLOR` hex map → reads `--bullish`/`--bearish`/`--neutral` off the container | 17 |
| `electron-app/test/renderer/benchmarkChart.test.ts` | Rewritten to set/assert the CSS custom properties | 17 |
| `electron-app/src/renderer/SettingsWindow.tsx` + new `.css` | Reskinned onto `Card`/`Switch`/`TextField`/`Button`/`Badge`/`StatusDot` | 18 |
| `electron-app/test/renderer/SettingsWindow.test.tsx` | Updated for new remove-chip markup | 18 |

---

## Design decisions this plan locks in (read before starting any task)

These are implementation-level choices the spec leaves to the plan (P10§9: "the natural unit of *implementation planning* is one task per numbered build step"). Once fixed here, every later task depends on them verbatim — do not deviate.

**`tokens.css` new-token values** (P10§3.1/§3.4 name the tokens but not their exact values beyond the ones carried verbatim from `theme.css`):

| Token | Dark | Light | Rationale |
| --- | --- | --- | --- |
| `--bg-subtle` | `#161920` | `#f3f4f6` | one step up from `--bg` (dark) / a step down from `--bg` (light); hover/sidebar surface |
| `--bg-elevated` | `#1e222b` | `#ffffff` | `Card` surface. In dark mode this is visibly lighter than `--bg`; in light mode it equals `--bg` because white can't get "brighter" — elevation reads through `--shadow-sm`/`--shadow-md` alone in light mode, a deliberate, not accidental, equality |
| `--border-strong` | `#454c5e` | `#9ca3af` | higher-contrast neutral border, distinct from the `--accent` selected-row border it sits alongside (P10§3.1) |
| `--bullish` | `#16a34a` | `#15803d` | same green family as `--status-done`, semantically distinct concept |
| `--bearish` | `#dc2626` | `#b91c1c` | same red family as `--status-error` |
| `--neutral` | `#6b7280` | `#6b7280` | gray, theme-invariant; also this plan's generic/default `Badge` tone for non-directional labels (mode tags, watchlist chips) |
| `--space-1`…`--space-8` | `4/8/12/16/24/32/40/48px` | same | verbatim from P10§3.2's table |
| `--text-xs`…`--text-2xl` | `0.75/0.875/1/1.125/1.375/1.75rem` | same | a standard modular scale |
| `--font-weight-normal/medium/semibold` | `400/500/600` | same | — |
| `--radius-sm/md/lg` | `4/8/12px` | same | — |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.24)` | `0 1px 2px rgba(15,23,42,0.08)` | — |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.32)` | `0 4px 12px rgba(15,23,42,0.12)` | — |

**`icons.ts` exports** (P10§5.10 names a partial set and says "any others a given screen's reskin needs" — the complete set this plan actually uses, fixed now so every later task imports the same names): `Search`, `Send`, `Sun`, `Moon`, `ChevronDown`, `ChevronRight`, `Check`, `X`, `AlertTriangle`, `Info`, `Loader2`, `Copy`, `Plus`, `Inbox`, `MessageSquare`, `Gauge`, `BarChart3`, plus the `LucideIcon` type.

**`Badge` tone union:** `"bullish" | "bearish" | "neutral" | "running" | "done" | "error"` — the first three read off P10§3.1's new direction palette, the last three off the existing `--status-*` family. Non-directional labels (sidebar mode tag, Settings watchlist chips) use `"neutral"` — P10§5.4 explicitly lists both of these as `Badge` use sites even though neither is a bullish/bearish/status judgment, confirming `"neutral"` is this system's generic/default chip tone, not only "market-neutral."

**No polymorphic `as` prop on `Card`.** Every place the spec calls for `Card`-based structure that needs a specific semantic tag (a `<form>` for the benchmark setup, a disclosure-row `<button>` for sidebar history) wraps a plain semantic element *inside* a `<Card>`, or — where the row itself must be a native, single `<button>` for click/keyboard/test-compatibility reasons (sidebar history rows) — reuses `Card`'s CSS custom properties directly on a purpose-built class instead of importing the `Card` component. This matches P10§6.1's own "Card-*lite*" wording for the sidebar row (not "the `Card` component").

---

### Task 1: Design tokens — `src/renderer/ui/tokens.css`

**Files:**
- Create: `electron-app/src/renderer/ui/tokens.css`
- Modify: `electron-app/src/renderer/main.tsx`
- Modify: `electron-app/src/renderer/settingsMain.tsx`
- Modify: `electron-app/test/renderer/styleCssSplit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every custom property listed in this plan's "Design decisions" table above, plus the verbatim-carried-forward `--bg`/`--fg`/`--border`/`--code-bg`/`--accent`/`--status-running`/`--status-done`/`--status-error` pair (P10§3.1's table). Every task from Task 3 onward assumes these variables exist and reads them via `var(--token-name)`.

This task does not yet delete `theme.css` or change `ChatView`'s own `data-theme` scoping — `theme.css`'s `.chat-view[data-theme]` rule and this new global `[data-theme]` rule temporarily coexist with identical values (Task 16 removes `theme.css`). Nothing renders differently in the interim.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `electron-app/test/renderer/styleCssSplit.test.ts` with:

```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styleCss = readFileSync("src/renderer/style.css", "utf8");
const chatViewCss = readFileSync("src/renderer/ChatView.css", "utf8");
const tokensCss = readFileSync("src/renderer/ui/tokens.css", "utf8");

describe("style.css / ChatView.css split", () => {
  it("keeps shared rules in style.css", () => {
    expect(styleCss).toMatch(/\.error\s*{/);
    expect(styleCss).toMatch(/\.message-markdown/);
    expect(styleCss).toMatch(/\.mermaid/);
  });

  it("does not add chat-specific rules to style.css", () => {
    expect(styleCss).not.toMatch(/\.chat-view/);
    expect(styleCss).not.toMatch(/\.messages\s*{/);
    expect(styleCss).not.toMatch(/\.chat-input/);
    expect(styleCss).not.toMatch(/\.verdict/);
  });

  it("puts the new chat rules in ChatView.css instead", () => {
    expect(chatViewCss).toMatch(/\.chat-view\s*{/);
    expect(chatViewCss).toMatch(/\.messages\s*{/);
    expect(chatViewCss).toMatch(/\.chat-input/);
    expect(chatViewCss).toMatch(/\.verdict/);
  });
});

describe("tokens.css purity", () => {
  it("declares the dark-default and light-override token blocks", () => {
    expect(tokensCss).toMatch(/:root\s*{/);
    expect(tokensCss).toMatch(/\[data-theme=["']light["']\]\s*{/);
  });

  it("contains only custom-property declarations, no component selectors", () => {
    // Strip the two allowed block selectors and their braces; whatever's left
    // between the remaining `{`/`}` pairs must be pure `--x: value;` lines.
    const withoutBlockSelectors = tokensCss
      .replace(/:root\s*{/g, "{")
      .replace(/\[data-theme=["']light["']\]\s*{/g, "{");
    const declarationLines = withoutBlockSelectors
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "{" && line !== "}" && !line.startsWith("/*") && !line.startsWith("*"));
    for (const line of declarationLines) {
      expect(line).toMatch(/^--[a-z0-9-]+:\s*.+;$/);
    }
    expect(tokensCss).not.toMatch(/\.button\b/);
    expect(tokensCss).not.toMatch(/\.card\b/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/styleCssSplit.test.ts`
Expected: FAIL — `src/renderer/ui/tokens.css` does not exist yet (`readFileSync` throws `ENOENT`).

- [ ] **Step 3: Create `tokens.css`**

Create `electron-app/src/renderer/ui/tokens.css`:

```css
:root {
  --bg: #0f1115;
  --fg: #e6e6e6;
  --border: #2a2f3a;
  --code-bg: #1a1d24;
  --accent: #6366f1;
  --status-running: #d97706;
  --status-done: #16a34a;
  --status-error: #dc2626;

  --bg-subtle: #161920;
  --bg-elevated: #1e222b;
  --border-strong: #454c5e;

  --bullish: #16a34a;
  --bearish: #dc2626;
  --neutral: #6b7280;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 40px;
  --space-8: 48px;

  --font-sans: system-ui, sans-serif;
  --font-mono: ui-monospace, monospace;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-md: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.375rem;
  --text-2xl: 1.75rem;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.24);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.32);
}

[data-theme="light"] {
  --bg: #ffffff;
  --fg: #111827;
  --border: #d1d5db;
  --code-bg: #f3f4f6;
  --accent: #4f46e5;
  --status-running: #b45309;
  --status-done: #15803d;
  --status-error: #b91c1c;

  --bg-subtle: #f3f4f6;
  --bg-elevated: #ffffff;
  --border-strong: #9ca3af;

  --bullish: #15803d;
  --bearish: #b91c1c;
  --neutral: #6b7280;

  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.08);
  --shadow-md: 0 4px 12px rgba(15, 23, 42, 0.12);
}
```

- [ ] **Step 4: Wire `tokens.css` into both renderer entries**

In `electron-app/src/renderer/main.tsx`, add the import above the existing `style.css` import:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui/tokens.css";
import "./style.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
```

In `electron-app/src/renderer/settingsMain.tsx`, the same way:

```tsx
import { createRoot } from "react-dom/client";
import { SettingsWindow } from "./SettingsWindow";
import "./ui/tokens.css";
import "./style.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<SettingsWindow />);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/renderer/styleCssSplit.test.ts`
Expected: PASS (all five cases green).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ui/tokens.css src/renderer/main.tsx src/renderer/settingsMain.tsx test/renderer/styleCssSplit.test.ts
git commit -m "feat(electron-app): add the app-wide tokens.css design-tokens stylesheet"
```

---

### Task 2: `icons.ts` — the `lucide-react` icon re-export

**Files:**
- Modify: `electron-app/package.json` (add dependency)
- Create: `electron-app/src/renderer/ui/icons.ts`

**Interfaces:**
- Consumes: the `lucide-react` package.
- Produces: named re-exports `Search`, `Send`, `Sun`, `Moon`, `ChevronDown`, `ChevronRight`, `Check`, `X`, `AlertTriangle`, `Info`, `Loader2`, `Copy`, `Plus`, `Inbox`, `MessageSquare`, `Gauge`, `BarChart3`, and the `LucideIcon` type. Every later primitive/screen task that needs an icon imports it from `./icons` (or `../ui/icons`), never directly from `lucide-react` — this is the one file allowed to import that package.

- [ ] **Step 1: Install the dependency**

Run: `npm install lucide-react`
Expected: `package.json`'s `dependencies` gains a `lucide-react` entry (npm resolves and pins whatever the current published version is — do not hand-edit a version string).

- [ ] **Step 2: Verify the icon names this plan uses actually exist in the installed package**

Run:
```bash
node -e "const m = require('lucide-react'); ['Search','Send','Sun','Moon','ChevronDown','ChevronRight','Check','X','AlertTriangle','Info','Loader2','Copy','Plus','Inbox','MessageSquare','Gauge','BarChart3'].forEach(n => { if (!m[n]) throw new Error('missing icon: ' + n); }); console.log('all icons present');"
```
Expected: prints `all icons present`. If any icon is reported missing, pick the closest equivalently-named icon from `Object.keys(require('lucide-react'))` (e.g. `LoaderCircle` in place of `Loader2` on a version where the alias changed) and use that name consistently in Step 3 below and in every later task that references it — if you substitute a name, note the substitution in this task's commit message body.

- [ ] **Step 3: Create `icons.ts`**

Create `electron-app/src/renderer/ui/icons.ts`:

```typescript
export {
  Search,
  Send,
  Sun,
  Moon,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  AlertTriangle,
  Info,
  Loader2,
  Copy,
  Plus,
  Inbox,
  MessageSquare,
  Gauge,
  BarChart3,
} from "lucide-react";
export type { LucideIcon } from "lucide-react";
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors — confirms every re-exported name resolves against the installed package's type declarations.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/renderer/ui/icons.ts
git commit -m "feat(electron-app): add the lucide-react icon re-export module"
```

---

### Task 3: `Button` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Button.tsx`
- Create: `electron-app/src/renderer/ui/Button.css`
- Test: `electron-app/test/renderer/ui/Button.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables only (Task 1).
- Produces: `ButtonVariant = "primary" | "secondary" | "ghost" | "danger"`; `ButtonSize = "sm" | "md"`; `Button(props: ButtonProps): JSX.Element` where `ButtonProps` extends `React.ButtonHTMLAttributes<HTMLButtonElement>` with optional `variant` (default `"primary"`) and `size` (default `"md"`). Every later screen-reskin task imports `Button` from `./ui/Button` (or `../ui/Button` from `test/`) exactly this way; `EmptyState` (Task 8) imports it directly for its optional CTA.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../../src/renderer/ui/Button";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to the primary variant and md size", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.className).toContain("btn-primary");
    expect(button.className).toContain("btn-md");
  });

  it("applies every documented variant class", () => {
    (["primary", "secondary", "ghost", "danger"] as const).forEach((variant) => {
      const { unmount } = render(<Button variant={variant}>x</Button>);
      expect(screen.getByRole("button").className).toContain(`btn-${variant}`);
      unmount();
    });
  });

  it("applies every documented size class", () => {
    (["sm", "md"] as const).forEach((size) => {
      const { unmount } = render(<Button size={size}>x</Button>);
      expect(screen.getByRole("button").className).toContain(`btn-${size}`);
      unmount();
    });
  });

  it("defaults type to button so it never submits an ancestor form by accident", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("forwards an explicit type, onClick, and disabled", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" onClick={onClick} disabled>
        Go
      </Button>,
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.type).toBe("submit");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled(); // native disabled semantics suppress the click
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Button.test.tsx`
Expected: FAIL — `src/renderer/ui/Button.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: ButtonProps): JSX.Element {
  const classes = ["btn", `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}
```

Create `electron-app/src/renderer/ui/Button.css`:

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-family: var(--font-sans);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn-sm {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-sm);
}

.btn-md {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-md);
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-secondary {
  background: var(--bg-subtle);
  color: var(--fg);
  border-color: var(--border);
}

.btn-ghost {
  background: transparent;
  color: var(--fg);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-subtle);
}

.btn-danger {
  background: var(--status-error);
  color: #fff;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Button.test.tsx`
Expected: PASS (all five cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Button.tsx src/renderer/ui/Button.css test/renderer/ui/Button.test.tsx
git commit -m "feat(electron-app): add the Button primitive"
```

---

### Task 4: `TextField` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/TextField.tsx`
- Create: `electron-app/src/renderer/ui/TextField.css`
- Test: `electron-app/test/renderer/ui/TextField.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `Search` icon from `./icons` (Task 2).
- Produces: `TextFieldVariant = "default" | "search"`; `TextField(props: TextFieldProps): JSX.Element` where `TextFieldProps` extends `React.InputHTMLAttributes<HTMLInputElement>` with an optional `variant` (default `"default"`). Task 15 (`InstrumentSearch`) and Task 18 (`SettingsWindow` watchlist search) use `variant="search"`; Task 17 (`BenchmarkView`) uses the default variant for its number/date fields.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/TextField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextField } from "../../../src/renderer/ui/TextField";

afterEach(cleanup);

describe("TextField", () => {
  it("renders a plain input by default with no search icon", () => {
    const { container } = render(<TextField aria-label="plain" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("plain")).toBeTruthy();
    expect(container.querySelector(".text-field-icon")).toBeNull();
  });

  it("renders a search icon when variant is search", () => {
    const { container } = render(<TextField variant="search" aria-label="search" value="" onChange={() => {}} />);
    expect(container.querySelector(".text-field-icon")).toBeTruthy();
  });

  it("forwards value/onChange/placeholder/type to the underlying input", () => {
    const onChange = vi.fn();
    render(<TextField aria-label="qty" type="number" placeholder="Qty" value="5" onChange={onChange} />);
    const input = screen.getByLabelText("qty") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.placeholder).toBe("Qty");
    expect(input.value).toBe("5");
    fireEvent.change(input, { target: { value: "6" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/TextField.test.tsx`
Expected: FAIL — `src/renderer/ui/TextField.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/TextField.tsx`:

```tsx
import type { InputHTMLAttributes } from "react";
import "./TextField.css";
import { Search } from "./icons";

export type TextFieldVariant = "default" | "search";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: TextFieldVariant;
}

export function TextField({ variant = "default", className, ...rest }: TextFieldProps): JSX.Element {
  const wrapperClasses = ["text-field", `text-field-${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClasses}>
      {variant === "search" && <Search className="text-field-icon" size={14} aria-hidden="true" />}
      <input className="text-field-input" {...rest} />
    </div>
  );
}
```

Create `electron-app/src/renderer/ui/TextField.css`:

```css
.text-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  padding: 0 var(--space-2);
  width: 100%;
  box-sizing: border-box;
}

.text-field:focus-within {
  border-color: var(--accent);
}

.text-field-icon {
  color: var(--fg);
  opacity: 0.6;
  flex-shrink: 0;
}

.text-field-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--text-md);
  padding: var(--space-2) 0;
  outline: none;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/TextField.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/TextField.tsx src/renderer/ui/TextField.css test/renderer/ui/TextField.test.tsx
git commit -m "feat(electron-app): add the TextField primitive"
```

---

### Task 5: `Card` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Card.tsx`
- Create: `electron-app/src/renderer/ui/Card.css`
- Test: `electron-app/test/renderer/ui/Card.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables only.
- Produces: `Card(props: CardProps): JSX.Element` where `CardProps` extends `React.HTMLAttributes<HTMLDivElement>` with an optional `interactive` boolean (default `false`), rendering a `<div>`. Task 14 (`ModePicker`) uses `interactive` for its two clickable cards; Task 15 (`AnalysisResultView`), Task 17 (`BenchmarkView`'s summary strip and results popover), and Task 18 (`SettingsWindow`'s sections) use the non-interactive default.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "../../../src/renderer/ui/Card";

afterEach(cleanup);

describe("Card", () => {
  it("renders its children inside a div with the base card class", () => {
    render(<Card>content</Card>);
    const card = screen.getByText("content");
    expect(card.className).toContain("card");
    expect(card.className).not.toContain("card-interactive");
  });

  it("adds the interactive class when interactive is true", () => {
    render(<Card interactive>content</Card>);
    expect(screen.getByText("content").className).toContain("card-interactive");
  });

  it("forwards arbitrary HTML attributes (role, onClick, className)", () => {
    render(
      <Card role="button" className="mode-card" tabIndex={0}>
        content
      </Card>,
    );
    const card = screen.getByRole("button");
    expect(card.className).toContain("mode-card");
    expect(card.tabIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Card.test.tsx`
Expected: FAIL — `src/renderer/ui/Card.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Card.tsx`:

```tsx
import type { HTMLAttributes } from "react";
import "./Card.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive = false, className, ...rest }: CardProps): JSX.Element {
  const classes = ["card", interactive && "card-interactive", className].filter(Boolean).join(" ");
  return <div className={classes} {...rest} />;
}
```

Create `electron-app/src/renderer/ui/Card.css`:

```css
.card {
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  padding: var(--space-4);
}

.card-interactive {
  cursor: pointer;
}

.card-interactive:hover {
  box-shadow: var(--shadow-md);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Card.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Card.tsx src/renderer/ui/Card.css test/renderer/ui/Card.test.tsx
git commit -m "feat(electron-app): add the Card primitive"
```

---

### Task 6: `Badge` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Badge.tsx`
- Create: `electron-app/src/renderer/ui/Badge.css`
- Test: `electron-app/test/renderer/ui/Badge.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `X` icon from `./icons` (Task 2).
- Produces: `BadgeTone = "bullish" | "bearish" | "neutral" | "running" | "done" | "error"`; `Badge(props: BadgeProps): JSX.Element` where `BadgeProps` extends `React.HTMLAttributes<HTMLSpanElement>` with a required `tone: BadgeTone` and optional `onRemove?: () => void` / `removeLabel?: string` (renders a small `X`-icon remove button inside the badge when `onRemove` is supplied). Task 13 (sidebar mode tag), Task 15 (`AnalysisResultView` confluence stats), Task 16 (chat verdict), Task 17 (benchmark summary strip), and Task 18 (removable watchlist chips, via `onRemove`) all import this exact signature.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Badge.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge } from "../../../src/renderer/ui/Badge";

afterEach(cleanup);

describe("Badge", () => {
  it("applies the tone-specific class for every documented tone", () => {
    (["bullish", "bearish", "neutral", "running", "done", "error"] as const).forEach((tone) => {
      const { unmount } = render(<Badge tone={tone}>x</Badge>);
      expect(screen.getByText("x").className).toContain(`badge-${tone}`);
      unmount();
    });
  });

  it("renders no remove button when onRemove is not supplied", () => {
    render(<Badge tone="neutral">NSE:INFY</Badge>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a labelled remove button and calls onRemove when clicked", () => {
    const onRemove = vi.fn();
    render(
      <Badge tone="neutral" onRemove={onRemove} removeLabel="Remove NSE:INFY">
        NSE:INFY
      </Badge>,
    );
    const button = screen.getByRole("button", { name: "Remove NSE:INFY" });
    fireEvent.click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Badge.test.tsx`
Expected: FAIL — `src/renderer/ui/Badge.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Badge.tsx`:

```tsx
import type { HTMLAttributes } from "react";
import "./Badge.css";
import { X } from "./icons";

export type BadgeTone = "bullish" | "bearish" | "neutral" | "running" | "done" | "error";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone: BadgeTone;
  onRemove?: () => void;
  removeLabel?: string;
}

export function Badge({ tone, onRemove, removeLabel, className, children, ...rest }: BadgeProps): JSX.Element {
  const classes = ["badge", `badge-${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
      {onRemove && (
        <button type="button" className="badge-remove" onClick={onRemove} aria-label={removeLabel ?? "Remove"}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
```

Create `electron-app/src/renderer/ui/Badge.css`:

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-medium);
  background: var(--bg-subtle);
  border: 1px solid transparent;
}

.badge-bullish {
  color: var(--bullish);
  border-color: var(--bullish);
}

.badge-bearish {
  color: var(--bearish);
  border-color: var(--bearish);
}

.badge-neutral {
  color: var(--neutral);
  border-color: var(--neutral);
}

.badge-running {
  color: var(--status-running);
  border-color: var(--status-running);
}

.badge-done {
  color: var(--status-done);
  border-color: var(--status-done);
}

.badge-error {
  color: var(--status-error);
  border-color: var(--status-error);
}

.badge-remove {
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  margin-left: var(--space-1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Badge.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Badge.tsx src/renderer/ui/Badge.css test/renderer/ui/Badge.test.tsx
git commit -m "feat(electron-app): add the Badge primitive"
```

---

### Task 7: `StatusDot` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/StatusDot.tsx`
- Create: `electron-app/src/renderer/ui/StatusDot.css`
- Test: `electron-app/test/renderer/ui/StatusDot.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `Check`, `X`, `Loader2` icons from `./icons` (Task 2).
- Produces: `StatusDotTone = "running" | "done" | "error"`; `StatusDot({ tone, label, className }: StatusDotProps): JSX.Element`. Task 12 (`AppShell` sidebar footer's sidecar/Kite rows), Task 16 (`TraceStepRow`'s per-lane/per-algorithm status, replacing its raw `STATUS_ICON` glyph map), and Task 18 (`SettingsWindow`'s account-status block) all consume this exact signature. Each of those call sites owns its own mapping from its domain-specific status (`SidecarStatus`, `KiteSessionStatus`, `NodeStatus`) to this `tone` union — `StatusDot` itself has no knowledge of any of those domains.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/StatusDot.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "../../../src/renderer/ui/StatusDot";

afterEach(cleanup);

describe("StatusDot", () => {
  it("renders the label and a tone-specific wrapper class for every documented tone", () => {
    (["running", "done", "error"] as const).forEach((tone) => {
      const { unmount, container } = render(<StatusDot tone={tone} label={`state ${tone}`} />);
      expect(screen.getByText(`state ${tone}`)).toBeTruthy();
      expect(container.querySelector(`.status-dot-${tone}`)).toBeTruthy();
      unmount();
    });
  });

  it("spins only the running icon", () => {
    const { container: running } = render(<StatusDot tone="running" label="x" />);
    expect(running.querySelector(".status-dot-icon-spin")).toBeTruthy();
    const { container: done } = render(<StatusDot tone="done" label="x" />);
    expect(done.querySelector(".status-dot-icon-spin")).toBeNull();
  });

  it("forwards an extra className alongside the tone class", () => {
    const { container } = render(<StatusDot tone="done" label="x" className="sidebar-footer-row" />);
    const el = container.querySelector(".status-dot") as HTMLElement;
    expect(el.className).toContain("sidebar-footer-row");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/StatusDot.test.tsx`
Expected: FAIL — `src/renderer/ui/StatusDot.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/StatusDot.tsx`:

```tsx
import "./StatusDot.css";
import { Check, Loader2, X } from "./icons";
import type { LucideIcon } from "./icons";

export type StatusDotTone = "running" | "done" | "error";

export interface StatusDotProps {
  tone: StatusDotTone;
  label: string;
  className?: string;
}

const STATUS_ICON: Record<StatusDotTone, LucideIcon> = {
  running: Loader2,
  done: Check,
  error: X,
};

export function StatusDot({ tone, label, className }: StatusDotProps): JSX.Element {
  const Icon = STATUS_ICON[tone];
  const classes = ["status-dot", `status-dot-${tone}`, className].filter(Boolean).join(" ");
  const iconClasses = ["status-dot-icon", tone === "running" && "status-dot-icon-spin"].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <Icon className={iconClasses} size={14} aria-hidden="true" />
      <span className="status-dot-label">{label}</span>
    </span>
  );
}
```

Create `electron-app/src/renderer/ui/StatusDot.css`:

```css
.status-dot {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  color: var(--fg);
}

.status-dot-running .status-dot-icon {
  color: var(--status-running);
}

.status-dot-done .status-dot-icon {
  color: var(--status-done);
}

.status-dot-error .status-dot-icon {
  color: var(--status-error);
}

.status-dot-icon-spin {
  animation: status-dot-spin 1s linear infinite;
}

@keyframes status-dot-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/StatusDot.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/StatusDot.tsx src/renderer/ui/StatusDot.css test/renderer/ui/StatusDot.test.tsx
git commit -m "feat(electron-app): add the StatusDot primitive"
```

---

### Task 8: `EmptyState` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/EmptyState.tsx`
- Create: `electron-app/src/renderer/ui/EmptyState.css`
- Test: `electron-app/test/renderer/ui/EmptyState.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `Button` (Task 3); `LucideIcon` type from `./icons` (Task 2).
- Produces: `EmptyState({ icon, message, action, className }: EmptyStateProps): JSX.Element` where `icon: LucideIcon` (caller-supplied, e.g. `Inbox`/`MessageSquare`/`BarChart3` — `EmptyState` itself hardcodes no icon, keeping it screen-agnostic) and `action?: { label: string; onClick: () => void }`. Task 12 (`App.tsx`'s no-active-session welcome), Task 13 (`HistorySidebar`'s no-sessions-yet state), and Task 17 (`BenchmarkView`'s no-data-ingested state) consume this signature.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/EmptyState.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../../../src/renderer/ui/EmptyState";
import { Inbox } from "../../../src/renderer/ui/icons";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders the icon and message with no action button by default", () => {
    const { container } = render(<EmptyState icon={Inbox} message="No sessions yet — start a new one." />);
    expect(screen.getByText("No sessions yet — start a new one.")).toBeTruthy();
    expect(container.querySelector(".empty-state-icon")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an action button and calls its onClick when supplied", () => {
    const onClick = vi.fn();
    render(<EmptyState icon={Inbox} message="Nothing here" action={{ label: "Start", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/EmptyState.test.tsx`
Expected: FAIL — `src/renderer/ui/EmptyState.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/EmptyState.tsx`:

```tsx
import "./EmptyState.css";
import { Button } from "./Button";
import type { LucideIcon } from "./icons";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: EmptyStateAction;
  className?: string;
}

export function EmptyState({ icon: Icon, message, action, className }: EmptyStateProps): JSX.Element {
  const classes = ["empty-state", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Icon className="empty-state-icon" size={32} aria-hidden="true" />
      <p className="empty-state-message">{message}</p>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}
```

Create `electron-app/src/renderer/ui/EmptyState.css`:

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6);
  color: var(--fg);
  text-align: center;
}

.empty-state-icon {
  color: var(--neutral);
}

.empty-state-message {
  margin: 0;
  font-size: var(--text-sm);
  opacity: 0.8;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/EmptyState.test.tsx`
Expected: PASS (both cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/EmptyState.tsx src/renderer/ui/EmptyState.css test/renderer/ui/EmptyState.test.tsx
git commit -m "feat(electron-app): add the EmptyState primitive"
```

---

### Task 9: `Banner` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Banner.tsx`
- Create: `electron-app/src/renderer/ui/Banner.css`
- Test: `electron-app/test/renderer/ui/Banner.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `AlertTriangle`, `Info` icons from `./icons` (Task 2).
- Produces: `BannerVariant = "info" | "warning" | "error"`; `Banner({ variant, children, className }: BannerProps): JSX.Element`. Task 12 (`AppShell`'s fixed banner strip for `kiteLogin`/`mcpDrift`/`sidecarDown`), Task 15 (`InstrumentSearch`/`AnalysisResult` run-failure banners), Task 17 (benchmark-run failure), and Task 18 (Settings drift warning) all consume this signature.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Banner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Banner } from "../../../src/renderer/ui/Banner";

afterEach(cleanup);

describe("Banner", () => {
  it("renders its message and a variant-specific class for every documented variant", () => {
    (["info", "warning", "error"] as const).forEach((variant) => {
      const { unmount, container } = render(<Banner variant={variant}>{variant} message</Banner>);
      expect(screen.getByText(`${variant} message`)).toBeTruthy();
      expect(container.querySelector(`.banner-${variant}`)).toBeTruthy();
      unmount();
    });
  });

  it("uses an alert role for the error variant so it is announced immediately", () => {
    render(<Banner variant="error">boom</Banner>);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("uses a status role for info/warning so they don't interrupt", () => {
    render(<Banner variant="warning">heads up</Banner>);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Banner.test.tsx`
Expected: FAIL — `src/renderer/ui/Banner.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Banner.tsx`:

```tsx
import type { ReactNode } from "react";
import "./Banner.css";
import { AlertTriangle, Info } from "./icons";
import type { LucideIcon } from "./icons";

export type BannerVariant = "info" | "warning" | "error";

export interface BannerProps {
  variant: BannerVariant;
  children: ReactNode;
  className?: string;
}

const BANNER_ICON: Record<BannerVariant, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertTriangle,
};

export function Banner({ variant, children, className }: BannerProps): JSX.Element {
  const Icon = BANNER_ICON[variant];
  const classes = ["banner", `banner-${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={variant === "error" ? "alert" : "status"}>
      <Icon className="banner-icon" size={16} aria-hidden="true" />
      <div className="banner-message">{children}</div>
    </div>
  );
}
```

Create `electron-app/src/renderer/ui/Banner.css`:

```css
.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.banner-info {
  background: var(--bg-subtle);
  color: var(--fg);
  border: 1px solid var(--border);
}

.banner-warning {
  background: var(--bg-subtle);
  color: var(--status-running);
  border: 1px solid var(--status-running);
}

.banner-error {
  background: var(--bg-subtle);
  color: var(--status-error);
  border: 1px solid var(--status-error);
}

.banner-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.banner-message {
  flex: 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Banner.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Banner.tsx src/renderer/ui/Banner.css test/renderer/ui/Banner.test.tsx
git commit -m "feat(electron-app): add the Banner primitive"
```

---

### Task 10: `Spinner` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Spinner.tsx`
- Create: `electron-app/src/renderer/ui/Spinner.css`
- Test: `electron-app/test/renderer/ui/Spinner.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `Loader2` icon from `./icons` (Task 2).
- Produces: `Spinner({ size, className, label }: SpinnerProps): JSX.Element`, `size` default `16`, `label` default `"Loading"`. Task 15 (`InstrumentSearch`'s in-flight Analyze button) and Task 17 (`BenchmarkView`'s lake-loading state and in-flight Run button) consume this signature.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Spinner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Spinner } from "../../../src/renderer/ui/Spinner";

afterEach(cleanup);

describe("Spinner", () => {
  it("renders with an accessible status role and default label", () => {
    render(<Spinner />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("accepts a custom label and size", () => {
    render(<Spinner label="Running…" size={24} />);
    const el = screen.getByRole("status", { name: "Running…" });
    expect(el.getAttribute("width")).toBe("24");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Spinner.test.tsx`
Expected: FAIL — `src/renderer/ui/Spinner.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Spinner.tsx`:

```tsx
import "./Spinner.css";
import { Loader2 } from "./icons";

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({ size = 16, className, label = "Loading" }: SpinnerProps): JSX.Element {
  const classes = ["spinner", className].filter(Boolean).join(" ");
  return <Loader2 className={classes} size={size} role="status" aria-label={label} />;
}
```

Create `electron-app/src/renderer/ui/Spinner.css`:

```css
.spinner {
  color: var(--accent);
  animation: spinner-spin 1s linear infinite;
}

@keyframes spinner-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Spinner.test.tsx`
Expected: PASS (both cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Spinner.tsx src/renderer/ui/Spinner.css test/renderer/ui/Spinner.test.tsx
git commit -m "feat(electron-app): add the Spinner primitive"
```

---

### Task 11: `Switch` primitive

**Files:**
- Create: `electron-app/src/renderer/ui/Switch.tsx`
- Create: `electron-app/src/renderer/ui/Switch.css`
- Test: `electron-app/test/renderer/ui/Switch.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables only.
- Produces: `Switch({ checked, onChange, label, disabled, className }: SwitchProps): JSX.Element`. Task 18 (`SettingsWindow`'s proactive-scan enable/disable control) consumes this signature — the only current call site, but generic/reusable per P10§5.9.

- [ ] **Step 1: Write the failing test**

Create `electron-app/test/renderer/ui/Switch.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "../../../src/renderer/ui/Switch";

afterEach(cleanup);

describe("Switch", () => {
  it("reflects the checked prop and exposes a switch role via its label", () => {
    render(<Switch checked={true} onChange={vi.fn()} label="Enable proactive scanning" />);
    const input = screen.getByLabelText("Enable proactive scanning") as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.getAttribute("role")).toBe("switch");
  });

  it("calls onChange with the flipped boolean when toggled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable proactive scanning" />);
    fireEvent.click(screen.getByLabelText("Enable proactive scanning"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disables the input when disabled is true", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="x" disabled />);
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ui/Switch.test.tsx`
Expected: FAIL — `src/renderer/ui/Switch.tsx` does not exist yet.

- [ ] **Step 3: Implement**

Create `electron-app/src/renderer/ui/Switch.tsx`:

```tsx
import "./Switch.css";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, disabled, className }: SwitchProps): JSX.Element {
  const classes = ["switch", className].filter(Boolean).join(" ");
  return (
    <label className={classes}>
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}
```

Create `electron-app/src/renderer/ui/Switch.css`:

```css
.switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}

.switch-input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.switch-track {
  width: 2.25rem;
  height: 1.25rem;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  transition: background 0.15s ease;
  flex-shrink: 0;
}

.switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}

.switch-input:checked + .switch-track {
  background: var(--accent);
}

.switch-input:checked + .switch-track .switch-thumb {
  transform: translateX(1rem);
}

.switch-input:disabled + .switch-track {
  opacity: 0.5;
  cursor: default;
}

.switch-label {
  font-size: var(--text-sm);
  color: var(--fg);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ui/Switch.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/ui/Switch.tsx src/renderer/ui/Switch.css test/renderer/ui/Switch.test.tsx
git commit -m "feat(electron-app): add the Switch primitive"
```

---

### Task 12: `AppShell` — persistent sidebar/content-pane layout

**Files:**
- Create: `electron-app/src/renderer/AppShell.tsx`
- Create: `electron-app/src/renderer/AppShell.css`
- Test: `electron-app/test/renderer/AppShell.test.tsx`
- Modify: `electron-app/src/renderer/App.tsx`
- Modify: `electron-app/src/renderer/ThemeToggle.css` (positioning only — see Step 5)
- Delete: `electron-app/src/renderer/HomeScreen.tsx`
- Delete: `electron-app/test/renderer/HomeScreen.test.tsx`
- Modify: `electron-app/test/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `Button` (Task 3), `StatusDot` (Task 7), `Banner` (Task 9), `Plus`/`BarChart3` icons (Task 2), the *existing, unmodified* `HistorySidebar` (its Task 13 reskin comes next and only touches its internals, not its prop names below), and the *existing, unmodified* `ThemeToggle`/`useChatTheme` (P9B).
- Produces: `AppShellProps { status: AppStatus | null; banners: BannerEvent[]; sessions: SessionSummary[]; activeSessionId: string | null; benchmarkActive: boolean; onNewSession: () => void; onOpenSession: (id: string) => void; onOpenBenchmark: () => void; children: ReactNode }`; `AppShell(props: AppShellProps): JSX.Element`. `App.tsx` is the sole consumer.
- **New prop this task adds to `HistorySidebar`:** `activeSessionId: string | null` — `HistorySidebar`'s own signature/markup changes belong to Task 13, but `AppShell` must already pass this prop when it's created, so Task 13 doesn't have to touch `AppShell.tsx` at all. Until Task 13 lands, `HistorySidebarProps` doesn't have this field yet, so **this task also adds the field to the existing `HistorySidebarProps` interface (a type-only, zero-visual-effect addition)** without changing `HistorySidebar.tsx`'s rendering — see Step 3.

**Two intentional, temporary staged states this task leaves behind (both are fully resolved by name in later tasks — do not "fix" them early, and do not treat them as bugs when reviewing this task in isolation):**
1. **Double theme ownership.** `ChatView.tsx` still calls its own `useChatTheme()` and renders its own `<ThemeToggle>` inside `.chat-view` (P9B, untouched by this task) *in addition to* the one `AppShell` now renders in the sidebar footer. Both read/write the same `localStorage["chatTheme"]` key but are independent React state, so toggling one won't visually flip the other until a remount. Task 16 (chat refinement) removes `ChatView`'s copy, per P10§6.4's explicit assignment of that change to the chat pass, not this one.
2. **Login button and its error stay unstyled.** `IntentLensSelector.tsx` (already out of scope, see Global Constraints) and the shared `activeSession !== null && !authenticated` gate's "Login to Kite" button/error are not named in any P10§6 subsection and sit outside every per-screen boundary (they render before either Engine-Only or Chat, not owned by either). They are left as plain HTML by every task in this plan — a deliberate omission, not an oversight.

- [ ] **Step 1: Write the failing `AppShell` test**

Create `electron-app/test/renderer/AppShell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../src/renderer/AppShell";
import type { AppShellProps } from "../../src/renderer/AppShell";
import type { AppStatus, BannerEvent, SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const STATUS: AppStatus = { sidecar: "up", kiteSession: "needsLogin", driftWarning: null };
const SESSIONS: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: new Date().toISOString(), preview: "how is infy" },
];

function renderShell(overrides: Partial<AppShellProps> = {}) {
  const onNewSession = vi.fn();
  const onOpenSession = vi.fn();
  const onOpenBenchmark = vi.fn();
  const utils = render(
    <AppShell
      status={STATUS}
      banners={[]}
      sessions={SESSIONS}
      activeSessionId={null}
      benchmarkActive={false}
      onNewSession={onNewSession}
      onOpenSession={onOpenSession}
      onOpenBenchmark={onOpenBenchmark}
      {...overrides}
    >
      <div>content</div>
    </AppShell>,
  );
  return { ...utils, onNewSession, onOpenSession, onOpenBenchmark };
}

describe("AppShell", () => {
  it("renders the sidebar header, nav, history, footer, and the content pane children", () => {
    renderShell();
    expect(screen.getByText("Trade Assistant")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /benchmark/i })).toBeTruthy();
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("calls onNewSession, onOpenBenchmark, and onOpenSession", () => {
    const { onNewSession, onOpenBenchmark, onOpenSession } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /benchmark/i }));
    expect(onOpenBenchmark).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("renders one error Banner per pushed sidecarDown banner, above the content pane", () => {
    const banners: BannerEvent[] = [{ kind: "sidecarDown", message: "sidecar unreachable" }];
    renderShell({ banners });
    expect(screen.getByText("sidecar unreachable")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders a warning Banner for kiteLogin/mcpDrift banners", () => {
    const banners: BannerEvent[] = [{ kind: "kiteLogin", message: "please log in" }];
    renderShell({ banners });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("maps sidecar/Kite status to StatusDot labels in the footer", () => {
    renderShell({ status: { sidecar: "down", kiteSession: "authenticated", driftWarning: null } });
    expect(screen.getByText(/sidecar down/i)).toBeTruthy();
    expect(screen.getByText(/kite authenticated/i)).toBeTruthy();
  });

  it("renders dark by default and flips the app root's data-theme when the theme toggle is clicked", () => {
    const { container } = renderShell();
    const root = container.querySelector(".app-shell") as HTMLElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("marks the benchmark nav item active when benchmarkActive is true", () => {
    renderShell({ benchmarkActive: true });
    expect(screen.getByRole("button", { name: /benchmark/i }).className).toContain("app-nav-item-active");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/AppShell.test.tsx`
Expected: FAIL — `src/renderer/AppShell.tsx` does not exist yet.

- [ ] **Step 3: Add the `activeSessionId` field to `HistorySidebarProps` (type-only)**

In `electron-app/src/renderer/HistorySidebar.tsx`, widen the props interface without changing any rendering:

```tsx
export interface HistorySidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
}

export function HistorySidebar({ sessions, onOpenSession }: HistorySidebarProps): JSX.Element {
```

(`activeSessionId` is accepted but not yet destructured/used — Task 13 is what makes it affect rendering. TypeScript does not error on an unused destructured *prop that isn't destructured at all*, only on an unused *local variable*, so leaving it out of the destructuring pattern here is not a type error.)

In `electron-app/test/renderer/HistorySidebar.test.tsx`, add the now-required prop to both existing `render` calls so the suite keeps compiling:

```tsx
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={vi.fn()} />);
```
and
```tsx
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={onOpenSession} />);
```

- [ ] **Step 4: Implement `AppShell`**

Create `electron-app/src/renderer/AppShell.tsx`:

```tsx
import type { ReactNode } from "react";
import "./AppShell.css";
import { HistorySidebar } from "./HistorySidebar";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/StatusDot";
import type { StatusDotTone } from "./ui/StatusDot";
import { Banner } from "./ui/Banner";
import type { BannerVariant } from "./ui/Banner";
import { ThemeToggle, useChatTheme } from "./ThemeToggle";
import { BarChart3, Plus } from "./ui/icons";
import type { AppStatus, BannerEvent, BannerKind, KiteSessionStatus, SessionSummary, SidecarStatus } from "../main/ipc/rendererApi";

export interface AppShellProps {
  status: AppStatus | null;
  banners: BannerEvent[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  benchmarkActive: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onOpenBenchmark: () => void;
  children: ReactNode;
}

function sidecarTone(status: SidecarStatus | undefined): StatusDotTone {
  if (status === "up") return "done";
  if (status === "restarting") return "running";
  return "error";
}

function kiteTone(status: KiteSessionStatus | undefined): StatusDotTone {
  if (status === "authenticated") return "done";
  if (status === "needsLogin") return "running";
  return "error";
}

function bannerVariant(kind: BannerKind): BannerVariant {
  return kind === "sidecarDown" ? "error" : "warning";
}

export function AppShell({
  status,
  banners,
  sessions,
  activeSessionId,
  benchmarkActive,
  onNewSession,
  onOpenSession,
  onOpenBenchmark,
  children,
}: AppShellProps): JSX.Element {
  const [theme, toggleTheme] = useChatTheme();

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="app-sidebar">
        <div className="app-sidebar-header">
          <div className="app-brand">Trade Assistant</div>
          <Button className="app-sidebar-new" onClick={onNewSession}>
            <Plus size={16} aria-hidden="true" /> New session
          </Button>
        </div>
        <nav className="app-sidebar-nav">
          <button
            type="button"
            className={`app-nav-item${benchmarkActive ? " app-nav-item-active" : ""}`}
            onClick={onOpenBenchmark}
          >
            <BarChart3 size={16} aria-hidden="true" /> Benchmark
          </button>
        </nav>
        <div className="app-sidebar-body">
          <HistorySidebar sessions={sessions} activeSessionId={activeSessionId} onOpenSession={onOpenSession} />
        </div>
        <div className="app-sidebar-footer">
          <StatusDot tone={sidecarTone(status?.sidecar)} label={`Sidecar ${status?.sidecar ?? "…"}`} />
          <StatusDot tone={kiteTone(status?.kiteSession)} label={`Kite ${status?.kiteSession ?? "…"}`} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </aside>
      <main className="app-content">
        {banners.length > 0 && (
          <div className="app-banners">
            {banners.map((banner, index) => (
              <Banner key={index} variant={bannerVariant(banner.kind)}>
                {banner.message}
              </Banner>
            ))}
          </div>
        )}
        <div className="app-content-pane">{children}</div>
      </main>
    </div>
  );
}
```

Create `electron-app/src/renderer/AppShell.css`:

```css
.app-shell {
  display: flex;
  height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
}

.app-sidebar {
  display: flex;
  flex-direction: column;
  width: 260px;
  flex-shrink: 0;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border);
}

.app-sidebar-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.app-brand {
  font-weight: var(--font-weight-semibold);
  font-size: var(--text-lg);
}

.app-sidebar-new {
  width: 100%;
}

.app-sidebar-nav {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
}

.app-nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: var(--text-sm);
  cursor: pointer;
  text-align: left;
}

.app-nav-item:hover {
  background: var(--bg-elevated);
}

.app-nav-item-active {
  background: var(--bg-elevated);
  border-left: 2px solid var(--accent);
}

.app-sidebar-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
}

.app-sidebar-footer {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}

.app-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}

.app-banners {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4) 0;
}

.app-content-pane {
  flex: 1;
  padding: var(--space-5);
}
```

- [ ] **Step 5: Reposition `ThemeToggle` for the sidebar footer's flex flow**

`ThemeToggle.tsx`'s own markup/hook logic stays byte-identical (P10§4.3 — only ownership moves, not the component itself), but its CSS was written for absolute positioning inside `.chat-view`; inside `.app-sidebar-footer`'s flex row it must lay out inline instead. Replace the whole contents of `electron-app/src/renderer/ThemeToggle.css`:

```css
.theme-toggle {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--code-bg);
  color: var(--fg);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  margin-left: auto;
}
```

- [ ] **Step 6: Run the `AppShell` test to verify it passes**

Run: `npx vitest run test/renderer/AppShell.test.tsx test/renderer/HistorySidebar.test.tsx`
Expected: PASS.

- [ ] **Step 7: Retire `HomeScreen.tsx`**

```bash
git rm src/renderer/HomeScreen.tsx test/renderer/HomeScreen.test.tsx
```

Its two responsibilities (new-session button, history list) now live permanently in `AppShell`'s sidebar (locked decision 6, P10§2).

- [ ] **Step 8: Rewrite `App.tsx` to render inside `AppShell`**

Replace the whole contents of `electron-app/src/renderer/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ModePicker } from "./ModePicker";
import { IntentLensSelector } from "./IntentLensSelector";
import { InstrumentSearch } from "./InstrumentSearch";
import { AnalysisResultView } from "./AnalysisResult";
import { ChatView, historyToChatMessages } from "./ChatView";
import { BenchmarkView } from "./BenchmarkView";
import { AppShell } from "./AppShell";
import { EmptyState } from "./ui/EmptyState";
import { MessageSquare } from "./ui/icons";
import { bridge } from "./bridge";
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisRunParams,
  AppStatus,
  BannerEvent,
  HistoryMessage,
  Horizon,
  InstrumentSelection,
  IntentLens,
  SessionDetail,
  SessionSummary,
} from "../main/ipc/rendererApi";

interface ActiveSession {
  id: string;
  mode: AnalysisMode;
}

function deriveEngineOnlyView(detail: SessionDetail | null): { result?: AnalysisResult; history: HistoryMessage[] } {
  const messages = detail?.messages ?? [];
  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIndex === -1) return { history: messages };
  return {
    result: messages[lastAssistantIndex].structured_payload as AnalysisResult,
    history: messages.filter((_, index) => index !== lastAssistantIndex),
  };
}

export function App(): JSX.Element {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showModePicker, setShowModePicker] = useState(false);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [intentLens, setIntentLens] = useState<IntentLens>("buying");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [banners, setBanners] = useState<BannerEvent[]>([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    void bridge().getStatus().then(setStatus);
    void bridge().listSessions().then(setSessions);
    bridge().onBanner((banner) => {
      setBanners((prev) => [...prev, banner]);
      // markNeedsLogin only emits the banner, not a status update; re-fetch here to avoid stale
      // authenticated state after a real Kite session expiry.
      if (banner.kind === "kiteLogin") void bridge().getStatus().then(setStatus);
    });
  }, []);

  // "New session" (renamed from "New Chat", P10§4.2) is now always visible in the
  // sidebar rather than gated behind a dedicated Home screen, so it must reset
  // every other top-level view flag itself instead of relying on them already
  // being false.
  const onNewSession = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowBenchmark(false);
    setShowModePicker(true);
    void bridge().listSessions().then(setSessions);
  };

  const onOpenBenchmark = (): void => {
    setActiveSession(null);
    setSessionDetail(null);
    setShowModePicker(false);
    setShowBenchmark(true);
  };

  const onSelectMode = async (mode: AnalysisMode): Promise<void> => {
    const session = await bridge().createSession(mode);
    setSessions((prev) => [session, ...prev]);
    setSessionDetail(null);
    setActiveSession({ id: session.id, mode });
    setShowModePicker(false);
  };

  const onOpenSession = async (id: string): Promise<void> => {
    // The sidebar (and its history rows) is now always visible, so a click here can
    // arrive while the mode picker or benchmark view is showing in the content pane.
    setShowModePicker(false);
    setShowBenchmark(false);
    const detail = await bridge().getSession(id);
    setSessionDetail(detail);
    setActiveSession({ id: detail.id, mode: detail.response_mode });
    const lastUserMessage = [...detail.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      const payload = lastUserMessage.structured_payload as AnalysisRunParams;
      setIntentLens(payload.intent_lens);
    }
  };

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true);
    setLoginError(null);
    const loginResult = await bridge().login();
    setLoggingIn(false);
    if (loginResult.status === "authenticated") {
      setStatus(await bridge().getStatus());
      setBanners((prev) => prev.filter((banner) => banner.kind !== "kiteLogin"));
    } else {
      setLoginError(loginResult.message);
    }
  };

  const onAnalyze = async (instrument: InstrumentSelection, horizon: Horizon): Promise<void> => {
    if (!activeSession) return;
    setAnalysisError(null);
    try {
      await bridge().runAnalysis({ mode: "engine_only", sessionId: activeSession.id, instrument, horizon, intent_lens: intentLens });
      setSessionDetail(await bridge().getSession(activeSession.id));
    } catch (error) {
      setAnalysisError((error as Error).message);
    }
  };

  const authenticated = status?.kiteSession === "authenticated";
  const { result, history } = deriveEngineOnlyView(sessionDetail);

  return (
    <AppShell
      status={status}
      banners={banners}
      sessions={sessions}
      activeSessionId={activeSession?.id ?? null}
      benchmarkActive={showBenchmark}
      onNewSession={onNewSession}
      onOpenSession={(id) => void onOpenSession(id)}
      onOpenBenchmark={onOpenBenchmark}
    >
      {activeSession === null && showModePicker && <ModePicker onSelect={(mode) => void onSelectMode(mode)} />}
      {activeSession === null && showBenchmark && <BenchmarkView api={bridge()} />}
      {activeSession === null && !showModePicker && !showBenchmark && (
        <EmptyState icon={MessageSquare} message="Select New session to start, or reopen a session from the sidebar." />
      )}

      {activeSession !== null && !authenticated && (
        <>
          <button type="button" onClick={() => void onLogin()} disabled={loggingIn}>
            {loggingIn ? "Logging in…" : "Login to Kite"}
          </button>
          {loginError && <div className="error">{loginError}</div>}
        </>
      )}

      {activeSession !== null && authenticated && (
        <>
          <IntentLensSelector value={intentLens} onChange={setIntentLens} />
          {activeSession.mode === "engine_only" ? (
            <>
              <InstrumentSearch onSubmit={onAnalyze} />
              {analysisError && <div className="error">{analysisError}</div>}
              {result && <AnalysisResultView result={result} history={history} />}
            </>
          ) : (
            <ChatView
              intentLens={intentLens}
              sessionId={activeSession.id}
              initialMessages={historyToChatMessages(sessionDetail?.messages ?? [])}
            />
          )}
        </>
      )}
    </AppShell>
  );
}
```

Note what deliberately did **not** change: `onAnalyze`'s body (still swallows the error into `analysisError`, still refetches only `sessionDetail` not the sessions list — a pre-existing staleness in the sidebar preview after an Engine-Only run that this phase does not newly introduce, since today's equivalent `onBackToHome` refresh required an explicit navigation the user might not take either); `onSelectMode`/`onLogin` bodies; `deriveEngineOnlyView`. Only `onNewSession` (renamed, now also resets every view flag and refetches sessions) and `onOpenSession` (now also resets the mode-picker/benchmark flags) gained behavior, both strictly required by the sidebar becoming permanently visible instead of gated behind `HomeScreen`.

- [ ] **Step 9: Rewrite `App.test.tsx`**

Replace the whole contents of `electron-app/test/renderer/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { installBridge } from "./testBridge";

afterEach(cleanup);

async function startEngineOnlyChat(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
  fireEvent.click(await screen.findByRole("button", { name: /engine-only/i }));
}

describe("App", () => {
  it("renders the sidecar/Kite status from the bridge", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByText(/sidecar up/i)).toBeTruthy();
    expect(screen.getByText(/kite needsLogin/i)).toBeTruthy();
  });

  it("shows New session and lists existing sessions from the bridge, with no mode picker yet", async () => {
    installBridge({
      listSessions: vi.fn().mockResolvedValue([
        { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "how is infy" },
      ]),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /new session/i })).toBeTruthy();
    expect(await screen.findByText("how is infy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /engine-only/i })).toBeNull();
  });

  it("shows the Login button after New session + mode, and no analysis form", async () => {
    installBridge();
    render(<App />);
    await startEngineOnlyChat();
    expect(await screen.findByRole("button", { name: /login to kite/i })).toBeTruthy();
    expect(screen.queryByLabelText(/instrument search/i)).toBeNull();
  });

  it("creates a session with the picked mode on New session", async () => {
    const bridge = installBridge();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    await waitFor(() => expect(bridge.createSession).toHaveBeenCalledWith("ai_assisted"));
  });

  it("gates the login button behind New session + mode picker, then reflects authenticated status", async () => {
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    expect(screen.queryByRole("button", { name: /login to kite/i })).toBeNull();
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite authenticated/i)).toBeTruthy();
  });

  it("clears the kiteLogin banner once login succeeds", async () => {
    let bannerHandler: ((banner: { kind: string; message: string }) => void) | undefined;
    const bridge = installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "needsLogin", driftWarning: null })
        .mockResolvedValueOnce({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      onBanner: vi.fn((handler) => {
        bannerHandler = handler;
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    await waitFor(() => expect(bannerHandler).toBeTruthy());

    bannerHandler?.({ kind: "kiteLogin", message: "Kite needs login today." });
    expect(await screen.findByText(/kite needs login today/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /login to kite/i }));
    await waitFor(() => expect(bridge.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/kite authenticated/i)).toBeTruthy();
    expect(screen.queryByText(/kite needs login today/i)).toBeNull();
  });

  it("runs an Engine-Only analysis with the session id and chosen intent lens", async () => {
    const bridge = installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockResolvedValue({
        mode: "engine_only",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
        horizon: "positional",
        response: { direction: "bullish", conviction: "high", text: "Overall read: bullish.", confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 } },
        algo_results: [],
      }),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.click(await screen.findByLabelText(/selling stance/i));
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    await waitFor(() =>
      expect(bridge.runAnalysis).toHaveBeenCalledWith({
        mode: "engine_only",
        sessionId: "session-1",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        horizon: "positional",
        intent_lens: "selling",
      }),
    );
  });

  it("shows an error message when analysis fails instead of failing silently", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      searchInstruments: vi.fn().mockResolvedValue({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
      runAnalysis: vi.fn().mockRejectedValue(new Error("sidecar unreachable")),
    });
    render(<App />);
    await startEngineOnlyChat();
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(await screen.findByText(/sidecar unreachable/)).toBeTruthy();
  });

  it("reopens an ai_assisted session, replays its transcript, and seeds the last-used lens", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      listSessions: vi.fn().mockResolvedValue([
        { id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" },
      ]),
      getSession: vi.fn().mockResolvedValue({
        id: "s7",
        response_mode: "ai_assisted",
        messages: [
          { role: "user", rendered_text: "prior ask", structured_payload: { mode: "ai_assisted", sessionId: "s7", query: "prior ask", intent_lens: "selling", requestId: "r0" }, created_at: "t0" },
          { role: "assistant", rendered_text: "prior reply", structured_payload: { mode: "ai_assisted" }, created_at: "t1" },
        ],
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    expect(await screen.findByText(/prior reply/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(/selling stance/i) as HTMLInputElement).checked).toBe(true));
  });

  it("continues a reopened ai_assisted session with the same session id", async () => {
    const runAnalysis = vi.fn().mockResolvedValue({
      mode: "ai_assisted",
      instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
      horizon: "positional",
      intent_lens: "selling",
      verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "x" },
      narrative: "fresh reply",
      algo_results: [],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
      runAnalysis,
      listSessions: vi.fn().mockResolvedValue([{ id: "s7", response_mode: "ai_assisted", created_at: "t", last_active_at: "t", preview: "prior ask" }]),
      getSession: vi.fn().mockResolvedValue({ id: "s7", response_mode: "ai_assisted", messages: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("prior ask"));
    fireEvent.change(await screen.findByLabelText(/ask about an instrument/i), { target: { value: "next turn" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(runAnalysis).toHaveBeenCalledTimes(1));
    expect((runAnalysis.mock.calls[0][0] as { sessionId: string }).sessionId).toBe("s7");
  });

  it("shows the AI-Assisted chat input after New session + AI-Assisted + login", async () => {
    installBridge({
      getStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /ai-assisted/i }));
    expect(await screen.findByLabelText(/ask about an instrument/i)).toBeTruthy();
  });
});
```

Note the "runs an Engine-Only analysis" test still uses `screen.getByLabelText(/positional/i)` for the horizon control — deliberately left as-is here; `InstrumentSearch` is not reskinned until Task 15, so its horizon control is still native radio inputs at this point in the plan, and Task 15 updates this exact line when it changes that markup.

- [ ] **Step 10: Run the full renderer suite**

Run: `npx vitest run test/renderer`
Expected: PASS — confirms `App.test.tsx`, `AppShell.test.tsx`, and `HistorySidebar.test.tsx` are all green and no other renderer test broke (in particular `ChatView.test.tsx`, which still renders `ChatView`'s own now-redundant theme toggle untouched until Task 16).

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/AppShell.tsx src/renderer/AppShell.css src/renderer/App.tsx src/renderer/ThemeToggle.css src/renderer/HistorySidebar.tsx test/renderer/AppShell.test.tsx test/renderer/App.test.tsx test/renderer/HistorySidebar.test.tsx
git rm src/renderer/HomeScreen.tsx test/renderer/HomeScreen.test.tsx
git commit -m "feat(electron-app): add AppShell and retire HomeScreen into the persistent sidebar"
```

---

### Task 13: Sidebar/history reskin — `HistorySidebar.tsx`

**Files:**
- Modify: `electron-app/src/renderer/HistorySidebar.tsx`
- Create: `electron-app/src/renderer/HistorySidebar.css`
- Modify: `electron-app/test/renderer/HistorySidebar.test.tsx`

**Interfaces:**
- Consumes: `Badge` (Task 6), `EmptyState` (Task 8), `Inbox` icon (Task 2). `HistorySidebarProps` already gained `activeSessionId: string | null` in Task 12 — this task is the one that makes it affect rendering.
- Produces: no signature change beyond what Task 12 already added. `AppShell.tsx` needs no edit for this task.

Data fetch/selection logic is untouched (P10§8) — this is a visual reskin only.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `electron-app/test/renderer/HistorySidebar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "../../src/renderer/HistorySidebar";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: new Date().toISOString(), preview: "how is infy" },
  { id: "s2", response_mode: "engine_only", created_at: "t", last_active_at: new Date().toISOString(), preview: "(no messages yet)" },
];

describe("HistorySidebar", () => {
  it("renders one row per session showing its preview and mode label", () => {
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={vi.fn()} />);
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("(no messages yet)")).toBeTruthy();
    expect(screen.getByText("AI-Assisted")).toBeTruthy();
    expect(screen.getByText("Engine-Only")).toBeTruthy();
  });

  it("calls onOpenSession with the session id when a row is clicked", () => {
    const onOpenSession = vi.fn();
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("marks the active session's row with the active class and leaves the rest unmarked", () => {
    render(<HistorySidebar sessions={sessions} activeSessionId="s2" onOpenSession={vi.fn()} />);
    expect(screen.getByRole("button", { name: /engine-only/i }).className).toContain("history-row-active");
    expect(screen.getByRole("button", { name: /ai-assisted/i }).className).not.toContain("history-row-active");
  });

  it("renders an EmptyState instead of a list when there are no sessions", () => {
    render(<HistorySidebar sessions={[]} activeSessionId={null} onOpenSession={vi.fn()} />);
    expect(screen.getByText("No sessions yet — start a new one.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/HistorySidebar.test.tsx`
Expected: FAIL — no mode-label text, no `history-row-active` class, no `EmptyState` yet.

- [ ] **Step 3: Implement**

Replace the whole contents of `electron-app/src/renderer/HistorySidebar.tsx`:

```tsx
import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import { Inbox } from "./ui/icons";
import "./HistorySidebar.css";
import type { AnalysisMode, SessionSummary } from "../main/ipc/rendererApi";

export interface HistorySidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
}

const MODE_LABEL: Record<AnalysisMode, string> = { ai_assisted: "AI-Assisted", engine_only: "Engine-Only" };

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function HistorySidebar({ sessions, activeSessionId, onOpenSession }: HistorySidebarProps): JSX.Element {
  if (sessions.length === 0) {
    return <EmptyState icon={Inbox} message="No sessions yet — start a new one." />;
  }
  return (
    <ul className="history-sidebar">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={`history-row${session.id === activeSessionId ? " history-row-active" : ""}`}
            onClick={() => onOpenSession(session.id)}
          >
            <Badge tone="neutral">{MODE_LABEL[session.response_mode]}</Badge>
            <span className="history-row-preview">{session.preview}</span>
            <span className="history-row-time">{relativeTime(session.last_active_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Create `electron-app/src/renderer/HistorySidebar.css`:

```css
.history-sidebar {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.history-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-elevated);
  border: none;
  border-left: 2px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
}

.history-row:hover {
  background: var(--bg-subtle);
}

.history-row-active {
  border-left-color: var(--accent);
  background: var(--bg-subtle);
}

.history-row-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}

.history-row-time {
  font-size: var(--text-xs);
  color: var(--neutral);
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/HistorySidebar.test.tsx test/renderer/AppShell.test.tsx test/renderer/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/HistorySidebar.tsx src/renderer/HistorySidebar.css test/renderer/HistorySidebar.test.tsx
git commit -m "feat(electron-app): reskin HistorySidebar onto Badge/EmptyState"
```

---

### Task 14: Mode picker reskin — `ModePicker.tsx`

**Files:**
- Modify: `electron-app/src/renderer/ModePicker.tsx`
- Create: `electron-app/src/renderer/ModePicker.css`
- Modify: `electron-app/test/renderer/ModePicker.test.tsx`

**Interfaces:**
- Consumes: `Card` (Task 5), `MessageSquare`/`Gauge` icons (Task 2).
- Produces: no signature change — `ModePickerProps { onSelect: (mode: AnalysisMode) => void }` stays identical; `App.tsx` (Task 12) needs no further edit.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("ModePicker", ...)` block in `electron-app/test/renderer/ModePicker.test.tsx` (keep the existing "offers both modes" test as-is — it still passes unchanged against the new markup since both cards remain `role="button"` elements whose accessible name still contains "AI-Assisted"/"Engine-Only"):

```tsx
  it("shows an icon on each card", () => {
    const { container } = render(<ModePicker onSelect={vi.fn()} />);
    expect(container.querySelectorAll(".mode-card-icon")).toHaveLength(2);
  });

  it("selects a card via the keyboard (Enter) as well as a click", () => {
    const onSelect = vi.fn();
    render(<ModePicker onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /engine-only/i }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("engine_only");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ModePicker.test.tsx`
Expected: FAIL — no `.mode-card-icon` elements yet, no keyboard handling yet.

- [ ] **Step 3: Implement**

Replace the whole contents of `electron-app/src/renderer/ModePicker.tsx`:

```tsx
import type { KeyboardEvent } from "react";
import { Card } from "./ui/Card";
import { Gauge, MessageSquare } from "./ui/icons";
import "./ModePicker.css";
import type { AnalysisMode } from "../main/ipc/rendererApi";

export interface ModePickerProps {
  onSelect: (mode: AnalysisMode) => void;
}

function selectOnKey(event: KeyboardEvent, select: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select();
  }
}

export function ModePicker({ onSelect }: ModePickerProps): JSX.Element {
  return (
    <section className="mode-picker">
      <h2 className="mode-picker-heading">Choose this session's mode</h2>
      <div className="mode-picker-cards">
        <Card
          interactive
          className="mode-card"
          role="button"
          tabIndex={0}
          onClick={() => onSelect("ai_assisted")}
          onKeyDown={(event) => selectOnKey(event, () => onSelect("ai_assisted"))}
        >
          <MessageSquare className="mode-card-icon" size={28} aria-hidden="true" />
          <h3>AI-Assisted</h3>
          <p>Full reasoning chat with live agent trace</p>
        </Card>
        <Card
          interactive
          className="mode-card"
          role="button"
          tabIndex={0}
          onClick={() => onSelect("engine_only")}
          onKeyDown={(event) => selectOnKey(event, () => onSelect("engine_only"))}
        >
          <Gauge className="mode-card-icon" size={28} aria-hidden="true" />
          <h3>Engine-Only</h3>
          <p>Deterministic instant verdict, no AI call</p>
        </Card>
      </div>
    </section>
  );
}
```

Create `electron-app/src/renderer/ModePicker.css`:

```css
.mode-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  align-items: center;
  padding: var(--space-6) 0;
}

.mode-picker-heading {
  font-size: var(--text-lg);
  font-weight: var(--font-weight-semibold);
}

.mode-picker-cards {
  display: flex;
  gap: var(--space-5);
  flex-wrap: wrap;
  justify-content: center;
}

.mode-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: 260px;
  text-align: center;
}

.mode-card-icon {
  color: var(--accent);
}

.mode-card h3 {
  margin: 0;
  font-size: var(--text-md);
}

.mode-card p {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg);
  opacity: 0.8;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/ModePicker.test.tsx`
Expected: PASS (all four cases green, including the two pre-existing ones).

- [ ] **Step 5: Full renderer regression**

Run: `npx vitest run test/renderer`
Expected: PASS — in particular `App.test.tsx`'s "creates a session with the picked mode" test still finds the `AI-Assisted` card via role/name.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/ModePicker.tsx src/renderer/ModePicker.css test/renderer/ModePicker.test.tsx
git commit -m "feat(electron-app): reskin ModePicker onto Card"
```

---

### Task 15: Engine-Only analysis reskin — `InstrumentSearch.tsx` + `AnalysisResult.tsx`

**Files:**
- Modify: `electron-app/src/renderer/InstrumentSearch.tsx`
- Create: `electron-app/src/renderer/InstrumentSearch.css`
- Modify: `electron-app/test/renderer/InstrumentSearch.test.tsx`
- Modify: `electron-app/src/renderer/AnalysisResult.tsx`
- Create: `electron-app/src/renderer/AnalysisResult.css`
- Modify: `electron-app/test/renderer/AnalysisResult.test.tsx`
- Modify: `electron-app/test/renderer/App.test.tsx` (one line)

**Interfaces:**
- Consumes: `TextField` (Task 4), `Button` (Task 3), `Banner` (Task 9), `Spinner` (Task 10), `Card` (Task 5), `Badge` (Task 6).
- Produces: `InstrumentSearchProps.onSubmit` widens from `(instrument, horizon) => void` to `(instrument, horizon) => void | Promise<void>` — a net-new loading state (P10§6.3: "there is no loading state on this action today; this phase adds one"), not a data-shape change (nothing crosses IPC differently; `App.tsx`'s `onAnalyze` already returns `Promise<void>` today, so it satisfies the widened type with **zero edit to `App.tsx` itself**). `AnalysisResultViewProps` is unchanged.

- [ ] **Step 1: Write the failing `InstrumentSearch` tests**

Replace the whole contents of `electron-app/test/renderer/InstrumentSearch.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentSearch, parseInstruments } from "../../src/renderer/InstrumentSearch";
import { installBridge } from "./testBridge";

afterEach(cleanup);

describe("parseInstruments", () => {
  it("maps the Kite search payload to InstrumentSelection[]", () => {
    const parsed = parseInstruments({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    });
    expect(parsed).toEqual([{ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }]);
  });

  it("returns [] for an unrecognized payload", () => {
    expect(parseInstruments({ nope: true })).toEqual([]);
  });

  it("unwraps an MCP CallToolResult content-array response", () => {
    const parsed = parseInstruments({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
          }),
        },
      ],
    });
    expect(parsed).toEqual([{ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }]);
  });

  it("drops a row missing instrument_token instead of returning an empty selectable instrument", () => {
    const parsed = parseInstruments({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE" }],
    });
    expect(parsed).toEqual([]);
  });

  it("ignores a null entry in the response array instead of throwing", () => {
    expect(() =>
      parseInstruments({
        data: [null, { tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
    ).not.toThrow();
  });
});

describe("InstrumentSearch", () => {
  it("debounces the query and lists results", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    expect(await screen.findByRole("button", { name: "NSE:INFY" })).toBeTruthy();
  });

  it("submits the selected instrument and chosen horizon", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    const onSubmit = vi.fn();
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /positional/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        "positional",
      ),
    );
  });

  it("shows an error banner when the search fails instead of failing silently", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });

    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("disables Analyze and shows a spinner while the submit promise is in flight, then re-enables it", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { resolveSubmit = resolve; }));
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(screen.getByRole("button", { name: /analyze/i })).toBeDisabled();
    resolveSubmit();
    await waitFor(() => expect(screen.getByRole("button", { name: /analyze/i })).not.toBeDisabled());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/InstrumentSearch.test.tsx`
Expected: FAIL — the horizon control is still a radio `<label>`, not a `role="button"`; the search error still renders as a plain div (no `role="alert"`); there is no in-flight/disabled state yet.

- [ ] **Step 3: Implement — `InstrumentSearch.tsx`**

Replace the whole contents of `electron-app/src/renderer/InstrumentSearch.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Horizon, InstrumentSelection } from "../main/ipc/rendererApi";
import { bridge } from "./bridge";
import { parseInstruments } from "./instrumentParsing";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import "./InstrumentSearch.css";

export { parseInstruments };

export interface InstrumentSearchProps {
  onSubmit: (instrument: InstrumentSelection, horizon: Horizon) => void | Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;
const HORIZON_LABEL: Record<Horizon, string> = { intraday: "Intraday", positional: "Positional" };
const HORIZONS: Horizon[] = ["intraday", "positional"];

export function InstrumentSearch({ onSubmit }: InstrumentSearchProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [selected, setSelected] = useState<InstrumentSelection | null>(null);
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    // A new query invalidates whatever was selected under the old one — the
    // Analyze button must never submit an instrument that no longer matches
    // what's on screen.
    setSelected(null);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchError(null);
      try {
        const parsed = parseInstruments(await bridge().searchInstruments(query));
        if (!cancelled) setResults(parsed);
      } catch (error) {
        if (!cancelled) setSearchError((error as Error).message);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const onAnalyzeClick = async (): Promise<void> => {
    if (!selected || running) return;
    setRunning(true);
    try {
      await onSubmit(selected, horizon);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="analysis-form">
      <TextField
        variant="search"
        aria-label="instrument search"
        placeholder="Search instrument"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searchError && <Banner variant="error">{searchError}</Banner>}
      {results.length > 0 && (
        <ul className="instrument-results">
          {results.map((instrument) => (
            <li key={instrument.instrumentToken}>
              <button
                type="button"
                className={`instrument-result${selected?.instrumentToken === instrument.instrumentToken ? " instrument-result-selected" : ""}`}
                onClick={() => setSelected(instrument)}
              >
                {instrument.symbol}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="horizon-toggle" role="group" aria-label="Horizon">
        {HORIZONS.map((value) => (
          <Button
            key={value}
            variant={horizon === value ? "primary" : "secondary"}
            size="sm"
            aria-pressed={horizon === value}
            onClick={() => setHorizon(value)}
          >
            {HORIZON_LABEL[value]}
          </Button>
        ))}
      </div>
      <Button disabled={!selected || running} onClick={() => void onAnalyzeClick()}>
        {running && <Spinner size={14} />} Analyze {selected ? selected.symbol : ""}
      </Button>
    </section>
  );
}
```

Create `electron-app/src/renderer/InstrumentSearch.css`:

```css
.analysis-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 480px;
}

.instrument-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  padding: var(--space-2);
}

.instrument-result {
  width: 100%;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--fg);
  cursor: pointer;
}

.instrument-result:hover {
  background: var(--bg-subtle);
}

.instrument-result-selected {
  background: var(--bg-subtle);
  font-weight: var(--font-weight-semibold);
}

.horizon-toggle {
  display: inline-flex;
  gap: var(--space-1);
}
```

- [ ] **Step 4: Run the `InstrumentSearch` tests to verify they pass**

Run: `npx vitest run test/renderer/InstrumentSearch.test.tsx`
Expected: PASS (all eight cases green).

- [ ] **Step 5: Fix the one horizon-toggle line in `App.test.tsx`**

In `electron-app/test/renderer/App.test.tsx`, in the "runs an Engine-Only analysis" test, replace:

```tsx
    fireEvent.click(screen.getByLabelText(/positional/i));
```

with:

```tsx
    fireEvent.click(screen.getByRole("button", { name: /positional/i }));
```

- [ ] **Step 6: Write the failing `AnalysisResultView` tests**

Replace the whole contents of `electron-app/test/renderer/AnalysisResult.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisResultView } from "../../src/renderer/AnalysisResult";
import type { AnalysisResult, HistoryMessage } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const result: AnalysisResult = {
  mode: "engine_only",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon: "positional",
  response: {
    direction: "bullish",
    conviction: "high",
    text: "Overall read: bullish (high conviction).\nConfluence: 4 bullish / 1 bearish / 0 neutral, weighted vote +0.62.",
    confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
  },
  algo_results: [],
};

describe("AnalysisResultView", () => {
  it("renders the prose through the markdown pipeline inside a Card", async () => {
    const { container } = render(<AnalysisResultView result={result} />);
    expect(await screen.findByText(/Overall read: bullish/)).toBeTruthy();
    expect(container.querySelector(".card")).toBeTruthy();
    expect(screen.queryByText(/Past turns in this session/i)).toBeNull();
  });

  it("renders the confluence counts as a Badge row using the direction/status tone palette", () => {
    render(<AnalysisResultView result={result} />);
    expect(screen.getByText(/bullish · high/i)).toBeTruthy();
    expect(screen.getByText(/4 bullish/)).toBeTruthy();
    expect(screen.getByText(/1 bearish/)).toBeTruthy();
    expect(screen.getByText(/0 neutral/)).toBeTruthy();
    expect(screen.getByText(/weighted vote 0\.62/)).toBeTruthy();
  });

  it("renders prior turns in a collapsible list when history is supplied", async () => {
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier question", structured_payload: null, created_at: "t0" },
      { role: "assistant", rendered_text: "earlier answer", structured_payload: null, created_at: "t1" },
    ];
    render(<AnalysisResultView result={result} history={history} />);
    expect(screen.getByText(/Past turns in this session/i)).toBeTruthy();
    expect(await screen.findByText(/earlier question/)).toBeTruthy();
    expect(await screen.findByText(/earlier answer/)).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run test/renderer/AnalysisResult.test.tsx`
Expected: FAIL — the current markup has no `.card` wrapper and renders confluence as a bare `<dl>`, not the new Badge-row text.

- [ ] **Step 8: Implement — `AnalysisResult.tsx`**

Replace the whole contents of `electron-app/src/renderer/AnalysisResult.tsx`:

```tsx
import type { AnalysisResult, HistoryMessage } from "../main/ipc/rendererApi";
import { MessageMarkdown } from "./MessageMarkdown";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import type { BadgeTone } from "./ui/Badge";
import "./AnalysisResult.css";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
  history?: HistoryMessage[];
}

// Matches the precision the prose paragraph renders at (see
// deterministicResponseGenerator.ts's formatVote) so the stat tile can never
// show raw floating-point noise (e.g. 0.6200000000000001) next to prose that
// reads a clean "+0.62".
function formatWeightedVote(vote: number): string {
  return vote.toFixed(2);
}

function directionTone(direction: string): BadgeTone {
  if (direction === "bullish") return "bullish";
  if (direction === "bearish") return "bearish";
  return "neutral";
}

export function AnalysisResultView({ result, history = [] }: AnalysisResultViewProps): JSX.Element | null {
  if (result.mode !== "engine_only") return null;
  const { response } = result;

  return (
    <Card className="analysis-result">
      {history.length > 0 && (
        <details className="session-history">
          <summary>Past turns in this session</summary>
          <ul>
            {history.map((message, index) => (
              <li key={index} className={`message message-${message.role}`}>
                <MessageMarkdown text={message.rendered_text} />
              </li>
            ))}
          </ul>
        </details>
      )}
      <MessageMarkdown text={response.text} />
      <div className="confluence">
        <Badge tone={directionTone(response.direction)}>
          {response.direction} · {response.conviction}
        </Badge>
        <Badge tone="bullish">{response.confluence.bullish_count} bullish</Badge>
        <Badge tone="bearish">{response.confluence.bearish_count} bearish</Badge>
        <Badge tone="neutral">{response.confluence.neutral_count} neutral</Badge>
        <span className="confluence-vote">weighted vote {formatWeightedVote(response.confluence.weighted_vote)}</span>
      </div>
    </Card>
  );
}
```

Create `electron-app/src/renderer/AnalysisResult.css`:

```css
.analysis-result {
  margin-top: var(--space-5);
  max-width: 640px;
}

.session-history {
  margin-bottom: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}

.confluence {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.confluence-vote {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-sm);
  color: var(--fg);
  opacity: 0.8;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/renderer/AnalysisResult.test.tsx`
Expected: PASS (all three cases green).

- [ ] **Step 10: Full renderer regression**

Run: `npx vitest run test/renderer`
Expected: PASS — in particular `App.test.tsx`'s Engine-Only run test (Step 5's fix) and search-failure test.

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/InstrumentSearch.tsx src/renderer/InstrumentSearch.css src/renderer/AnalysisResult.tsx src/renderer/AnalysisResult.css test/renderer/InstrumentSearch.test.tsx test/renderer/AnalysisResult.test.tsx test/renderer/App.test.tsx
git commit -m "feat(electron-app): reskin Engine-Only analysis onto TextField/Button/Card/Badge"
```

---

### Task 16: AI-Assisted chat refinement — `ChatView.tsx`, `AgentActivityPanel.tsx`, `TraceStepRow.tsx`

**Files:**
- Modify: `electron-app/src/renderer/ChatView.tsx`
- Modify: `electron-app/src/renderer/ChatView.css`
- Delete: `electron-app/src/renderer/theme.css`
- Modify: `electron-app/test/renderer/ChatView.test.tsx`
- Modify: `electron-app/src/renderer/AgentActivityPanel.tsx`
- Modify: `electron-app/src/renderer/AgentActivityPanel.css`
- Modify: `electron-app/test/renderer/AgentActivityPanel.test.tsx`
- Modify: `electron-app/src/renderer/TraceStepRow.tsx`
- Modify: `electron-app/src/renderer/TraceStepRow.css`
- Modify: `electron-app/test/renderer/TraceStepRow.test.tsx`

**Interfaces:**
- Consumes: `TextField` (Task 4), `Button` (Task 3), `Badge` (Task 6), `Banner` (Task 9), `StatusDot` (Task 7), `Send`/`ChevronDown`/`ChevronRight` icons (Task 2).
- Produces: no change to `ChatViewProps`, `historyToChatMessages`, `AgentActivityPanelProps`, `TraceStepRowProps`, `buildLanes`, `LaneNode`/`ChildNode`/`NodeStatus` — every exported name/signature these files already had is unchanged; only internal rendering (theme ownership, icon source, message-surface styling) changes. `App.tsx` needs no edit.

This is the task P10§6.4 calls "refinement, not rebuild": `ChatView` stops owning theme state (the double-toggle staged state from Task 12 is resolved here), and the trace panel's status/caret glyphs move onto the shared primitives — the auto-expand/collapse/stay-expanded-on-error *behavior* (P9B§8.2–§8.4) is untouched.

- [ ] **Step 1: Write the failing `ChatView` test**

Replace the whole contents of `electron-app/test/renderer/ChatView.test.tsx` — identical to today's file except the last test in the `describe("ChatView", ...)` block (`"wires the theme toggle onto the chat-view root..."`) is deleted, since `ChatView` no longer owns theme state or renders its own toggle:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView, historyToChatMessages } from "../../src/renderer/ChatView";
import { installBridge } from "./testBridge";
import type { HistoryMessage, TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("ChatView", () => {
  it("submits an ai_assisted run with the session id, lens and a requestId, then streams narrative tokens", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    const bridge = installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "Infy ", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "constructive.", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "done", at: "t" });
        return {
          mode: "ai_assisted",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
          horizon: "positional",
          intent_lens: "buying",
          verdict: { direction: "bullish", conviction: "high", reasoning: "rsi", cited_algo_ids: ["rsi"], verify_before_acting: "check LTP" },
          narrative: "Infy constructive.",
          algo_results: [],
          confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
        };
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "how is infy" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(bridge.runAnalysis).toHaveBeenCalledTimes(1));
    const params = (bridge.runAnalysis as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      mode: string;
      sessionId: string;
      query: string;
      intent_lens: string;
      requestId: string;
    };
    expect(params).toMatchObject({ mode: "ai_assisted", sessionId: "sess-9", query: "how is infy", intent_lens: "buying" });
    expect(typeof params.requestId).toBe("string");
    expect(await screen.findByText(/Infy constructive\./)).toBeTruthy();
    expect(await screen.findByText(/bullish/i)).toBeTruthy();
  });

  it("ignores trace events for a stale requestId and never folds non-token events into the bubble text", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: "stale-request", source: "narrative", kind: "token", detail: "SHOULD NOT APPEAR", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        traceHandler?.({ requestId: params.requestId, source: "narrative", kind: "token", detail: "real text", at: "t" });
        // Never resolves: this test only inspects the bubble text streamed before completion.
        return new Promise(() => {});
      }),
    });

    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("real text")).toBeTruthy();
    expect(screen.queryByText(/SHOULD NOT APPEAR/)).toBeNull();
  });

  it("seeds its transcript from initialMessages so a reopened session shows prior turns", () => {
    installBridge();
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier ask", structured_payload: null, trace: null, created_at: "t0" },
      {
        role: "assistant",
        rendered_text: "earlier reply",
        structured_payload: { mode: "ai_assisted", verdict: { direction: "bearish", conviction: "low", reasoning: "x", cited_algo_ids: ["rsi"], verify_before_acting: "y" } },
        trace: null,
        created_at: "t1",
      },
    ];
    render(<ChatView intentLens="selling" sessionId="sess-9" initialMessages={historyToChatMessages(history)} />);
    expect(screen.getByText(/earlier ask/)).toBeTruthy();
    expect(screen.getByText(/earlier reply/)).toBeTruthy();
    expect(screen.getByText(/bearish/i)).toBeTruthy();
  });

  it("shows an error banner when the run rejects", async () => {
    installBridge({ runAnalysis: vi.fn().mockRejectedValue(new Error("claude down")) });
    render(<ChatView intentLens="selling" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/claude down/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders an Agent Activity panel once trace events arrive, live and open by default", async () => {
    let traceHandler: ((event: TraceEvent) => void) | undefined;
    installBridge({
      onTrace: vi.fn((handler) => {
        traceHandler = handler as (event: TraceEvent) => void;
      }),
      runAnalysis: vi.fn(async (params) => {
        if (params.mode !== "ai_assisted") throw new Error("mode");
        traceHandler?.({ requestId: params.requestId, source: "intake", kind: "started", at: "t" });
        // Never resolves: only the live trace panel is under test here.
        return new Promise(() => {});
      }),
    });
    render(<ChatView intentLens="buying" sessionId="sess-9" />);
    fireEvent.change(screen.getByLabelText(/ask about an instrument/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("Agent activity")).toBeTruthy();
    expect(await screen.findByText("Intake")).toBeTruthy();
  });
});

describe("historyToChatMessages", () => {
  it("maps a null trace to an empty array and marks replayed assistant turns live: false", () => {
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace: null, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ role: "assistant", trace: [], live: false });
  });

  it("carries a persisted trace array through onto the reconstructed assistant message", () => {
    const trace: TraceEvent[] = [{ requestId: "r0", source: "intake", kind: "started", at: "t0" }];
    const history: HistoryMessage[] = [
      { role: "assistant", rendered_text: "reply", structured_payload: null, trace, created_at: "t0" },
    ];
    const [message] = historyToChatMessages(history);
    expect(message).toMatchObject({ trace, live: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/ChatView.test.tsx`
Expected: FAIL — `ChatView`'s error still renders as a plain `<div className="error">`, not a `role="alert"` `Banner`.

- [ ] **Step 3: Implement — `ChatView.tsx`**

Replace the whole contents of `electron-app/src/renderer/ChatView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import { AgentActivityPanel } from "./AgentActivityPanel";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import type { BadgeTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Send } from "./ui/icons";
import "./ChatView.css";
import type { AnalysisResult, HistoryMessage, IntentLens, TraceEvent, Verdict } from "../main/ipc/rendererApi";

export interface ChatViewProps {
  intentLens: IntentLens;
  sessionId: string;
  initialMessages?: ChatMessage[];
}

interface AssistantMessage {
  role: "assistant";
  requestId: string;
  text: string;
  verdict?: Verdict;
  trace: TraceEvent[];
  live: boolean;
}

interface UserMessage {
  role: "user";
  text: string;
}

type ChatMessage = UserMessage | AssistantMessage;

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function directionTone(direction: string): BadgeTone {
  if (direction === "bullish") return "bullish";
  if (direction === "bearish") return "bearish";
  return "neutral";
}

export function historyToChatMessages(messages: HistoryMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", text: message.rendered_text };
    const payload = message.structured_payload as AnalysisResult | null;
    const verdict = payload && payload.mode === "ai_assisted" ? payload.verdict : undefined;
    return {
      role: "assistant",
      requestId: newRequestId(),
      text: message.rendered_text,
      verdict,
      trace: message.trace ?? [],
      live: false,
    };
  });
}

export function ChatView({ intentLens, sessionId, initialMessages }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    bridge().onTrace((event: TraceEvent) => {
      if (event.requestId !== activeRequestId.current) return;
      const isNarrativeToken = event.source === "narrative" && event.kind === "token";
      setMessages((prev) =>
        prev.map((message) =>
          message.role === "assistant" && message.requestId === event.requestId
            ? {
                ...message,
                text: isNarrativeToken ? message.text + (event.detail ?? "") : message.text,
                trace: isNarrativeToken ? message.trace : [...message.trace, event],
              }
            : message,
        ),
      );
    });
  }, []);

  const onSend = async (): Promise<void> => {
    const query = input.trim();
    if (query.length === 0 || busy) return;
    const requestId = newRequestId();
    activeRequestId.current = requestId;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text: query },
      { role: "assistant", requestId, text: "", trace: [], live: true },
    ]);
    try {
      const result = await bridge().runAnalysis({ mode: "ai_assisted", sessionId, query, intent_lens: intentLens, requestId });
      if (result.mode === "ai_assisted") {
        setMessages((prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.requestId === requestId
              ? { ...message, text: result.narrative, verdict: result.verdict }
              : message,
          ),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat-view">
      <ul className="messages">
        {messages.map((message, index) => (
          <li key={index} className={`message message-${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.trace.length > 0 && <AgentActivityPanel trace={message.trace} live={message.live} />}
                {message.verdict && (
                  <Badge tone={directionTone(message.verdict.direction)} className="verdict">
                    {message.verdict.direction} · {message.verdict.conviction} conviction
                  </Badge>
                )}
                <MessageMarkdown text={message.text} />
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </li>
        ))}
      </ul>
      {error && <Banner variant="error">{error}</Banner>}
      <div className="chat-input">
        <TextField
          aria-label="ask about an instrument"
          placeholder="Ask about an instrument…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button onClick={() => void onSend()} disabled={busy}>
          {busy ? (
            "Analyzing…"
          ) : (
            <>
              <Send size={14} aria-hidden="true" /> Send
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
```

`ChatView` no longer imports `ThemeToggle`/`useChatTheme`/`theme.css`, no longer renders a toggle, and no longer sets `data-theme` — the app root's `data-theme` (set by `AppShell`, Task 12) now governs this subtree's tokens purely through CSS cascade.

Replace the whole contents of `electron-app/src/renderer/ChatView.css` (drops the input/button overrides now owned by the `TextField`/`Button` primitives, and the outer box chrome that only existed because `ChatView` used to be its own themed island):

```css
.chat-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.message {
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}

.message-user {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
  max-width: 80%;
}

.message-assistant {
  align-self: flex-start;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  max-width: 90%;
}

.verdict {
  margin-bottom: var(--space-2);
}

.chat-input {
  display: flex;
  gap: var(--space-2);
}
```

Delete `theme.css` (its values already live in `tokens.css`, Task 1):

```bash
git rm src/renderer/theme.css
```

- [ ] **Step 4: Run the `ChatView` test to verify it passes**

Run: `npx vitest run test/renderer/ChatView.test.tsx`
Expected: PASS (all six cases green).

- [ ] **Step 5: Write the failing `AgentActivityPanel`/`TraceStepRow` tests**

Replace the whole contents of `electron-app/test/renderer/AgentActivityPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActivityPanel } from "../../src/renderer/AgentActivityPanel";
import type { TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

describe("AgentActivityPanel", () => {
  it("renders nothing for an empty trace (engine_only turns carry none)", () => {
    const { container } = render(<AgentActivityPanel trace={[]} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a trace containing only narrative tokens", () => {
    const trace: TraceEvent[] = [{ requestId: "r1", source: "narrative", kind: "token", detail: "hi", at: "t" }];
    const { container } = render(<AgentActivityPanel trace={trace} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens by default while live and renders one lane per started source", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    const { container } = render(<AgentActivityPanel trace={trace} live={true} />);
    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.getByText("Intake")).toBeTruthy();
    expect(container.querySelector(".agent-activity-lanes")).toBeTruthy();
  });

  it("collapses by default on history replay (live=false) and expands on click", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    render(<AgentActivityPanel trace={trace} live={false} />);
    expect(screen.queryByText("Intake")).toBeNull();
    fireEvent.click(screen.getByText("Agent activity"));
    expect(screen.getByText("Intake")).toBeTruthy();
  });

  it("re-renders correctly when trace transitions from empty to populated", () => {
    const emptyTrace: TraceEvent[] = [];
    const { container, rerender } = render(<AgentActivityPanel trace={emptyTrace} live={true} />);
    expect(container.firstChild).toBeNull();

    const populatedTrace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    rerender(<AgentActivityPanel trace={populatedTrace} live={true} />);

    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.getByText("Intake")).toBeTruthy();
  });
});
```

Replace the whole contents of `electron-app/test/renderer/TraceStepRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceStepRow } from "../../src/renderer/TraceStepRow";
import type { LaneNode } from "../../src/renderer/AgentActivityPanel";

afterEach(cleanup);

function lane(status: LaneNode["status"], children: LaneNode["children"] = []): LaneNode {
  return { kind: "lane", source: "intake", label: "Intake", status, children };
}

describe("TraceStepRow", () => {
  it("auto-expands a running row and shows its children while live", () => {
    const node = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { container } = render(<TraceStepRow node={node} live={true} />);
    expect(container.querySelector(".status-dot-running")).toBeTruthy();
    expect(screen.getByText("Read {}")).toBeTruthy();
    expect(container.querySelector(".trace-step-caret")).toBeTruthy();
  });

  it("auto-collapses a done row while live", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { container } = render(<TraceStepRow node={node} live={true} />);
    expect(container.querySelector(".status-dot-done")).toBeTruthy();
    expect(screen.queryByText("Read {}")).toBeNull();
  });

  it("stays expanded on error while live", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    const { container } = render(<TraceStepRow node={node} live={true} />);
    expect(container.querySelector(".status-dot-error")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("lets a manual expand override auto-collapse on a done row, and the override persists across a same-status re-render", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={node} live={true} />);
    expect(screen.queryByText("Read {}")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Read {}")).toBeTruthy();
    rerender(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();
  });

  it("reverts a manual collapse back to auto-expand when a running row transitions to error", () => {
    const runningNode = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={runningNode} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();

    fireEvent.click(screen.getByRole("button")); // manual collapse while running
    expect(screen.queryByText("Read {}")).toBeNull();

    const erroredNode = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    rerender(<TraceStepRow node={erroredNode} live={true} />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("auto-collapses when a running row transitions to done", () => {
    const runningNode = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { container, rerender } = render(<TraceStepRow node={runningNode} live={true} />);
    expect(container.querySelector(".status-dot-running")).toBeTruthy();
    expect(screen.getByText("Read {}")).toBeTruthy();

    const doneNode = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    rerender(<TraceStepRow node={doneNode} live={true} />);
    expect(container.querySelector(".status-dot-done")).toBeTruthy();
    expect(screen.queryByText("Read {}")).toBeNull();
  });

  it("renders every row collapsed by default in history replay (live=false), even an errored one, until manually toggled", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    render(<TraceStepRow node={node} live={false} />);
    expect(screen.queryByText("boom")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("disables the toggle button and shows no caret for a childless algo leaf", () => {
    const node = { kind: "algo" as const, label: "rsi", status: "done" as const };
    const { container } = render(<TraceStepRow node={node} live={false} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".trace-step-caret")).toBeNull();
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/AgentActivityPanel.test.tsx test/renderer/TraceStepRow.test.tsx`
Expected: FAIL — no `.agent-activity-lanes`/`.status-dot-*`/`.trace-step-caret` classes exist in the current markup yet.

- [ ] **Step 7: Implement — `AgentActivityPanel.tsx`, `TraceStepRow.tsx`**

In `electron-app/src/renderer/AgentActivityPanel.tsx`, change only the top import block and the component's caret rendering — `buildLanes`, `LANE_ORDER`, `LANE_LABEL`, and every type stay byte-identical:

```tsx
import { useState } from "react";
import "./AgentActivityPanel.css";
import { TraceStepRow } from "./TraceStepRow";
import { ChevronDown, ChevronRight } from "./ui/icons";
import type { TraceEvent, TraceSource } from "../main/ipc/rendererApi";
```

```tsx
export function AgentActivityPanel({ trace, live }: AgentActivityPanelProps): JSX.Element | null {
  const [open, setOpen] = useState(live); // card open while streaming, collapsed on replay
  const lanes = buildLanes(trace);
  if (lanes.length === 0) return null; // engine_only / token-only turns show no panel

  return (
    <div className="agent-activity">
      <button type="button" className="agent-activity-head" onClick={() => setOpen((v) => !v)}>
        {open ? (
          <ChevronDown size={14} className="agent-activity-caret" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} className="agent-activity-caret" aria-hidden="true" />
        )}
        Agent activity
      </button>
      {open && (
        <div className="agent-activity-lanes">
          {lanes.map((lane) => (
            <TraceStepRow key={lane.source} node={lane} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}
```

Replace the whole contents of `electron-app/src/renderer/AgentActivityPanel.css`:

```css
.agent-activity {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-2);
  background: var(--code-bg);
}

.agent-activity-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-semibold);
  text-align: left;
  cursor: pointer;
}

.agent-activity-caret {
  opacity: 0.7;
  flex-shrink: 0;
}

.agent-activity-lanes {
  border-top: 1px solid var(--border);
  padding: var(--space-1) 0;
}
```

Replace the whole contents of `electron-app/src/renderer/TraceStepRow.tsx`:

```tsx
import { useEffect, useState } from "react";
import "./TraceStepRow.css";
import { StatusDot } from "./ui/StatusDot";
import { ChevronDown, ChevronRight } from "./ui/icons";
import type { ChildNode, LaneNode } from "./AgentActivityPanel";

type BracketNode = LaneNode | Extract<ChildNode, { kind: "algo" }>;

export interface TraceStepRowProps {
  node: BracketNode;
  live: boolean;
}

export function TraceStepRow({ node, live }: TraceStepRowProps): JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null);
  // A manual toggle owns the row until its status next transitions; on any status
  // change (running → done/error) auto-behavior takes back over. In practice a row's
  // status never transitions after a terminal event, so a manual toggle on a
  // done/error row persists for the rest of that row's life.
  useEffect(() => setOverride(null), [node.status]);

  const hasChildren = node.kind === "lane" && node.children.length > 0;
  const auto = live && (node.status === "running" || node.status === "error");
  const expanded = override ?? auto;

  return (
    <div className={`trace-step trace-step-${node.status}`}>
      <button
        type="button"
        className="trace-step-head"
        onClick={() => hasChildren && setOverride(!expanded)}
        disabled={!hasChildren}
      >
        <StatusDot tone={node.status} label={node.label} />
        {hasChildren &&
          (expanded ? (
            <ChevronDown size={12} className="trace-step-caret" aria-hidden="true" />
          ) : (
            <ChevronRight size={12} className="trace-step-caret" aria-hidden="true" />
          ))}
      </button>
      {node.kind === "lane" && expanded && node.children.length > 0 && (
        <div className="trace-step-children">
          {node.children.map((child, i) =>
            child.kind === "tool" ? (
              <ToolLeafRow key={i} variant={child.variant} detail={child.detail} />
            ) : (
              <TraceStepRow key={i} node={child} live={live} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolLeafRow({ variant, detail }: { variant: "toolCall" | "toolResult"; detail: string }): JSX.Element {
  return (
    <div className={`trace-tool trace-tool-${variant}`}>
      <code className="trace-tool-detail">{detail}</code>
    </div>
  );
}
```

(`NodeStatus` is no longer imported here — `StatusDot`'s `tone` prop accepts `node.status` directly since `StatusDotTone` and `NodeStatus` are the same three-value union by construction; nothing else in this file needs the type name itself.)

Replace the whole contents of `electron-app/src/renderer/TraceStepRow.css`:

```css
.trace-step {
  font-size: var(--text-sm);
  color: var(--fg);
}

.trace-step-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.trace-step-head:disabled {
  cursor: default;
}

.trace-step-caret {
  opacity: 0.7;
  flex-shrink: 0;
}

.trace-step-children {
  margin-left: var(--space-5);
  border-left: 1px solid var(--border);
  padding-left: var(--space-2);
}

.trace-tool {
  padding: var(--space-1) var(--space-2);
}

.trace-tool-detail {
  display: block;
  background: var(--code-bg);
  color: var(--fg);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/renderer/AgentActivityPanel.test.tsx test/renderer/AgentActivityPanel.buildLanes.test.ts test/renderer/TraceStepRow.test.tsx test/renderer/ChatView.test.tsx`
Expected: PASS — `AgentActivityPanel.buildLanes.test.ts` (Task 3's pure-builder tests) is included here specifically to confirm this task's edits to the same source file left `buildLanes`/`LANE_ORDER` untouched.

- [ ] **Step 9: Full renderer regression**

Run: `npx vitest run test/renderer`
Expected: PASS.

- [ ] **Step 10: Confirm the settings entry still pulls in none of this**

Run: `grep -n "ChatView\|AgentActivityPanel\|TraceStepRow\|ThemeToggle\|theme.css\|ChatView.css" src/renderer/settingsMain.tsx src/renderer/SettingsWindow.tsx`
Expected: no output — unchanged from P9B§4.4's original guarantee.

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/ChatView.tsx src/renderer/ChatView.css src/renderer/AgentActivityPanel.tsx src/renderer/AgentActivityPanel.css src/renderer/TraceStepRow.tsx src/renderer/TraceStepRow.css test/renderer/ChatView.test.tsx test/renderer/AgentActivityPanel.test.tsx test/renderer/TraceStepRow.test.tsx
git rm src/renderer/theme.css
git commit -m "refactor(electron-app): promote ChatView onto app-wide tokens and shared primitives"
```

---

### Task 17: Benchmark reskin — `BenchmarkView.tsx` + `benchmarkChart.ts`

**Files:**
- Modify: `electron-app/src/renderer/BenchmarkView.tsx`
- Create: `electron-app/src/renderer/BenchmarkView.css`
- Modify: `electron-app/test/renderer/BenchmarkView.test.tsx`
- Modify: `electron-app/src/renderer/benchmarkChart.ts`
- Modify: `electron-app/test/renderer/benchmarkChart.test.ts`

**Interfaces:**
- Consumes: `Card` (Task 5), `Badge` (Task 6), `Button` (Task 3), `TextField` (Task 4), `EmptyState` (Task 8), `Banner` (Task 9), `Spinner` (Task 10), `BarChart3`/`Copy` icons (Task 2).
- Produces: `BenchmarkView`'s and `benchmarkChart.ts`'s exported signatures (`BenchmarkView({ api })`, `createBenchmarkChart(container, result, onSelect)`, `BenchmarkChartHandle`) are unchanged. The only behavioral change is `createBenchmarkChart` reading marker color from `getComputedStyle(container)` instead of a hardcoded map — the chart-rendering logic itself (candles, volume, click-to-select) is untouched (P10§6.5: "this phase does not touch chart rendering logic").

- [ ] **Step 1: Write the failing `benchmarkChart` test**

Replace the whole contents of `electron-app/test/renderer/benchmarkChart.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { createSeriesMarkers, remove, addSeries, subscribeClick } = vi.hoisted(() => ({
  createSeriesMarkers: vi.fn(),
  remove: vi.fn(),
  addSeries: vi.fn(() => ({ setData: vi.fn() })),
  subscribeClick: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => ({ addSeries, subscribeClick, remove })),
  CandlestickSeries: "Candlestick",
  HistogramSeries: "Histogram",
  createSeriesMarkers,
}));

import { createBenchmarkChart } from "../../src/renderer/benchmarkChart";
import type { BenchmarkResult } from "../../src/main/ipc/rendererApi";

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>): BenchmarkResult {
  return {
    params: {
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
      fromTs: 0,
      toTs: 0,
    },
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    decisionPoints: outcomes.map((outcome, i) => ({
      frontierIndex: i,
      ts: i + 1,
      closeAtFrontier: 1,
      closeAtLookahead: 1,
      realizedReturn: 0,
      direction: outcome === "incorrect" ? "bearish" : "bullish",
      conviction: "medium",
      responseText: "",
      algoResults: [],
      confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
      outcome,
    })),
  };
}

function containerWithTokens(): HTMLElement {
  const container = document.createElement("div");
  container.style.setProperty("--bullish", "#16a34a");
  container.style.setProperty("--bearish", "#dc2626");
  container.style.setProperty("--neutral", "#6b7280");
  document.body.appendChild(container);
  return container;
}

describe("createBenchmarkChart", () => {
  it("reads each marker's color from the container's --bullish/--bearish/--neutral custom properties", () => {
    createSeriesMarkers.mockClear();
    const container = containerWithTokens();
    createBenchmarkChart(container, resultWith(["correct", "incorrect", "neutral"]), () => {});
    const markers = createSeriesMarkers.mock.calls[0][1] as Array<{ color: string }>;
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.color)).toEqual(["#16a34a", "#dc2626", "#6b7280"]);
  });

  it("dispose() removes the chart", () => {
    remove.mockClear();
    const container = containerWithTokens();
    const handle = createBenchmarkChart(container, resultWith([]), () => {});
    handle.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/benchmarkChart.test.ts`
Expected: FAIL — the current implementation still returns the hardcoded `#26a69a`/`#ef5350`/`#9e9e9e` hex codes, not the container's custom-property values.

- [ ] **Step 3: Implement — `benchmarkChart.ts`**

Replace the whole contents of `electron-app/src/renderer/benchmarkChart.ts`:

```typescript
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BenchmarkResult, DecisionPoint, Outcome } from "../main/ipc/rendererApi";
import type { CandleWire } from "../main/services/sidecar/sidecarProtocol";

const OUTCOME_TOKEN: Record<Outcome, string> = {
  correct: "--bullish",
  incorrect: "--bearish",
  neutral: "--neutral",
};

export interface BenchmarkChartHandle {
  dispose(): void;
}

export function createBenchmarkChart(
  container: HTMLElement,
  result: BenchmarkResult,
  onSelect: (point: DecisionPoint | null) => void,
): BenchmarkChartHandle {
  const chart = createChart(container, { autoSize: true });

  const candleSeries = chart.addSeries(CandlestickSeries);
  candleSeries.setData(
    result.candles.map((c: CandleWire) => ({
      time: c.ts as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );

  const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "volume" });
  volumeSeries.setData(result.candles.map((c: CandleWire) => ({ time: c.ts as UTCTimestamp, value: c.volume })));

  // Canvas fillStyle needs a resolved color, not a var() reference — reading the
  // computed style off the chart's own container is what lets a marker's color
  // track the app's current theme (P10§3.1's unified bullish/bearish/neutral palette)
  // instead of a palette hardcoded independently of tokens.css.
  const outcomeColor = (outcome: Outcome): string =>
    getComputedStyle(container).getPropertyValue(OUTCOME_TOKEN[outcome]).trim();

  function markerFor(point: DecisionPoint): SeriesMarker<Time> {
    const bullish = point.direction === "bullish";
    const bearish = point.direction === "bearish";
    return {
      time: point.ts as UTCTimestamp,
      position: bullish ? "belowBar" : bearish ? "aboveBar" : "inBar",
      color: outcomeColor(point.outcome),
      shape: bullish ? "arrowUp" : bearish ? "arrowDown" : "circle",
    };
  }

  createSeriesMarkers(candleSeries, result.decisionPoints.map(markerFor));

  const byTime = new Map<number, DecisionPoint>(result.decisionPoints.map((p) => [p.ts, p]));
  chart.subscribeClick((param) => {
    const time = param.time as number | undefined;
    onSelect(time === undefined ? null : byTime.get(time) ?? null);
  });

  return {
    dispose(): void {
      chart.remove();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/benchmarkChart.test.ts`
Expected: PASS (both cases green).

- [ ] **Step 5: Write the failing `BenchmarkView` tests**

Add these two tests to `electron-app/test/renderer/BenchmarkView.test.tsx`'s existing `describe("BenchmarkView", ...)` block (keep every existing test — they all still pass unchanged against the new markup, since none of them asserted on the removed native `<fieldset>`/checkbox structure):

```tsx
  it("shows a loading spinner while the lake list is in flight", () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn(() => new Promise(() => {})) })} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("switches to the manual every-N field only after the Manual segment is selected", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    expect(screen.queryByLabelText(/every n bars/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /manual every-n override/i }));
    expect(screen.getByLabelText(/every n bars/i)).toBeTruthy();
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/BenchmarkView.test.tsx`
Expected: FAIL — no `role="status"` loading indicator yet, no manual/auto segmented control yet.

- [ ] **Step 7: Implement — `BenchmarkView.tsx`**

Replace the whole contents of `electron-app/src/renderer/BenchmarkView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { createBenchmarkChart } from "./benchmarkChart";
import { defaultCadenceForHorizon, defaultLookaheadForHorizon, summarize } from "../main/services/benchmark/benchmarkRunner";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { EmptyState } from "./ui/EmptyState";
import { Banner } from "./ui/Banner";
import { Spinner } from "./ui/Spinner";
import { BarChart3, Copy } from "./ui/icons";
import "./BenchmarkView.css";
import type { BenchmarkCadence, BenchmarkResult, DecisionPoint, LakeSymbolEntry, RendererApi } from "../main/ipc/rendererApi";

type BenchmarkApi = Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">;

function toDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fromDate(value: string): number {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
}

function SummaryStrip({ points }: { points: DecisionPoint[] }): JSX.Element {
  const { correct, incorrect, neutral, hitRate } = summarize(points);
  if (points.length === 0) {
    return <Card className="benchmark-summary">0 decision points — nothing to score.</Card>;
  }
  const hitRateLabel = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
  return (
    <Card className="benchmark-summary">
      <Badge tone="bullish">{correct} correct</Badge>
      <Badge tone="bearish">{incorrect} incorrect</Badge>
      <Badge tone="neutral">{neutral} neutral</Badge>
      <span className="benchmark-summary-hitrate">hit-rate {hitRateLabel}</span>
    </Card>
  );
}

function ResultsView({ api, result }: { api: BenchmarkApi; result: BenchmarkResult }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<DecisionPoint | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;
    const handle = createBenchmarkChart(container, result, setSelected);
    return () => handle.dispose();
  }, [result]);

  return (
    <div className="benchmark-results">
      <SummaryStrip points={result.decisionPoints} />
      <Button variant="ghost" onClick={() => void api.copyBenchmarkResult(JSON.stringify(result))}>
        <Copy size={14} aria-hidden="true" /> Copy raw result
      </Button>
      <div className="benchmark-chart" ref={chartRef} />
      {selected && (
        <Card className="benchmark-popover">
          <h3>
            {selected.direction} ({selected.conviction} conviction) — {selected.outcome}
          </h3>
          <p>
            {selected.closeAtFrontier} → {selected.closeAtLookahead} ({(selected.realizedReturn * 100).toFixed(2)}%)
          </p>
          <p>algos: {selected.algoResults.map((r) => r.algo_id).join(", ")}</p>
          <MessageMarkdown text={selected.responseText} />
        </Card>
      )}
    </div>
  );
}

export function BenchmarkView({ api }: { api: BenchmarkApi }): JSX.Element {
  const [entries, setEntries] = useState<LakeSymbolEntry[] | null>(null);
  const [selected, setSelected] = useState<LakeSymbolEntry | null>(null);
  const [cadence, setCadence] = useState<BenchmarkCadence>({ mode: "session_close" });
  const [manual, setManual] = useState(false);
  const [everyN, setEveryN] = useState(5);
  const [lookaheadBars, setLookaheadBars] = useState(5);
  const [fromTs, setFromTs] = useState(0);
  const [toTs, setToTs] = useState(0);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listLakeSymbols().then(setEntries);
  }, [api]);

  const onSelectEntry = (entry: LakeSymbolEntry): void => {
    setSelected(entry);
    setManual(false);
    setCadence(defaultCadenceForHorizon(entry.horizon));
    setLookaheadBars(defaultLookaheadForHorizon(entry.horizon));
    setFromTs(entry.fromTs);
    setToTs(entry.toTs);
    setResult(null);
  };

  const onToggleManual = (checked: boolean): void => {
    setManual(checked);
    if (!selected) return;
    setCadence(checked ? { mode: "manual", everyN } : defaultCadenceForHorizon(selected.horizon));
  };

  const onRun = async (): Promise<void> => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const effectiveCadence: BenchmarkCadence = manual ? { mode: "manual", everyN } : cadence;
      const run = await api.runBenchmark({
        symbol: selected.symbol,
        timeframe: selected.timeframe,
        source: selected.source,
        horizon: selected.horizon,
        cadence: effectiveCadence,
        lookaheadBars,
        fromTs,
        toTs,
      });
      setResult(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (entries === null) {
    return (
      <div className="benchmark-loading">
        <Spinner /> Loading lake…
      </div>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={BarChart3} message="No data ingested yet — run the `ingest` CLI (see the Phase 6 design, P6§3)." />;
  }
  if (result) return <ResultsView api={api} result={result} />;

  return (
    <div className="benchmark">
      <h2>Benchmark</h2>
      <ul className="benchmark-picker">
        {entries.map((entry) => (
          <li key={`${entry.symbol}_${entry.timeframe}_${entry.source}`}>
            <button type="button" className="benchmark-picker-item" onClick={() => onSelectEntry(entry)}>
              {entry.symbol} · {entry.timeframe} · {entry.source} · {entry.horizon} · {toDate(entry.fromTs)}–{toDate(entry.toTs)} · {entry.candleCount} bars
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <Card>
          <form
            className="benchmark-setup"
            onSubmit={(event) => {
              event.preventDefault();
              void onRun();
            }}
          >
            <p>
              Horizon: <strong>{selected.horizon}</strong> (derived from timeframe)
            </p>
            <p>
              Cadence: <strong>{manual ? "manual" : cadence.mode}</strong>
            </p>
            <div className="segmented-control" role="group" aria-label="Cadence mode">
              <Button type="button" variant={!manual ? "primary" : "secondary"} size="sm" aria-pressed={!manual} onClick={() => onToggleManual(false)}>
                Auto
              </Button>
              <Button type="button" variant={manual ? "primary" : "secondary"} size="sm" aria-pressed={manual} onClick={() => onToggleManual(true)}>
                Manual every-N override
              </Button>
            </div>
            {manual && (
              <label className="benchmark-field">
                Every N bars
                <TextField type="number" min={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} />
              </label>
            )}
            <label className="benchmark-field">
              Lookahead bars
              <TextField type="number" min={1} value={lookaheadBars} onChange={(e) => setLookaheadBars(Number(e.target.value))} />
            </label>
            <label className="benchmark-field">
              From
              <TextField type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(fromTs)} onChange={(e) => setFromTs(fromDate(e.target.value))} />
            </label>
            <label className="benchmark-field">
              To
              <TextField type="date" min={toDate(selected.fromTs)} max={toDate(selected.toTs)} value={toDate(toTs)} onChange={(e) => setToTs(fromDate(e.target.value))} />
            </label>
            <Button type="submit" disabled={running}>
              {running && <Spinner size={14} />} {running ? "Running…" : "Run benchmark"}
            </Button>
            {error && <Banner variant="error">{error}</Banner>}
          </form>
        </Card>
      )}
    </div>
  );
}
```

Create `electron-app/src/renderer/BenchmarkView.css`:

```css
.benchmark {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 640px;
}

.benchmark-loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6);
}

.benchmark-picker {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.benchmark-picker-item {
  width: 100%;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-elevated);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--fg);
  cursor: pointer;
}

.benchmark-picker-item:hover {
  background: var(--bg-subtle);
}

.benchmark-setup {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.benchmark-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.segmented-control {
  display: inline-flex;
  gap: var(--space-1);
}

.benchmark-results {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.benchmark-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.benchmark-summary-hitrate {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-sm);
  opacity: 0.8;
}

.benchmark-chart {
  height: 360px;
}

.benchmark-popover {
  box-shadow: var(--shadow-md);
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/renderer/BenchmarkView.test.tsx`
Expected: PASS (all eight cases green — six pre-existing plus the two new ones).

- [ ] **Step 9: Full renderer regression**

Run: `npx vitest run test/renderer`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/BenchmarkView.tsx src/renderer/BenchmarkView.css src/renderer/benchmarkChart.ts test/renderer/BenchmarkView.test.tsx test/renderer/benchmarkChart.test.ts
git commit -m "feat(electron-app): reskin BenchmarkView onto Card/Badge/EmptyState and unify marker colors with tokens"
```

---

### Task 18: Settings reskin — `SettingsWindow.tsx`

**Files:**
- Modify: `electron-app/src/renderer/SettingsWindow.tsx`
- Create: `electron-app/src/renderer/SettingsWindow.css`
- Modify: `electron-app/test/renderer/SettingsWindow.test.tsx`

**Interfaces:**
- Consumes: `Card` (Task 5), `Switch` (Task 11), `TextField` (Task 4), `Button` (Task 3), `Badge` (Task 6, via its `onRemove`/`removeLabel` props), `StatusDot` (Task 7), `Banner` (Task 9).
- Produces: no change to `SettingsWindow`'s exported signature (still a zero-prop component) or to `settingsBridge`/`SettingsApi` — structurally untouched per P10§4.5/§6.6 (own window, own preload, own IPC surface, unchanged).

- [ ] **Step 1: Write the failing tests**

Replace the whole contents of `electron-app/test/renderer/SettingsWindow.test.tsx` — identical to today's file except the two watchlist-removal tests are updated for the new icon-only remove button (no more visible "Remove" text; the button is found by its `aria-label`):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsWindow } from "../../src/renderer/SettingsWindow";
import type { SettingsApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

function installSettingsBridge(overrides: Partial<SettingsApi> = {}): SettingsApi {
  const api: SettingsApi = {
    getScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    setScanConfig: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 15 }),
    listWatchlist: vi.fn().mockResolvedValue([]),
    addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]),
    removeWatchlistSymbol: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ sidecar: "up", kiteSession: "authenticated", driftWarning: null }),
    searchInstruments: vi.fn().mockResolvedValue({ data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }] }),
    ...overrides,
  };
  (window as unknown as { tradeAssistantSettings: SettingsApi }).tradeAssistantSettings = api;
  return api;
}

describe("SettingsWindow", () => {
  it("toggling the scan checkbox calls setScanConfig with the flipped enabled", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const checkbox = await screen.findByLabelText(/enable proactive scanning/i);
    fireEvent.click(checkbox);
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 15 });
  });

  it("changing the interval select calls setScanConfig with the new intervalMinutes", async () => {
    const api = installSettingsBridge();
    render(<SettingsWindow />);
    const select = await screen.findByLabelText(/scan interval/i);
    fireEvent.change(select, { target: { value: "30" } });
    expect(api.setScanConfig).toHaveBeenCalledWith({ enabled: false, intervalMinutes: 30 });
  });

  it("typing a query searches and renders results; clicking Add re-renders the watchlist from the returned array", async () => {
    const api = installSettingsBridge({ addWatchlistSymbol: vi.fn().mockResolvedValue(["NSE:INFY"]) });
    render(<SettingsWindow />);
    fireEvent.change(await screen.findByLabelText(/instrument search/i), { target: { value: "infy" } });
    const addButton = await screen.findByText("Add NSE:INFY");
    fireEvent.click(addButton);
    expect(api.addWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
    await waitFor(() => expect(screen.getByRole("button", { name: /remove nse:infy/i })).toBeTruthy());
  });

  it("clicking the remove control on a watchlist chip calls removeWatchlistSymbol", async () => {
    const api = installSettingsBridge({ listWatchlist: vi.fn().mockResolvedValue(["NSE:INFY"]), removeWatchlistSymbol: vi.fn().mockResolvedValue([]) });
    render(<SettingsWindow />);
    const removeButton = await screen.findByRole("button", { name: /remove nse:infy/i });
    fireEvent.click(removeButton);
    expect(api.removeWatchlistSymbol).toHaveBeenCalledWith("NSE:INFY");
  });

  it("renders the account status fields from getAccountStatus", async () => {
    installSettingsBridge();
    render(<SettingsWindow />);
    expect(await screen.findByText(/Sidecar: up/)).toBeTruthy();
    expect(await screen.findByText(/Kite session: authenticated/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/renderer/SettingsWindow.test.tsx`
Expected: FAIL — the current markup renders a visible "Remove" text button, not an `aria-label`d icon button; `screen.getByRole("button", { name: /remove nse:infy/i })` finds nothing yet.

- [ ] **Step 3: Implement**

Replace the whole contents of `electron-app/src/renderer/SettingsWindow.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { AppStatus, InstrumentSelection, KiteSessionStatus, ScanConfig, ScanIntervalMinutes, SidecarStatus } from "../main/ipc/rendererApi";
import { settingsBridge } from "./settingsBridge";
import { parseInstruments } from "./instrumentParsing";
import { Card } from "./ui/Card";
import { Switch } from "./ui/Switch";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { StatusDot } from "./ui/StatusDot";
import type { StatusDotTone } from "./ui/StatusDot";
import { Banner } from "./ui/Banner";
import "./SettingsWindow.css";

const INTERVAL_OPTIONS: ScanIntervalMinutes[] = [5, 15, 30, 60];
const SEARCH_DEBOUNCE_MS = 300;

function sidecarTone(status: SidecarStatus | undefined): StatusDotTone {
  if (status === "up") return "done";
  if (status === "restarting") return "running";
  return "error";
}

function kiteTone(status: KiteSessionStatus | undefined): StatusDotTone {
  if (status === "authenticated") return "done";
  if (status === "needsLogin") return "running";
  return "error";
}

export function SettingsWindow(): JSX.Element {
  const [config, setConfig] = useState<ScanConfig>({ enabled: false, intervalMinutes: 15 });
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSelection[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);

  useEffect(() => {
    void settingsBridge().getScanConfig().then(setConfig);
    void settingsBridge().listWatchlist().then(setWatchlist);
    void settingsBridge().getAccountStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const parsed = parseInstruments(await settingsBridge().searchInstruments(query));
      if (!cancelled) setResults(parsed);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const applyConfig = async (next: ScanConfig): Promise<void> => {
    setConfig(next);
    await settingsBridge().setScanConfig(next);
  };

  return (
    <section className="settings">
      <Card className="settings-section">
        <h3>Proactive scanning</h3>
        <Switch
          checked={config.enabled}
          onChange={(checked) => void applyConfig({ ...config, enabled: checked })}
          label="Enable proactive scanning"
        />
        <label className="settings-field">
          Interval
          <select
            aria-label="scan interval"
            value={config.intervalMinutes}
            onChange={(event) => void applyConfig({ ...config, intervalMinutes: Number(event.target.value) as ScanIntervalMinutes })}
          >
            {INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
      </Card>

      <Card className="settings-section">
        <h3>Watchlist</h3>
        <TextField
          variant="search"
          aria-label="instrument search"
          placeholder="Search instrument"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {results.length > 0 && (
          <ul className="results">
            {results.map((instrument) => (
              <li key={instrument.instrumentToken}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => setWatchlist(await settingsBridge().addWatchlistSymbol(instrument.symbol))}
                >
                  Add {instrument.symbol}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="watchlist">
          {watchlist.map((symbol) => (
            <Badge
              key={symbol}
              tone="neutral"
              onRemove={async () => setWatchlist(await settingsBridge().removeWatchlistSymbol(symbol))}
              removeLabel={`Remove ${symbol}`}
            >
              {symbol}
            </Badge>
          ))}
        </div>
      </Card>

      <Card className="settings-section">
        <h3>Account status</h3>
        <StatusDot tone={sidecarTone(status?.sidecar)} label={`Sidecar: ${status?.sidecar ?? "…"}`} />
        <StatusDot tone={kiteTone(status?.kiteSession)} label={`Kite session: ${status?.kiteSession ?? "…"}`} />
        {status?.driftWarning && <Banner variant="warning">{status.driftWarning}</Banner>}
      </Card>
    </section>
  );
}
```

Create `electron-app/src/renderer/SettingsWindow.css`:

```css
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  max-width: 420px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.settings-section h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--font-weight-semibold);
}

.settings-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.settings-field select {
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
}

.watchlist {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/renderer/SettingsWindow.test.tsx`
Expected: PASS (all five cases green).

- [ ] **Step 5: Full renderer regression**

Run: `npx vitest run test/renderer`
Expected: PASS.

- [ ] **Step 6: Confirm the settings entry's own preload/IPC surface is untouched**

Run: `git diff --stat main -- src/main/ipc/settingsBridge.ts src/main/ipc/settingsApi.ts src/main/ipc/settingsPreload.ts src/main/settingsWindow.ts`
Expected: no output — this task edits only `src/renderer/SettingsWindow.tsx`/`.css`; every Settings-side main-process file stays byte-identical (P10§4.5/§6.6).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/SettingsWindow.tsx src/renderer/SettingsWindow.css test/renderer/SettingsWindow.test.tsx
git commit -m "feat(electron-app): reskin SettingsWindow onto Card/Switch/StatusDot/Badge"
```

---

### Task 19: Final integration and safety-regression gate

**Files:** none created or modified by default — this task is a verification gate, mirroring P9B's own final task. If any check below fails, fix the specific file it points to and commit that fix on its own (e.g. `fix(electron-app): ...`) before re-running the gate; do not fold an unrelated fix into this task's (absent) commit.

**Interfaces:** none — this task consumes the finished state of Tasks 1–18 and asserts on the whole tree.

- [ ] **Step 1: Grep-confirm zero IPC/main-process footprint**

Run: `git diff --stat main -- src/main/`
Expected: no output — every task in this plan (1 through 18) touches only `src/renderer/**` and `test/renderer/**`; `src/main/**` is byte-identical to `main`, confirming P10§7.1/§2/§8's repeated non-goal held for the entire plan, not just individual tasks.

- [ ] **Step 2: Grep-confirm no other package was added**

Run: `git diff main -- package.json`
Expected: exactly one line added under `dependencies` (`lucide-react`, Task 2) — no other dependency, no devDependency change, no Tailwind/CSS-in-JS/headless-component-library package.

- [ ] **Step 3: Grep-confirm `theme.css`/`HomeScreen.tsx` are fully retired**

Run: `grep -rn "theme.css\|HomeScreen" src/ test/`
Expected: no output — confirms Task 12 removed every `HomeScreen` reference and Task 16 removed every `theme.css` reference (import or file).

- [ ] **Step 4: Grep-confirm every primitive has its own render test**

Run: `ls test/renderer/ui/`
Expected: `Badge.test.tsx  Banner.test.tsx  Button.test.tsx  Card.test.tsx  EmptyState.test.tsx  Spinner.test.tsx  StatusDot.test.tsx  Switch.test.tsx  TextField.test.tsx` — one test file per primitive (P10§7.3's requirement), `icons.ts` excluded since it is a pure re-export with no render logic of its own.

- [ ] **Step 5: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no errors across `src/**`.

- [ ] **Step 6: Full test suite**

Run: `npx vitest run`
Expected: PASS — every test file in `electron-app/test/**` (main and renderer) is green. In particular:

Run: `npx vitest run test/main`
Expected: PASS, unchanged — no `src/main/**` file changed in this entire plan, so the main-process suite (IPC bridges, history store, sidecar, Kite client) is unaffected by construction, not merely by re-running it.

- [ ] **Step 7: Manual smoke check of the app shell (optional but recommended before merging)**

Run: `npm run dev` from `electron-app/`, then in the launched window:
- Confirm the sidebar (brand, "New session" button, history list, footer status/theme toggle) renders on every screen (welcome, mode picker, Engine-Only, chat, benchmark).
- Toggle the theme in the sidebar footer and confirm every visible surface (sidebar, content pane, chat bubbles, badges) flips together — this is the one thing no automated test in this plan can fully verify, since jsdom doesn't apply real CSS cascade/paint.
- Open Settings from the tray menu (unchanged entry point, see Global Constraints) and confirm it now renders with the same token palette as the main window.

- [ ] **Step 8: Report**

No commit for this task if all eight steps above pass clean (nothing changed). If a fix was required at any step, it was already committed on its own in that step per this task's file note above.

---

## Self-review notes (fixed inline before finalizing)

- **Spec coverage check (P10§2 items 1–5 against tasks):** tokens (Task 1) → primitives (Tasks 2–11) → app shell (Task 12) → per-screen reskins in the locked order sidebar/history (13) → mode picker (14) → engine-only (15) → chat (16) → benchmark (17) → settings (18) → testing extensions, folded into Task 1's `styleCssSplit.test.ts` extension plus Task 19's final gate. Every P10§5 primitive (§5.1–§5.10) has its own task. Every P10§6 subsection (§6.1–§6.6) has its own task. P10§7.1 (no data-flow changes) and P10§7.2 (the two Banner categories) are covered across Tasks 12 (existing app-wide banners) and 15/17 (new inline failure banners). No spec section was left without an owning task.
- **The AppShell ↔ primitives ordering** (P10§2 item 2 lists `AppShell` before item 3's primitive library, but locked decision 1 says primitives come before any screen reskin) is resolved by placing `AppShell` (Task 12) *after* every primitive (Tasks 3–11), not between tokens and primitives — `AppShell` itself consumes `Button`/`StatusDot`/`EmptyState`/`Banner` directly (P10§4.2/§4.4), so it cannot be built before they exist; this plan follows the *locked decision*, treating P10§2's bullet-list numbering as a table of contents, not a strict build sequence.
- **The Settings "sidebar button" vs. the phase's absolute IPC non-goal** (P10§4.5 vs. P10§7.1/§2/§8) is resolved in Global Constraints by leaning on the thrice-repeated, more emphatic non-goal: no task adds an IPC channel to open the Settings window from the sidebar; the tray remains the sole entry point, and Task 18 restyles only `SettingsWindow.tsx`'s internals.
- **`IntentLensSelector.tsx`** is confirmed out of scope by its absence from every P10§1/P10§6 mention (verified by grep) and is untouched by every task.
- **The temporary double-theme-toggle window between Task 12 and Task 16** (`AppShell` gains its own `useChatTheme`/`ThemeToggle` while `ChatView` still owns its pre-existing copy) is named explicitly in Task 12's notes so a reviewer evaluating that task alone doesn't mistake it for an oversight — Task 16 is where P10§6.4 assigns the actual removal.
- **`Badge`'s `"neutral"` tone as the generic/default chip color** (sidebar mode tags, Settings watchlist chips) is justified directly from P10§5.4's own use-site list, which names both of those alongside genuinely directional uses (chat verdict, confluence stats, benchmark summary) — confirming `"neutral"` is this system's default tone for non-directional labels, not an invented option.
- **Type consistency check:** `StatusDotTone` (Task 7) and `NodeStatus` (already existing in `AgentActivityPanel.tsx`) are the same three-value union (`"running" | "done" | "error"`) by construction; Task 16's `TraceStepRow` passes `node.status` (a `NodeStatus`) directly into `StatusDot`'s `tone: StatusDotTone` prop with no adapter needed — verified structurally identical, not just similarly named. `BadgeTone` (Task 6) and the `directionTone()` helper duplicated in Task 15 (`AnalysisResultView`) and Task 16 (`ChatView`) both return the same three-value subset (`"bullish" | "bearish" | "neutral"`) for the same reason `AnalysisResultView` and `ChatView` are separate files with no shared parent component to hang a common helper off of without inventing a new shared module outside this plan's file list.
- **No task deletes or narrows any existing IPC-adjacent type.** `HistorySidebarProps` gained a field (Task 12/13); `InstrumentSearchProps.onSubmit` widened its return type (Task 15) — both are backward-compatible renderer-only prop changes, not `rendererApi.ts` changes, consistent with P10§7.1.
- **No Rust-side or `rust-core/` task exists in this plan** — confirmed against P10§1: this phase is pure renderer/presentation work, matching P9B's own equivalent note.
