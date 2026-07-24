# Phase 4 — Claude AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-3 `claude` CLI scaffolding into a working AI reasoning layer — a live `AnalysisEnvelope` assembly path (fetch → compute → envelope) feeding a four-stage persona pipeline (three parallel analytical personas → one synthesis persona) that emits a descriptive, evidence-cited `Verdict`.

**Architecture:** A new `services/analysis/` domain owns the `AnalysisEnvelope`/`Verdict`/`PersonaFinding` contract types and the `assembleEnvelope()` composer. `services/claude/` gains a `Provider` interface, a `ClaudeCliProvider` that supplies a real subprocess persona-runner, and a pure `personaPipeline.ts` orchestrator (fan-out to three analytical personas, fan-in to synthesis) over an injectable runner. Every `claude` call reuses the Phase-3 safety scaffolding (`buildClaudeArgs`/`spawnClaude`) so the allowlist/denylist is never bypassed. The Rust sidecar wire protocol is widened so the full `AlgoOutput` reaches TypeScript, and two Phase-3 bugs whose first real caller is this phase are fixed.

**Tech Stack:** Rust (serde/serde_json/chrono, `cargo test`); TypeScript on Electron main (Node child_process, `zod` for structured-output validation, Vitest 2.1.8, `electron-vite`).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the Phase 4 design spec (`docs/superpowers/specs/2026-07-24-phase4-claude-integration-design.md`) and the master design doc (`docs/superpowers/specs/2026-07-18-trade-assistant-design.md`).

- **The app never places, modifies, cancels, or automates any order, ever.** No code path may reach `place_order`, `modify_order`, `cancel_order`, `place_gtt_order`, `modify_gtt_order`, `delete_gtt_order`. (Master §2, §4 — non-negotiable, permanent.)
- **Verdict/persona wording:** `direction` is `"bullish" | "bearish" | "neutral"` only — never `buy`/`sell`/`hold`/`add`/`watch` or any imperative trade directive. Free-text fields describe; they never instruct an action. (P4§8.)
- **Every `claude` subprocess call MUST go through `buildClaudeArgs`/`spawnClaude` in `claudeProvider.ts`.** The three safety flags (`--allowedTools <read-allowlist>`, `--disallowedTools <write-denylist>`, `--strict-mcp-config`) are emitted unconditionally, always first. No new subprocess-arg-construction path may bypass the allowlist/denylist. (P4§7.7, master §4 layer 2.)
- **TypeScript naming:** camelCase functions/variables, PascalCase types/classes, no Hungarian notation. File names describe responsibility, not file kind. Wire-mirror interfaces keep snake_case field names to match the bytes (existing convention in `sidecarProtocol.ts`).
- **Rust naming:** snake_case functions/variables, PascalCase types, one clear responsibility per file.
- **Comments:** default none; add one only when the *why* is non-obvious (invariant, upstream-bug workaround, formula source). Never restate the next line. Never a numbered "1. do X, 2. do Y" step block above a function.
- **Pure logic separate from I/O.** Orchestration/validation logic is unit-testable without a subprocess; subprocess spawning is injected.
- **Commits:** authored `hadetan <aquibsyed83@gmail.com>` (already the repo git config — do not pass `--author`). No `Co-Authored-By` trailer. Never `--no-verify`.
- **TDD per task:** write a real failing test first, watch it fail, then write the minimal implementation.
- **No new behavior beyond the design spec.** This is the spec's implementation, not a place to add scope.

**Grounding note (read before Task 5):** the spec (P4§7.4) says `zod` is "already a dependency" — it is **not** in `electron-app/package.json`. The plan adds it as a real dependency in Task 5. This is the only deviation forced by the real code, and it honors the spec's explicit choice of validator rather than substituting a different mechanism.

---

## File Structure

New / changed files (from P4§12, grounded against the real tree):

**Rust (`rust-core/crates/sidecar/`):**
- `src/protocol.rs` — widen `AlgoResultWire` to all nine `AlgoOutput` fields (Task 1).
- `src/handlers.rs` — populate the five new fields; add `timeframe_to_wire`/`horizon_to_wire` helpers (Task 1).
- `tests/protocol_test.rs` — assert the widened encode (Task 1).

**TypeScript (`electron-app/src/main/services/`):**
- `sidecar/sidecarProtocol.ts` — mirror the widened `AlgoResultWire` (Task 2).
- `sidecar/sidecarSupervisor.ts` — per-request timeout (Task 3).
- `kite/historicalDataArchive.ts` — surface a persist failure (Task 4).
- `analysis/contracts.ts` — `AnalysisEnvelope`, `Verdict`, `PersonaFinding` types + zod schemas + JSON-schema objects (Task 5, new).
- `analysis/analysisEnvelope.ts` — `assembleEnvelope()` (Task 6, new).
- `claude/claudeProvider.ts` — extend `buildClaudeArgs`/`spawnClaude` with persona options (Task 7).
- `claude/provider.ts` — `Provider` interface (Task 8, new).
- `claude/claudeCliProvider.ts` — real persona-runner + `ClaudeCliProvider implements Provider` (Tasks 8 & 11, new).
- `claude/systemPrompts/{wordingConstraint,optionsGreeks,technicalQuant,positionRisk,synthesis}.ts` — persona prompts + schemas (Task 9, new).
- `claude/personaPipeline.ts` — pure fan-out/fan-in orchestration (Task 10, new).

**Tests (`electron-app/test/main/services/`):** mirror the source tree under `{sidecar,kite,analysis,claude}/`.

---

## Task 1: Widen the Rust sidecar wire protocol

**Files:**
- Modify: `rust-core/crates/sidecar/src/protocol.rs` (struct `AlgoResultWire`, lines 11-17)
- Modify: `rust-core/crates/sidecar/src/handlers.rs` (the `AlgoResultWire` mapping, lines 35-43; add two helpers)
- Test: `rust-core/crates/sidecar/tests/protocol_test.rs` (extend `response_encodes_to_a_single_json_line`, lines 20-43) and the inline `#[cfg(test)] mod tests` in `handlers.rs`

**Interfaces:**
- Consumes: `algo_core::{AlgoOutput, Direction, Horizon, Timeframe}` (re-exported from `algo-core/src/lib.rs`). Real `AlgoOutput` fields: `algo_id: &'static str`, `symbol: String`, `timeframe: Timeframe`, `horizon: Horizon`, `direction: Direction`, `magnitude: f64`, `confidence: f64`, `evidence: Vec<String>`, `computed_at: DateTime<Utc>`.
- Produces: widened `AlgoResultWire { algo_id, symbol, timeframe, horizon, direction, magnitude, confidence, evidence, computed_at }` — all `String`/`f64`/`Vec<String>` on the wire. This is the shape Task 2 mirrors in TS.

- [ ] **Step 1: Extend the Rust encode test to assert the five new fields**

In `rust-core/crates/sidecar/tests/protocol_test.rs`, replace the body of `response_encodes_to_a_single_json_line` (lines 20-43) with the widened construction and assertions:

```rust
#[test]
fn response_encodes_to_a_single_json_line() {
    let response = SidecarResponse::Compute(ComputeResponse {
        id: 1,
        algo_results: vec![AlgoResultWire {
            algo_id: "sma".to_string(),
            symbol: "NSE:INFY".to_string(),
            timeframe: "day".to_string(),
            horizon: "positional".to_string(),
            direction: "Bullish".to_string(),
            magnitude: 0.0123,
            confidence: 0.5,
            evidence: vec!["close above SMA".to_string()],
            computed_at: "2026-07-24T00:00:00+00:00".to_string(),
        }],
        confluence: ConfluenceWire {
            bullish_count: 1,
            bearish_count: 0,
            neutral_count: 0,
            weighted_vote: 1.0,
        },
    });

    let line = encode_response(&response);

    assert!(!line.contains('\n'));
    assert!(line.contains("\"id\":1"));
    assert!(line.contains("\"algo_id\":\"sma\""));
    assert!(line.contains("\"symbol\":\"NSE:INFY\""));
    assert!(line.contains("\"timeframe\":\"day\""));
    assert!(line.contains("\"horizon\":\"positional\""));
    assert!(line.contains("\"magnitude\":0.0123"));
    assert!(line.contains("\"computed_at\":\"2026-07-24T00:00:00+00:00\""));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust-core && cargo test -p sidecar --test protocol_test response_encodes_to_a_single_json_line`
Expected: FAIL to compile — `AlgoResultWire` has no field `symbol` (missing fields `symbol`, `timeframe`, `horizon`, `magnitude`, `computed_at`).

- [ ] **Step 3: Widen `AlgoResultWire` in `protocol.rs`**

Replace the struct at `rust-core/crates/sidecar/src/protocol.rs` lines 11-17 with:

```rust
#[derive(Debug, Serialize)]
pub struct AlgoResultWire {
    pub algo_id: String,
    pub symbol: String,
    pub timeframe: String,
    pub horizon: String,
    pub direction: String,
    pub magnitude: f64,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub computed_at: String,
}
```

- [ ] **Step 4: Populate the five new fields in `handlers.rs`**

In `rust-core/crates/sidecar/src/handlers.rs`, add two enum→wire-string helpers above `handle_request` (after the `use` block, before line 9). `Timeframe` maps to the same interval strings `handle_request` already parses; `Horizon` maps to `"intraday"`/`"positional"`:

```rust
fn timeframe_to_wire(timeframe: Timeframe) -> &'static str {
    match timeframe {
        Timeframe::Minute => "minute",
        Timeframe::FiveMinute => "5minute",
        Timeframe::FifteenMinute => "15minute",
        Timeframe::Day => "day",
    }
}

fn horizon_to_wire(horizon: Horizon) -> &'static str {
    match horizon {
        Horizon::Intraday => "intraday",
        Horizon::Positional => "positional",
    }
}
```

Then replace the `.map(...)` closure at lines 37-42 with the full mapping (`direction` keeps the existing `{:?}` Debug spelling; the TS layer lowercases only its own persona output, never these raw wire values):

```rust
        .map(|output| AlgoResultWire {
            algo_id: output.algo_id.to_string(),
            symbol: output.symbol.clone(),
            timeframe: timeframe_to_wire(output.timeframe).to_string(),
            horizon: horizon_to_wire(output.horizon).to_string(),
            direction: format!("{:?}", output.direction),
            magnitude: output.magnitude,
            confidence: output.confidence,
            evidence: output.evidence.clone(),
            computed_at: output.computed_at.to_rfc3339(),
        })
```

- [ ] **Step 5: Add a behavior-level assertion to the `handlers.rs` inline tests**

In `rust-core/crates/sidecar/src/handlers.rs`, add this test inside the existing `#[cfg(test)] mod tests` block (after `sufficient_closes_runs_every_algorithm_applicable_at_that_lookback`, around line 137). It proves the new fields carry real values from `handle_request`:

```rust
    #[test]
    fn widened_algo_result_carries_symbol_timeframe_horizon_and_rfc3339_timestamp() {
        let response = handle_request(request(3, closes_seq(21)));
        let first = response
            .algo_results
            .first()
            .expect("21 closes runs several algorithms");

        assert_eq!(first.symbol, "NSE:NEWLISTING");
        assert_eq!(first.timeframe, "day");
        // handle_request pins Horizon::Positional for the whole request today.
        assert_eq!(first.horizon, "positional");
        assert!(first.computed_at.contains('T'));
    }
```

- [ ] **Step 6: Run the sidecar test suite to verify everything passes**

Run: `cd rust-core && cargo test -p sidecar`
Expected: PASS — `response_encodes_to_a_single_json_line`, `widened_algo_result_carries_symbol_timeframe_horizon_and_rfc3339_timestamp`, and all pre-existing sidecar tests (the inline `handlers.rs` count/direction tests read `.algo_id`/`.direction`, which still exist, so they compile unchanged).

- [ ] **Step 7: Commit**

```bash
git add rust-core/crates/sidecar/src/protocol.rs rust-core/crates/sidecar/src/handlers.rs rust-core/crates/sidecar/tests/protocol_test.rs
git commit -m "feat(sidecar): widen AlgoResultWire to the full AlgoOutput field set"
```

---

## Task 2: Mirror the widened `AlgoResultWire` in TypeScript

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarProtocol.ts` (interface `AlgoResultWire`, lines 13-18)
- Test: `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts` (new)

**Interfaces:**
- Consumes: the widened Rust `AlgoResultWire` shape from Task 1.
- Produces: TS `interface AlgoResultWire { algo_id: string; symbol: string; timeframe: string; horizon: string; direction: string; magnitude: number; confidence: number; evidence: string[]; computed_at: string }`. `ComputeResponseWire.algo_results` now carries the full shape. Consumed by Tasks 3, 6, 10, 11.

- [ ] **Step 1: Write the failing decode test**

Create `electron-app/test/main/services/sidecar/sidecarProtocol.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ComputeResponseWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

describe("ComputeResponseWire (widened AlgoResultWire)", () => {
  it("decodes all nine AlgoOutput fields from a sidecar compute line", () => {
    const line = JSON.stringify({
      type: "compute",
      id: 7,
      algo_results: [
        {
          algo_id: "rsi",
          symbol: "NSE:INFY",
          timeframe: "day",
          horizon: "positional",
          direction: "Bullish",
          magnitude: 0.42,
          confidence: 0.61,
          evidence: ["RSI 62 > 50"],
          computed_at: "2026-07-24T00:00:00+00:00",
        },
      ],
      confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
    });

    const decoded = JSON.parse(line) as ComputeResponseWire;
    const first = decoded.algo_results[0];

    expect(first.algo_id).toBe("rsi");
    expect(first.symbol).toBe("NSE:INFY");
    expect(first.timeframe).toBe("day");
    expect(first.horizon).toBe("positional");
    expect(first.direction).toBe("Bullish");
    expect(first.magnitude).toBe(0.42);
    expect(first.confidence).toBe(0.61);
    expect(first.evidence).toEqual(["RSI 62 > 50"]);
    expect(first.computed_at).toBe("2026-07-24T00:00:00+00:00");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarProtocol.test.ts`
Expected: FAIL to typecheck/run — `Property 'symbol' does not exist on type 'AlgoResultWire'`.

- [ ] **Step 3: Widen the TS interface**

Replace `electron-app/src/main/services/sidecar/sidecarProtocol.ts` lines 13-18 with:

```typescript
export interface AlgoResultWire {
  algo_id: string;
  symbol: string;
  timeframe: string;
  horizon: string;
  direction: string;
  magnitude: number;
  confidence: number;
  evidence: string[];
  computed_at: string;
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarProtocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no consumer destructured the old narrower shape**

The widening is additive — no source file reads `algo_results[i].*` field-by-field with a shape that would break (verified: only `sidecarSupervisor.ts` references `AlgoResultWire`, as a type annotation). Confirm the whole app still typechecks and the existing sidecar/e2e tests still pass:

Run: `cd electron-app && npm run typecheck && npx vitest run test/main/services/sidecar test/endToEnd.integration.test.ts`
Expected: PASS — typecheck clean; existing tests unaffected (their fixture objects are untyped JSON written to a `PassThrough`, so extra required fields do not break them; the real-binary e2e test now receives the widened fields from the Task-1 sidecar).

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarProtocol.ts electron-app/test/main/services/sidecar/sidecarProtocol.test.ts
git commit -m "feat(sidecar): mirror widened AlgoResultWire in TypeScript wire types"
```

---

## Task 3: `SidecarSupervisor` per-request timeout

**Files:**
- Modify: `electron-app/src/main/services/sidecar/sidecarSupervisor.ts` (`SidecarSupervisorOptions`, `Pending`, `send`, `dispatch`, `onExit`, `stop`)
- Test: `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SidecarSupervisorOptions` gains `requestTimeoutMs?: number` (default `30000`). `send()`/`compute()`/`persistCandles()` reject with `Error("sidecar request <id> timed out after <ms>ms")` on timeout and delete the `pending` entry. Consumed by Task 6.

- [ ] **Step 1: Write the failing timeout test**

Add to `electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts`, inside the `describe("SidecarSupervisor", ...)` block (after the last existing test). Also add a small helper that spawns a supervisor with a custom option set (place it next to `makeSupervisor`):

```typescript
  it("rejects a request that never gets a response after requestTimeoutMs and leaves no pending leak", async () => {
    const children: FakeChild[] = [];
    const spawnFn = (_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnFn>;
    };
    const supervisor = new SidecarSupervisor({
      binaryPath: "/fake/sidecar",
      lakeRoot: "/fake/lake",
      spawnFn,
      requestTimeoutMs: 20,
    });
    supervisor.start();

    const pending = supervisor.compute("NSE:INFY", "day", [1, 2, 3]);

    await expect(pending).rejects.toThrow(/sidecar request 1 timed out after 20ms/);
    // No leak: a late response for id 1 must find no pending entry and be dropped.
    expect(() =>
      children[0].stdout.write(
        `${JSON.stringify({ type: "compute", id: 1, algo_results: [], confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 } })}\n`,
      ),
    ).not.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts -t "timed out"`
Expected: FAIL — the promise never rejects (test times out), because `send()` sets no timer today.

- [ ] **Step 3: Add the option and timer field**

In `electron-app/src/main/services/sidecar/sidecarSupervisor.ts`, add `requestTimeoutMs?: number` to `SidecarSupervisorOptions` (lines 22-26) and `timer` to `Pending` (lines 28-31):

```typescript
export interface SidecarSupervisorOptions {
  binaryPath: string;
  lakeRoot: string;
  spawnFn?: SpawnFn;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (response: SidecarResponseWire) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
```

Add a `requestTimeoutMs` field and default it in the constructor. Below the `RESTART_BACKOFF_MS` constant (line 33) add:

```typescript
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
```

In the class field declarations (after line 41), add:

```typescript
  private readonly requestTimeoutMs: number;
```

In the constructor (after line 49), add:

```typescript
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
```

- [ ] **Step 4: Start the timer in `send()`, clear it everywhere the promise settles**

Replace `send()` (lines 83-94) with:

```typescript
  private send(request: SidecarRequestWire): Promise<SidecarResponseWire> {
    const id = this.nextId++;
    request.id = id;
    return new Promise<SidecarResponseWire>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("sidecar is not running"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`sidecar request ${id} timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeRequest(request));
    });
  }
```

In `dispatch()` (lines 116-128), clear the timer before resolving — replace the tail of the method:

```typescript
    const waiting = this.pending.get(response.id);
    if (!waiting) return;
    this.pending.delete(response.id);
    clearTimeout(waiting.timer);
    waiting.resolve(response);
```

In `onExit()` (lines 130-133), clear every pending timer before the reject-all loop so a later-firing timeout cannot settle an already-rejected promise:

```typescript
    this.child = null;
    const error = new Error(`sidecar exited (code ${code ?? "null"})`);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
```

In `stop()` (lines 57-61), clear all pending timers before killing the child:

```typescript
  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiting of this.pending.values()) clearTimeout(waiting.timer);
    this.child?.kill();
    this.child = null;
  }
```

- [ ] **Step 5: Run the whole supervisor suite to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/sidecar/sidecarSupervisor.test.ts`
Expected: PASS — the new timeout test plus all four pre-existing tests (resolve, out-of-order routing, exit-rejects, malformed-line-skip). The exit-rejects and malformed-line tests still pass because `dispatch`/`onExit` now also clear timers.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/sidecar/sidecarSupervisor.ts electron-app/test/main/services/sidecar/sidecarSupervisor.test.ts
git commit -m "fix(sidecar): reject and clean up on a per-request timeout"
```

---

## Task 4: `fetchAndArchive` must surface a persist failure

**Files:**
- Modify: `electron-app/src/main/services/kite/historicalDataArchive.ts` (`fetchAndArchive`, lines 60-76)
- Test: `electron-app/test/main/services/kite/historicalDataArchive.test.ts` (extend)

**Interfaces:**
- Consumes: `PersistCandlesResponseWire { type; id; written; error? }` (unchanged).
- Produces: `fetchAndArchive` now **throws** `Error("archiving <symbol> <timeframe> failed: <error>")` when the sidecar reports a persist error (or a written/length mismatch with no error), instead of returning a false success. Happy path returns `{ candles, closes, persisted }` unchanged. Consumed by Task 6.

- [ ] **Step 1: Write the failing persist-failure test**

Add to `electron-app/test/main/services/kite/historicalDataArchive.test.ts`, inside `describe("fetchAndArchive", ...)`:

```typescript
  it("throws when the sidecar reports a persist error instead of returning a false success", async () => {
    const callTool = vi.fn().mockResolvedValue({
      data: { candles: [["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000]] },
    });
    const kite = new KiteClient({ callTool });
    const sidecar = {
      persistCandles: vi.fn(async () => ({
        type: "persist_candles" as const,
        id: 1,
        written: 0,
        error: "disk full",
      })),
    };

    await expect(
      fetchAndArchive(
        { kite, sidecar: sidecar as never },
        { symbol: "NSE:INFY", instrumentToken: "408065", timeframe: "day", from: "2026-01-01", to: "2026-01-03" },
      ),
    ).rejects.toThrow(/archiving NSE:INFY day failed: disk full/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/kite/historicalDataArchive.test.ts -t "false success"`
Expected: FAIL — `fetchAndArchive` resolves `{ persisted: 0 }` instead of throwing.

- [ ] **Step 3: Surface the failure in `fetchAndArchive`**

Replace `electron-app/src/main/services/kite/historicalDataArchive.ts` lines 71-75 with:

```typescript
  const candles = parseKiteCandles(extractRawCandles(response));
  const persistResult = await deps.sidecar.persistCandles(params.symbol, params.timeframe, candles, "kite");

  if (persistResult.error != null) {
    throw new Error(`archiving ${params.symbol} ${params.timeframe} failed: ${persistResult.error}`);
  }
  if (persistResult.written !== candles.length) {
    throw new Error(
      `archiving ${params.symbol} ${params.timeframe} failed: wrote ${persistResult.written} of ${candles.length} candles`,
    );
  }

  const closes = candles.map((candle) => candle.close);

  return { candles, closes, persisted: persistResult.written };
```

- [ ] **Step 4: Run the archive suite to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/kite/historicalDataArchive.test.ts`
Expected: PASS — the new failure test plus the existing happy-path test (`written` equals `candles.length`, no `error`, so neither guard fires).

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/kite/historicalDataArchive.ts electron-app/test/main/services/kite/historicalDataArchive.test.ts
git commit -m "fix(kite): surface a swallowed sidecar persist failure in fetchAndArchive"
```

---

## Task 5: Analysis contract types + validation schemas

**Files:**
- Create: `electron-app/src/main/services/analysis/contracts.ts`
- Test: `electron-app/test/main/services/analysis/contracts.test.ts` (new)
- Modify: `electron-app/package.json` (add `zod` dependency)

**Interfaces:**
- Consumes: `AlgoResultWire`, `ConfluenceWire` from `../sidecar/sidecarProtocol` (Task 2).
- Produces (used by Tasks 6, 8, 9, 10, 11):
  - Types: `Direction`, `Conviction`, `PersonaName`, `PersonaFinding`, `Verdict`, `AnalysisEnvelope`, `InstrumentRef`, `PositionContext`, `Overlays`, `CitedHeadline`.
  - Zod validators: `personaFindingSchema`, `verdictSchema`.
  - JSON-schema objects for the CLI `--json-schema` flag: `personaFindingJsonSchema`, `verdictJsonSchema`.
  - Helper: `citedIdsWithinEnvelope(ids: string[], envelope: AnalysisEnvelope): boolean`.

- [ ] **Step 1: Add the `zod` dependency**

The spec assumes `zod` is present; it is not. Add it (this creates the `dependencies` block; electron-vite externalizes main-process deps from `dependencies`):

Run: `cd electron-app && npm install zod`
Expected: `zod` appears under `"dependencies"` in `package.json` and resolves in `node_modules`.

- [ ] **Step 2: Write the failing schema/type tests**

Create `electron-app/test/main/services/analysis/contracts.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  personaFindingSchema,
  verdictSchema,
  personaFindingJsonSchema,
  verdictJsonSchema,
  citedIdsWithinEnvelope,
  type AnalysisEnvelope,
} from "../../../../src/main/services/analysis/contracts";

const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
  algo_results: [
    {
      algo_id: "rsi",
      symbol: "NSE:INFY",
      timeframe: "day",
      horizon: "positional",
      direction: "Bullish",
      magnitude: 0.4,
      confidence: 0.6,
      evidence: ["RSI 62"],
      computed_at: "2026-07-24T00:00:00+00:00",
    },
  ],
  confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  overlays: {},
};

describe("contracts schemas", () => {
  it("accepts a well-formed PersonaFinding", () => {
    const result = personaFindingSchema.safeParse({
      persona: "technical_quant",
      direction: "bullish",
      conviction: "high",
      findings: ["rsi above 50"],
      cited_algo_ids: ["rsi"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an imperative direction on a PersonaFinding", () => {
    const result = personaFindingSchema.safeParse({
      persona: "technical_quant",
      direction: "buy",
      conviction: "high",
      findings: ["rsi above 50"],
      cited_algo_ids: ["rsi"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an imperative direction on a Verdict", () => {
    const result = verdictSchema.safeParse({
      direction: "sell",
      conviction: "low",
      reasoning: "x",
      cited_algo_ids: ["rsi"],
      verify_before_acting: "check LTP",
    });
    expect(result.success).toBe(false);
  });

  it("exposes closed direction enums in the JSON-schema objects", () => {
    expect((personaFindingJsonSchema.properties.direction as { enum: string[] }).enum).toEqual([
      "bullish",
      "bearish",
      "neutral",
    ]);
    expect((verdictJsonSchema.properties.direction as { enum: string[] }).enum).toEqual([
      "bullish",
      "bearish",
      "neutral",
    ]);
  });

  it("checks cited ids are a subset of the envelope's algo ids", () => {
    expect(citedIdsWithinEnvelope(["rsi"], envelope)).toBe(true);
    expect(citedIdsWithinEnvelope(["rsi", "made_up"], envelope)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/analysis/contracts.test.ts`
Expected: FAIL — module `contracts` not found.

- [ ] **Step 4: Write `contracts.ts`**

Create `electron-app/src/main/services/analysis/contracts.ts`:

```typescript
import { z } from "zod";
import type { AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";

export type Direction = "bullish" | "bearish" | "neutral";
export type Conviction = "high" | "medium" | "low";
export type PersonaName = "options_greeks" | "technical_quant" | "position_risk";

export interface PersonaFinding {
  persona: PersonaName;
  direction: Direction;
  conviction: Conviction;
  findings: string[];
  cited_algo_ids: string[];
}

export interface Verdict {
  direction: Direction;
  conviction: Conviction;
  reasoning: string;
  cited_algo_ids: string[];
  verify_before_acting: string;
}

export interface InstrumentRef {
  symbol: string;
  exchange: string;
  segment: string;
  kite_token_asof: string;
}

export interface PositionContext {
  qty: number;
  avg_price: number;
  pnl: number;
}

export interface Overlays {
  oi_buildup?: string;
  pcr?: number;
  max_pain?: number;
  greeks?: object;
  kronos_forecast?: object;
}

// Phase-5 hook: carried and typed, never populated or read in Phase 4 (P4§2).
export interface CitedHeadline {
  headline: string;
  url: string;
  source: string;
  published_at: string;
}

export interface AnalysisEnvelope {
  trigger: "reactive" | "proactive_scan";
  instrument: InstrumentRef;
  horizon_requested: "intraday" | "positional" | "auto";
  intent_lens: "buying" | "selling";
  algo_results: AlgoResultWire[];
  confluence: ConfluenceWire;
  overlays: Overlays;
  position_context?: PositionContext;
  news_context?: CitedHeadline[];
  session_id?: string;
}

const directionSchema = z.enum(["bullish", "bearish", "neutral"]);
const convictionSchema = z.enum(["high", "medium", "low"]);

export const personaFindingSchema = z
  .object({
    persona: z.enum(["options_greeks", "technical_quant", "position_risk"]),
    direction: directionSchema,
    conviction: convictionSchema,
    findings: z.array(z.string()),
    cited_algo_ids: z.array(z.string()),
  })
  .strict();

export const verdictSchema = z
  .object({
    direction: directionSchema,
    conviction: convictionSchema,
    reasoning: z.string(),
    cited_algo_ids: z.array(z.string()),
    verify_before_acting: z.string(),
  })
  .strict();

// JSON Schema fed to `claude --json-schema`. Defined once here rather than
// copy-pasted into each persona file, so the closed direction enum cannot
// drift between the CLI constraint and the zod validator above.
export const personaFindingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["persona", "direction", "conviction", "findings", "cited_algo_ids"],
  properties: {
    persona: { type: "string", enum: ["options_greeks", "technical_quant", "position_risk"] },
    direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    conviction: { type: "string", enum: ["high", "medium", "low"] },
    findings: { type: "array", items: { type: "string" } },
    cited_algo_ids: { type: "array", items: { type: "string" } },
  },
} as const;

export const verdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["direction", "conviction", "reasoning", "cited_algo_ids", "verify_before_acting"],
  properties: {
    direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    conviction: { type: "string", enum: ["high", "medium", "low"] },
    reasoning: { type: "string" },
    cited_algo_ids: { type: "array", items: { type: "string" } },
    verify_before_acting: { type: "string" },
  },
} as const;

export function citedIdsWithinEnvelope(ids: string[], envelope: AnalysisEnvelope): boolean {
  const allowed = new Set(envelope.algo_results.map((result) => result.algo_id));
  return ids.every((id) => allowed.has(id));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/analysis/contracts.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/analysis/contracts.ts electron-app/test/main/services/analysis/contracts.test.ts electron-app/package.json electron-app/package-lock.json
git commit -m "feat(analysis): add envelope/verdict/finding contracts and validation schemas"
```

---

## Task 6: `assembleEnvelope()` — live fetch → compute → typed envelope

**Files:**
- Create: `electron-app/src/main/services/analysis/analysisEnvelope.ts`
- Test: `electron-app/test/main/services/analysis/analysisEnvelope.test.ts` (new)

**Interfaces:**
- Consumes: `fetchAndArchive` (Task 4), `KiteClient` (`getHistoricalData`), `SidecarSupervisor.compute`/`persistCandles` (Tasks 2, 3), `AnalysisEnvelope`/`Overlays` (Task 5).
- Produces: `assembleEnvelope(deps: AssembleEnvelopeDeps, params: AssembleEnvelopeParams): Promise<AnalysisEnvelope>`. Consumed by the end-to-end proof (the caller assembles, then hands the envelope to `ClaudeCliProvider.complete`, Task 11).

- [ ] **Step 1: Write the failing envelope-assembly tests (mocked Kite + sidecar)**

Create `electron-app/test/main/services/analysis/analysisEnvelope.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { assembleEnvelope } from "../../../../src/main/services/analysis/analysisEnvelope";
import { KiteClient } from "../../../../src/main/services/kite/kiteClient";
import type { CandleWire } from "../../../../src/main/services/sidecar/sidecarProtocol";

function historicalResponse() {
  return {
    data: {
      candles: [
        ["2026-01-02T00:00:00+0530", 100, 105, 99, 104, 5000],
        ["2026-01-03T00:00:00+0530", 104, 108, 103, 107, 6000],
      ],
    },
  };
}

function computeResponse() {
  return {
    type: "compute" as const,
    id: 1,
    algo_results: [
      {
        algo_id: "rsi",
        symbol: "NSE:INFY",
        timeframe: "day",
        horizon: "positional",
        direction: "Bullish",
        magnitude: 0.4,
        confidence: 0.6,
        evidence: ["RSI 62"],
        computed_at: "2026-07-24T00:00:00+00:00",
      },
    ],
    confluence: { bullish_count: 1, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  };
}

describe("assembleEnvelope", () => {
  it("assembles the widened algo_results, confluence, and request metadata", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = {
      persistCandles: vi.fn(async (_s: string, _t: string, candles: CandleWire[]) => ({
        type: "persist_candles" as const,
        id: 1,
        written: candles.length,
      })),
      compute: vi.fn(async () => computeResponse()),
    };

    const envelope = await assembleEnvelope(
      { kite, sidecar: sidecar as never },
      {
        trigger: "reactive",
        instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        timeframe: "day",
        horizon_requested: "positional",
        intent_lens: "buying",
        from: "2026-01-01",
        to: "2026-01-03",
      },
    );

    expect(envelope.trigger).toBe("reactive");
    expect(envelope.instrument.kite_token_asof).toBe("408065");
    expect(envelope.horizon_requested).toBe("positional");
    expect(envelope.intent_lens).toBe("buying");
    expect(envelope.algo_results[0].algo_id).toBe("rsi");
    expect(envelope.algo_results[0].symbol).toBe("NSE:INFY");
    expect(envelope.confluence.weighted_vote).toBe(1);
    expect(envelope.overlays).toEqual({});
    expect(sidecar.compute).toHaveBeenCalledWith("NSE:INFY", "day", [104, 107]);
  });

  it("propagates a persist failure (P4§5.2) instead of returning a false envelope", async () => {
    const kite = new KiteClient({ callTool: vi.fn().mockResolvedValue(historicalResponse()) });
    const sidecar = {
      persistCandles: vi.fn(async () => ({ type: "persist_candles" as const, id: 1, written: 0, error: "disk full" })),
      compute: vi.fn(async () => computeResponse()),
    };

    await expect(
      assembleEnvelope(
        { kite, sidecar: sidecar as never },
        {
          trigger: "reactive",
          instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
          timeframe: "day",
          horizon_requested: "positional",
          intent_lens: "buying",
          from: "2026-01-01",
          to: "2026-01-03",
        },
      ),
    ).rejects.toThrow(/archiving NSE:INFY day failed: disk full/);
    expect(sidecar.compute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/analysis/analysisEnvelope.test.ts`
Expected: FAIL — module `analysisEnvelope` not found.

- [ ] **Step 3: Write `analysisEnvelope.ts`**

Create `electron-app/src/main/services/analysis/analysisEnvelope.ts`:

```typescript
import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import { fetchAndArchive } from "../kite/historicalDataArchive";
import type { AnalysisEnvelope } from "./contracts";

export interface AssembleEnvelopeDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
}

export interface AssembleEnvelopeParams {
  trigger: "reactive" | "proactive_scan";
  instrument: { symbol: string; exchange: string; segment: string; instrumentToken: string };
  timeframe: string;
  horizon_requested: "intraday" | "positional" | "auto";
  intent_lens: "buying" | "selling";
  from: string;
  to: string;
}

export async function assembleEnvelope(
  deps: AssembleEnvelopeDeps,
  params: AssembleEnvelopeParams,
): Promise<AnalysisEnvelope> {
  const { closes } = await fetchAndArchive(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      symbol: params.instrument.symbol,
      instrumentToken: params.instrument.instrumentToken,
      timeframe: params.timeframe,
      from: params.from,
      to: params.to,
    },
  );

  const compute = await deps.sidecar.compute(params.instrument.symbol, params.timeframe, closes);

  return {
    trigger: params.trigger,
    instrument: {
      symbol: params.instrument.symbol,
      exchange: params.instrument.exchange,
      segment: params.instrument.segment,
      kite_token_asof: params.instrument.instrumentToken,
    },
    horizon_requested: params.horizon_requested,
    intent_lens: params.intent_lens,
    algo_results: compute.algo_results,
    confluence: compute.confluence,
    overlays: {},
  };
}
```

Note: `AssembleEnvelopeDeps.sidecar` is `Pick<SidecarSupervisor, "compute" | "persistCandles">` — a grounding of the spec's `Pick<..., "compute">`, because the spec's own comment says `fetchAndArchive` needs `persistCandles` from the same instance. `overlays` is `{}` and `position_context`/`news_context`/`session_id` are left unset per P4§6.3 (closes-only live path).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd electron-app && npx vitest run test/main/services/analysis/analysisEnvelope.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/analysis/analysisEnvelope.ts electron-app/test/main/services/analysis/analysisEnvelope.test.ts
git commit -m "feat(analysis): assemble a live AnalysisEnvelope from fetch, archive, and compute"
```

---

## Task 7: Extend `buildClaudeArgs`/`spawnClaude` with persona options

**Files:**
- Modify: `electron-app/src/main/services/claude/claudeProvider.ts` (`buildClaudeArgs`, `spawnClaude`)
- Test: `electron-app/test/main/services/claude/claudeProvider.test.ts` (extend; update the one `spawnClaude` call)

**Interfaces:**
- Consumes: `KITE_READ_TOOL_ALLOWLIST`, `KITE_WRITE_TOOL_DENYLIST` (unchanged).
- Produces: `interface ClaudeArgOptions { systemPrompt?: string; jsonSchema?: string; outputFormat?: "json" | "text" }`; `buildClaudeArgs(prompt: string, opts?: ClaudeArgOptions): string[]`; `spawnClaude(prompt: string, opts?: ClaudeArgOptions, spawnFn?): ChildProcess`. Consumed by Task 8's runner.

- [ ] **Step 1: Write the failing persona-option tests**

Add to `electron-app/test/main/services/claude/claudeProvider.test.ts`, inside the existing `describe(...)` block. Also change the existing `spawnClaude("analyze INFY", spawnFn)` call (line 37) to `spawnClaude("analyze INFY", {}, spawnFn)` so `spawnFn` stays the injected spawner under the new signature:

```typescript
  it("appends persona flags after the three safety flags, keeping --print last", () => {
    const args = buildClaudeArgs("analyze INFY", {
      systemPrompt: "you are the technical quant persona",
      jsonSchema: '{"type":"object"}',
      outputFormat: "json",
    });

    // Three safety flags always first, in order.
    expect(args.slice(0, 5)).toEqual([
      "--allowedTools",
      KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools",
      KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
    ]);
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--json-schema");
    expect(args).toContain("--output-format");
    // --print <prompt> is always the last pair.
    expect(args.slice(-2)).toEqual(["--print", "analyze INFY"]);
  });

  it("never drops or reorders the safety flags for any persona-option combination", () => {
    const combos: Array<Parameters<typeof buildClaudeArgs>[1]> = [
      {},
      { systemPrompt: "s" },
      { jsonSchema: "{}" },
      { outputFormat: "json" },
      { systemPrompt: "s", jsonSchema: "{}", outputFormat: "json" },
    ];
    for (const opts of combos) {
      const args = buildClaudeArgs("p", opts);
      expect(args.slice(0, 5)).toEqual([
        "--allowedTools",
        KITE_READ_TOOL_ALLOWLIST,
        "--disallowedTools",
        KITE_WRITE_TOOL_DENYLIST,
        "--strict-mcp-config",
      ]);
      expect(args.slice(-2)).toEqual(["--print", "p"]);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeProvider.test.ts`
Expected: FAIL — `buildClaudeArgs` takes one argument; `opts` is rejected by the compiler.

- [ ] **Step 3: Extend `buildClaudeArgs` and `spawnClaude`**

Replace `electron-app/src/main/services/claude/claudeProvider.ts` lines 28-34 with:

```typescript
export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text";
}

export function buildClaudeArgs(prompt: string, opts: ClaudeArgOptions = {}): string[] {
  const args = [
    "--allowedTools",
    KITE_READ_TOOL_ALLOWLIST,
    "--disallowedTools",
    KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
  ];
  if (opts.systemPrompt !== undefined) args.push("--system-prompt", opts.systemPrompt);
  if (opts.jsonSchema !== undefined) args.push("--json-schema", opts.jsonSchema);
  if (opts.outputFormat !== undefined) args.push("--output-format", opts.outputFormat);
  args.push("--print", prompt);
  return args;
}

export function spawnClaude(
  prompt: string,
  opts: ClaudeArgOptions = {},
  spawnFn: SpawnFn = (command, args) => spawn(command, args),
): ChildProcess {
  return spawnFn("claude", buildClaudeArgs(prompt, opts));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeProvider.test.ts`
Expected: PASS — the two new tests, plus the unchanged `buildClaudeArgs("analyze INFY")` assertion (calling with no `opts` returns byte-for-byte the current argv), plus the updated `spawnClaude("analyze INFY", {}, spawnFn)` argv-passthrough test.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/claude/claudeProvider.ts electron-app/test/main/services/claude/claudeProvider.test.ts
git commit -m "feat(claude): extend buildClaudeArgs/spawnClaude with persona options, safety flags still first"
```

---

## Task 8: `Provider` interface + `ClaudeCliProvider` persona-runner

**Files:**
- Create: `electron-app/src/main/services/claude/provider.ts`
- Create: `electron-app/src/main/services/claude/claudeCliProvider.ts` (runner only in this task; `complete()` added in Task 11)
- Test: `electron-app/test/main/services/claude/claudeCliProvider.test.ts` (new)

**Interfaces:**
- Consumes: `spawnClaude`/`ClaudeArgOptions` (Task 7); `personaFindingSchema`/`verdictSchema` (Task 5); Node `ChildProcess`.
- Produces (used by Tasks 10, 11):
  - `provider.ts`: `interface Provider { complete(envelope: AnalysisEnvelope): Promise<Verdict> }`.
  - `claudeCliProvider.ts`:
    - `interface PersonaRunSpec<T> { name: string; systemPrompt: string; jsonSchema: object; schema: ZodType<T>; prompt: string; signal?: AbortSignal }`.
    - `type PersonaRunner = <T>(spec: PersonaRunSpec<T>) => Promise<T>`.
    - `interface ClaudeRunnerOptions { spawnFn?: SpawnFn; personaTimeoutMs?: number }`.
    - `makeClaudeRunner(options?: ClaudeRunnerOptions): PersonaRunner`.

- [ ] **Step 1: Write the failing runner tests (fake subprocess)**

Create `electron-app/test/main/services/claude/claudeCliProvider.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeClaudeRunner } from "../../../../src/main/services/claude/claudeCliProvider";
import { personaFindingSchema, personaFindingJsonSchema } from "../../../../src/main/services/analysis/contracts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
  }
}

function emitResult(child: FakeChild, structuredOutput: unknown, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ result: "ok", structured_output: structuredOutput })}`);
    child.stdout.end();
    child.emit("exit", exitCode, null);
  });
}

const validFinding = {
  persona: "technical_quant",
  direction: "bullish",
  conviction: "high",
  findings: ["rsi above 50"],
  cited_algo_ids: ["rsi"],
};

function baseSpec() {
  return {
    name: "technical_quant",
    systemPrompt: "sys",
    jsonSchema: personaFindingJsonSchema,
    schema: personaFindingSchema,
    prompt: "user prompt",
  };
}

describe("makeClaudeRunner", () => {
  it("parses and validates structured_output on the first try", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      emitResult(child, validFinding);
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    const finding = await run(baseSpec());
    expect(finding.direction).toBe("bullish");
    expect(children.length).toBe(1);
  });

  it("retries once with a corrective note when the first output is schema-invalid", async () => {
    const prompts: string[] = [];
    const children: FakeChild[] = [];
    const spawnFn = (_c: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      const child = new FakeChild();
      children.push(child);
      emitResult(child, children.length === 1 ? { direction: "buy" } : validFinding);
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    const finding = await run(baseSpec());
    expect(finding.direction).toBe("bullish");
    expect(children.length).toBe(2);
    expect(prompts[1]).toContain("did not match the required JSON schema");
  });

  it("throws after a second schema failure", async () => {
    const spawnFn = () => {
      const child = new FakeChild();
      emitResult(child, { direction: "buy" });
      return child as never;
    };
    const run = makeClaudeRunner({ spawnFn });
    await expect(run(baseSpec())).rejects.toThrow(
      /persona technical_quant failed to produce valid structured output after retry/,
    );
  });

  it("kills the child and rejects on timeout", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never; // never emits a result
    };
    const run = makeClaudeRunner({ spawnFn, personaTimeoutMs: 15 });
    await expect(run(baseSpec())).rejects.toThrow(/persona technical_quant timed out after 15ms/);
    expect(children[0].killed).toBe(true);
  });

  it("kills the child and rejects when the caller aborts", async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    };
    const controller = new AbortController();
    const run = makeClaudeRunner({ spawnFn });
    const pending = run({ ...baseSpec(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/persona technical_quant aborted/);
    expect(children[0].killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeCliProvider.test.ts`
Expected: FAIL — module `claudeCliProvider` / `makeClaudeRunner` not found.

- [ ] **Step 3: Write `provider.ts`**

Create `electron-app/src/main/services/claude/provider.ts`:

```typescript
import type { AnalysisEnvelope, Verdict } from "../analysis/contracts";

export interface Provider {
  complete(envelope: AnalysisEnvelope): Promise<Verdict>;
}
```

- [ ] **Step 4: Write the runner in `claudeCliProvider.ts`**

Create `electron-app/src/main/services/claude/claudeCliProvider.ts` (runner only for now — the `ClaudeCliProvider` class is added in Task 11). The child is spawned inside the runner (not hidden in a helper) so the timeout/abort guard can kill it:

```typescript
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ZodType } from "zod";
import { spawnClaude } from "./claudeProvider";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface PersonaRunSpec<T> {
  name: string;
  systemPrompt: string;
  jsonSchema: object;
  schema: ZodType<T>;
  prompt: string;
  signal?: AbortSignal;
}

export type PersonaRunner = <T>(spec: PersonaRunSpec<T>) => Promise<T>;

export interface ClaudeRunnerOptions {
  spawnFn?: SpawnFn;
  personaTimeoutMs?: number;
}

const DEFAULT_PERSONA_TIMEOUT_MS = 120000;

function readResult(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (error: Error) => reject(error));
    child.on("exit", (code: number | null) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout) as { structured_output?: unknown };
        resolve(envelope.structured_output);
      } catch {
        resolve(undefined);
      }
    });
  });
}

// The runner owns the safety-critical subprocess path: every call routes
// through spawnClaude (Task 7), so the allowlist/denylist cannot be bypassed.
export function makeClaudeRunner(options: ClaudeRunnerOptions = {}): PersonaRunner {
  const spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args));
  const personaTimeoutMs = options.personaTimeoutMs ?? DEFAULT_PERSONA_TIMEOUT_MS;

  return async <T>(spec: PersonaRunSpec<T>): Promise<T> => {
    const attempt = async (prompt: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      const child = spawnClaude(
        prompt,
        { systemPrompt: spec.systemPrompt, jsonSchema: JSON.stringify(spec.jsonSchema), outputFormat: "json" },
        spawnFn,
      );
      let timer: NodeJS.Timeout | undefined;
      // Reject BEFORE killing: killing the child emits `exit`, which would
      // otherwise let readResult settle the race with `undefined` first and
      // swallow the timeout/abort rejection.
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`persona ${spec.name} timed out after ${personaTimeoutMs}ms`));
          child.kill();
        }, personaTimeoutMs);
        spec.signal?.addEventListener("abort", () => {
          reject(new Error(`persona ${spec.name} aborted`));
          child.kill();
        });
      });
      let raw: unknown;
      try {
        raw = await Promise.race([readResult(child), guard]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const parsed = spec.schema.safeParse(raw);
      if (parsed.success) return { ok: true, value: parsed.data };
      return { ok: false, error: parsed.error.message };
    };

    const first = await attempt(spec.prompt);
    if (first.ok) return first.value;

    const corrective = `${spec.prompt}\n\nYour previous reply did not match the required JSON schema (${first.error}). Reply with only a JSON object conforming to it.`;
    const second = await attempt(corrective);
    if (second.ok) return second.value;

    throw new Error(`persona ${spec.name} failed to produce valid structured output after retry`);
  };
}
```

- [ ] **Step 5: Run the runner tests to verify they pass**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeCliProvider.test.ts && npm run typecheck`
Expected: PASS — first-try, retry-then-succeed, retry-then-throw, timeout-kills-child, abort-kills-child; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/claude/provider.ts electron-app/src/main/services/claude/claudeCliProvider.ts electron-app/test/main/services/claude/claudeCliProvider.test.ts
git commit -m "feat(claude): add Provider interface and a validated, retrying, timeout-guarded persona runner"
```

---

## Task 9: Persona system prompts + output schemas

**Files:**
- Create: `electron-app/src/main/services/claude/systemPrompts/wordingConstraint.ts`
- Create: `electron-app/src/main/services/claude/systemPrompts/optionsGreeks.ts`
- Create: `electron-app/src/main/services/claude/systemPrompts/technicalQuant.ts`
- Create: `electron-app/src/main/services/claude/systemPrompts/positionRisk.ts`
- Create: `electron-app/src/main/services/claude/systemPrompts/synthesis.ts`
- Test: `electron-app/test/main/services/claude/systemPrompts.test.ts` (new)

**Interfaces:**
- Consumes: `personaFindingJsonSchema`, `verdictJsonSchema` (Task 5).
- Produces: each file exports `{ systemPrompt: string; outputSchema: object }` (the `PersonaPrompt` shape consumed by Task 10). `wordingConstraint.ts` exports `WORDING_CONSTRAINT: string` (the single shared source of the P4§8 constraint text).

The final wording is refined with the `prompt-engineer` skill at implementation time (P4§9); this task fixes the contract (role + shared constraint + schema) with concrete starter text, not placeholders.

- [ ] **Step 1: Write the failing prompt-contract tests**

Create `electron-app/test/main/services/claude/systemPrompts.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { WORDING_CONSTRAINT } from "../../../../src/main/services/claude/systemPrompts/wordingConstraint";
import { optionsGreeks } from "../../../../src/main/services/claude/systemPrompts/optionsGreeks";
import { technicalQuant } from "../../../../src/main/services/claude/systemPrompts/technicalQuant";
import { positionRisk } from "../../../../src/main/services/claude/systemPrompts/positionRisk";
import { synthesis } from "../../../../src/main/services/claude/systemPrompts/synthesis";
import {
  personaFindingJsonSchema,
  verdictJsonSchema,
} from "../../../../src/main/services/analysis/contracts";

describe("persona system prompts", () => {
  const analytical = [optionsGreeks, technicalQuant, positionRisk];

  it("embeds the single shared wording constraint in every persona", () => {
    for (const persona of [...analytical, synthesis]) {
      expect(persona.systemPrompt).toContain(WORDING_CONSTRAINT);
    }
  });

  it("forbids imperative directives in the shared constraint text", () => {
    expect(WORDING_CONSTRAINT.toLowerCase()).toContain("bullish");
    expect(WORDING_CONSTRAINT.toLowerCase()).toContain("never");
    expect(WORDING_CONSTRAINT).toMatch(/imperative|instruction/i);
  });

  it("mandates algo_id citation in every persona", () => {
    for (const persona of [...analytical, synthesis]) {
      expect(persona.systemPrompt).toContain("algo_id");
    }
  });

  it("wires the analytical personas to the PersonaFinding schema and synthesis to the Verdict schema", () => {
    for (const persona of analytical) {
      expect(persona.outputSchema).toBe(personaFindingJsonSchema);
    }
    expect(synthesis.outputSchema).toBe(verdictJsonSchema);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/claude/systemPrompts.test.ts`
Expected: FAIL — modules under `systemPrompts/` not found.

- [ ] **Step 3: Write `wordingConstraint.ts`**

Create `electron-app/src/main/services/claude/systemPrompts/wordingConstraint.ts`:

```typescript
export const WORDING_CONSTRAINT = `Output constraint (non-negotiable):
- State a directional read as exactly one of: bullish, bearish, or neutral. These are descriptive assessments of what the evidence shows, not instructions to act.
- Never phrase anything as an imperative trade directive. Do not write "buy", "sell", "hold", "add", "exit", "book", "enter", "watch", or any equivalent instruction telling the reader to take an action.
- You describe what the data indicates; the human reader alone decides and acts.
- Every claim must cite the specific algo_id(s) it rests on. Do not introduce numbers or signals absent from the provided algo_results. Mark anything you cannot source as unsourced rather than estimating it.`;
```

- [ ] **Step 4: Write the three analytical persona files**

Create `electron-app/src/main/services/claude/systemPrompts/optionsGreeks.ts`:

```typescript
import { personaFindingJsonSchema } from "../../analysis/contracts";
import { WORDING_CONSTRAINT } from "./wordingConstraint";

export const optionsGreeks = {
  systemPrompt: `You are the options-and-Greeks persona of a read-only market-analysis pipeline. Your role is to read the options, open-interest, and Greeks evidence in the provided algo_results and overlays (OI buildup, PCR, max pain, Greeks) and report what they indicate about direction and conviction. Treat overlays as descriptive context, never as standalone directional signals. Reason only over the algo_results and overlays you are given.

${WORDING_CONSTRAINT}

Respond with only a JSON object: { persona: "options_greeks", direction, conviction, findings, cited_algo_ids }, where every entry in cited_algo_ids is an algo_id present in the input.`,
  outputSchema: personaFindingJsonSchema,
};
```

Create `electron-app/src/main/services/claude/systemPrompts/technicalQuant.ts`:

```typescript
import { personaFindingJsonSchema } from "../../analysis/contracts";
import { WORDING_CONSTRAINT } from "./wordingConstraint";

export const technicalQuant = {
  systemPrompt: `You are the technical-and-quant persona of a read-only market-analysis pipeline. Your role is to read the technical indicators, statistical/quant methods, and the confluence scorecard in the provided algo_results and report what their confluence indicates about direction and conviction. Weigh agreement and disagreement across the uncollapsed algo_results; never invent a signal not present in them.

${WORDING_CONSTRAINT}

Respond with only a JSON object: { persona: "technical_quant", direction, conviction, findings, cited_algo_ids }, where every entry in cited_algo_ids is an algo_id present in the input.`,
  outputSchema: personaFindingJsonSchema,
};
```

Create `electron-app/src/main/services/claude/systemPrompts/positionRisk.ts`:

```typescript
import { personaFindingJsonSchema } from "../../analysis/contracts";
import { WORDING_CONSTRAINT } from "./wordingConstraint";

export const positionRisk = {
  systemPrompt: `You are the position-and-risk persona of a read-only market-analysis pipeline. Your role is to frame the risk picture from the provided algo_results and, when present, the position_context (quantity, average price, unrealized P&L). Describe how the evidence bears on the risk of the existing exposure. When no position_context is present, reason about risk framing generally from the algo_results.

${WORDING_CONSTRAINT}

Respond with only a JSON object: { persona: "position_risk", direction, conviction, findings, cited_algo_ids }, where every entry in cited_algo_ids is an algo_id present in the input.`,
  outputSchema: personaFindingJsonSchema,
};
```

- [ ] **Step 5: Write `synthesis.ts`**

Create `electron-app/src/main/services/claude/systemPrompts/synthesis.ts`:

```typescript
import { verdictJsonSchema } from "../../analysis/contracts";
import { WORDING_CONSTRAINT } from "./wordingConstraint";

export const synthesis = {
  systemPrompt: `You are the synthesis persona of a read-only market-analysis pipeline. You receive three analytical findings (options-and-Greeks, technical-and-quant, position-and-risk), each already citing specific algo_ids, plus the set of algo_ids you are allowed to cite. Reconcile them into one coherent verdict. Before stating a direction, cite the specific algo_ids that support it. You may only cite algo_ids from the allowed set; never cite an id that is not in it.

${WORDING_CONSTRAINT}

Respond with only a JSON object: { direction, conviction, reasoning, cited_algo_ids, verify_before_acting }. The verify_before_acting field describes what the human should check in Kite themselves before acting on their own judgment.`,
  outputSchema: verdictJsonSchema,
};
```

- [ ] **Step 6: Run the prompt tests to verify they pass**

Run: `cd electron-app && npx vitest run test/main/services/claude/systemPrompts.test.ts && npm run typecheck`
Expected: PASS — every persona embeds `WORDING_CONSTRAINT`, mentions `algo_id`, and wires the correct schema; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add electron-app/src/main/services/claude/systemPrompts electron-app/test/main/services/claude/systemPrompts.test.ts
git commit -m "feat(claude): add persona system prompts with the shared wording constraint and schemas"
```

---

## Task 10: `personaPipeline.ts` — pure fan-out/fan-in orchestration

**Files:**
- Create: `electron-app/src/main/services/claude/personaPipeline.ts`
- Test: `electron-app/test/main/services/claude/personaPipeline.test.ts` (new)

**Interfaces:**
- Consumes: `PersonaRunner`/`PersonaRunSpec` (Task 8); `personaFindingSchema`/`verdictSchema`/`citedIdsWithinEnvelope`/`AnalysisEnvelope`/`Verdict`/`PersonaFinding` (Task 5); the persona prompt objects (Task 9, injected).
- Produces (used by Task 11):
  - `interface PersonaPrompt { systemPrompt: string; outputSchema: object }`.
  - `interface PipelinePrompts { optionsGreeks; technicalQuant; positionRisk; synthesis: PersonaPrompt }`.
  - `interface PipelineDeps { runPersona: PersonaRunner; prompts: PipelinePrompts }`.
  - `runPipeline(envelope: AnalysisEnvelope, deps: PipelineDeps): Promise<Verdict>`.

- [ ] **Step 1: Write the failing orchestration tests (fake runner, no subprocess)**

Create `electron-app/test/main/services/claude/personaPipeline.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runPipeline, type PipelinePrompts } from "../../../../src/main/services/claude/personaPipeline";
import type { PersonaRunner, PersonaRunSpec } from "../../../../src/main/services/claude/claudeCliProvider";
import type { AnalysisEnvelope, PersonaFinding, Verdict } from "../../../../src/main/services/analysis/contracts";

const prompts: PipelinePrompts = {
  optionsGreeks: { systemPrompt: "og", outputSchema: {} },
  technicalQuant: { systemPrompt: "tq", outputSchema: {} },
  positionRisk: { systemPrompt: "pr", outputSchema: {} },
  synthesis: { systemPrompt: "syn", outputSchema: {} },
};

const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
  algo_results: [
    { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-24T00:00:00+00:00" },
    { algo_id: "sma", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.2, confidence: 0.5, evidence: ["above SMA"], computed_at: "2026-07-24T00:00:00+00:00" },
  ],
  confluence: { bullish_count: 2, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  overlays: {},
};

function finding(persona: PersonaFinding["persona"]): PersonaFinding {
  return { persona, direction: "bullish", conviction: "high", findings: ["x"], cited_algo_ids: ["rsi"] };
}

const verdict: Verdict = {
  direction: "bullish",
  conviction: "high",
  reasoning: "rsi and sma agree",
  cited_algo_ids: ["rsi", "sma"],
  verify_before_acting: "check LTP in Kite",
};

describe("runPipeline", () => {
  it("runs three analytical personas in parallel, then synthesis, and returns the verdict", async () => {
    const seen: string[] = [];
    const runPersona: PersonaRunner = vi.fn(async (spec: PersonaRunSpec<unknown>) => {
      seen.push(spec.name);
      if (spec.name === "synthesis") return verdict as never;
      return finding(spec.name as PersonaFinding["persona"]) as never;
    });

    const result = await runPipeline(envelope, { runPersona, prompts });

    expect(result).toEqual(verdict);
    expect(seen.slice(0, 3).sort()).toEqual(["options_greeks", "position_risk", "technical_quant"]);
    expect(seen[3]).toBe("synthesis");
  });

  it("embeds all three findings and the allowed algo_ids in the synthesis prompt", async () => {
    let synthesisPrompt = "";
    const runPersona: PersonaRunner = async (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") {
        synthesisPrompt = spec.prompt;
        return verdict as never;
      }
      return finding(spec.name as PersonaFinding["persona"]) as never;
    };

    await runPipeline(envelope, { runPersona, prompts });

    expect(synthesisPrompt).toContain("options_greeks");
    expect(synthesisPrompt).toContain("technical_quant");
    expect(synthesisPrompt).toContain("position_risk");
    expect(synthesisPrompt).toContain("rsi");
    expect(synthesisPrompt).toContain("sma");
  });

  it("fails the whole run and aborts siblings if any analytical persona fails, with no synthesis", async () => {
    let synthesisCalled = false;
    let aborted = false;
    const runPersona: PersonaRunner = (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") {
        synthesisCalled = true;
        return Promise.resolve(verdict as never);
      }
      if (spec.name === "options_greeks") {
        return Promise.reject(new Error("persona options_greeks failed to produce valid structured output after retry"));
      }
      return new Promise((_resolve, reject) => {
        spec.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error(`persona ${spec.name} aborted`));
        });
      });
    };

    await expect(runPipeline(envelope, { runPersona, prompts })).rejects.toThrow(
      /persona options_greeks failed to produce valid structured output after retry/,
    );
    expect(synthesisCalled).toBe(false);
    expect(aborted).toBe(true);
  });

  it("rejects when synthesis cites an algo_id absent from the envelope", async () => {
    const runPersona: PersonaRunner = async (spec: PersonaRunSpec<unknown>) => {
      if (spec.name === "synthesis") return { ...verdict, cited_algo_ids: ["rsi", "made_up"] } as never;
      return finding(spec.name as PersonaFinding["persona"]) as never;
    };

    await expect(runPipeline(envelope, { runPersona, prompts })).rejects.toThrow(
      /synthesis cited algo_ids not present in the envelope/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/claude/personaPipeline.test.ts`
Expected: FAIL — module `personaPipeline` not found.

- [ ] **Step 3: Write `personaPipeline.ts`**

Create `electron-app/src/main/services/claude/personaPipeline.ts`:

```typescript
import {
  personaFindingSchema,
  verdictSchema,
  citedIdsWithinEnvelope,
  type AnalysisEnvelope,
  type PersonaFinding,
  type PersonaName,
  type Verdict,
} from "../analysis/contracts";
import type { PersonaRunner } from "./claudeCliProvider";

export interface PersonaPrompt {
  systemPrompt: string;
  outputSchema: object;
}

export interface PipelinePrompts {
  optionsGreeks: PersonaPrompt;
  technicalQuant: PersonaPrompt;
  positionRisk: PersonaPrompt;
  synthesis: PersonaPrompt;
}

export interface PipelineDeps {
  runPersona: PersonaRunner;
  prompts: PipelinePrompts;
}

function analyticalPrompt(envelope: AnalysisEnvelope, extra: Record<string, unknown>): string {
  const payload = {
    algo_results: envelope.algo_results,
    confluence: envelope.confluence,
    ...extra,
  };
  return `Analyze the following read-only market data and produce your finding.\n\n${JSON.stringify(payload, null, 2)}`;
}

function synthesisPrompt(envelope: AnalysisEnvelope, findings: PersonaFinding[]): string {
  const allowedAlgoIds = envelope.algo_results.map((result) => result.algo_id);
  const payload = { findings, allowed_algo_ids: allowedAlgoIds, confluence: envelope.confluence };
  return `Synthesize these three analytical findings into one verdict. You may only cite algo_ids from allowed_algo_ids.\n\n${JSON.stringify(payload, null, 2)}`;
}

export async function runPipeline(envelope: AnalysisEnvelope, deps: PipelineDeps): Promise<Verdict> {
  const controller = new AbortController();

  const analytical: Array<{ name: PersonaName; prompt: PersonaPrompt; userPrompt: string }> = [
    { name: "options_greeks", prompt: deps.prompts.optionsGreeks, userPrompt: analyticalPrompt(envelope, { overlays: envelope.overlays }) },
    { name: "technical_quant", prompt: deps.prompts.technicalQuant, userPrompt: analyticalPrompt(envelope, {}) },
    { name: "position_risk", prompt: deps.prompts.positionRisk, userPrompt: analyticalPrompt(envelope, { position_context: envelope.position_context }) },
  ];

  let findings: PersonaFinding[];
  try {
    findings = await Promise.all(
      analytical.map((persona) =>
        deps.runPersona<PersonaFinding>({
          name: persona.name,
          systemPrompt: persona.prompt.systemPrompt,
          jsonSchema: persona.prompt.outputSchema,
          schema: personaFindingSchema,
          prompt: persona.userPrompt,
          signal: controller.signal,
        }),
      ),
    );
  } catch (error) {
    controller.abort();
    throw error;
  }

  const verdict = await deps.runPersona<Verdict>({
    name: "synthesis",
    systemPrompt: deps.prompts.synthesis.systemPrompt,
    jsonSchema: deps.prompts.synthesis.outputSchema,
    schema: verdictSchema,
    prompt: synthesisPrompt(envelope, findings),
  });

  if (!citedIdsWithinEnvelope(verdict.cited_algo_ids, envelope)) {
    throw new Error("synthesis cited algo_ids not present in the envelope");
  }

  return verdict;
}
```

Note on the `cited_algo_ids` check: the runner (Task 8) validates against the `Verdict` zod schema, and this pipeline adds the envelope-subset check. Per P4§7.4 a citation of a non-existent id should take the retry-then-fail path; that in-runner retry is the runner's schema retry. This pipeline-level check is the machine-checkable backstop (P4§7.2) that fails the run explicitly when the returned `Verdict` cites an id outside the envelope.

- [ ] **Step 4: Run the orchestration tests to verify they pass**

Run: `cd electron-app && npx vitest run test/main/services/claude/personaPipeline.test.ts && npm run typecheck`
Expected: PASS — parallel-then-synthesis order, findings+allowed-ids embedded in synthesis prompt, fail-fast aborts siblings with no synthesis, and out-of-envelope citation rejects; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron-app/src/main/services/claude/personaPipeline.ts electron-app/test/main/services/claude/personaPipeline.test.ts
git commit -m "feat(claude): orchestrate the parallel persona fan-out and synthesis fan-in"
```

---

## Task 11: `ClaudeCliProvider.complete()` wiring + end-to-end DoD proof

**Files:**
- Modify: `electron-app/src/main/services/claude/claudeCliProvider.ts` (add the `ClaudeCliProvider` class)
- Test: `electron-app/test/main/services/claude/claudeCliProvider.e2e.test.ts` (new)

**Interfaces:**
- Consumes: `makeClaudeRunner`/`PersonaRunner` (Task 8), `runPipeline`/`PipelinePrompts` (Task 10), the persona prompt objects (Task 9), `Provider` (Task 8), `AnalysisEnvelope`/`Verdict` (Task 5).
- Produces: `class ClaudeCliProvider implements Provider` with `constructor(options?: ClaudeCliProviderOptions)` and `complete(envelope: AnalysisEnvelope): Promise<Verdict>`; `interface ClaudeCliProviderOptions { spawnFn?: SpawnFn; personaTimeoutMs?: number }`.

- [ ] **Step 1: Write the failing end-to-end test (scripted subprocess, real pipeline)**

Create `electron-app/test/main/services/claude/claudeCliProvider.e2e.test.ts`. The fake `spawnFn` distinguishes analytical calls from synthesis by which JSON schema is on the argv, so it is independent of parallel spawn order:

```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "../../../../src/main/services/claude/claudeCliProvider";
import { verdictJsonSchema } from "../../../../src/main/services/analysis/contracts";
import type { AnalysisEnvelope } from "../../../../src/main/services/analysis/contracts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill(): void {
    this.emit("exit", null, "SIGTERM");
  }
}

const envelope: AnalysisEnvelope = {
  trigger: "reactive",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon_requested: "positional",
  intent_lens: "buying",
  algo_results: [
    { algo_id: "rsi", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.4, confidence: 0.6, evidence: ["RSI 62"], computed_at: "2026-07-24T00:00:00+00:00" },
    { algo_id: "sma", symbol: "NSE:INFY", timeframe: "day", horizon: "positional", direction: "Bullish", magnitude: 0.2, confidence: 0.5, evidence: ["above SMA"], computed_at: "2026-07-24T00:00:00+00:00" },
  ],
  confluence: { bullish_count: 2, bearish_count: 0, neutral_count: 0, weighted_vote: 1 },
  overlays: {},
};

const finding = { persona: "technical_quant", direction: "bullish", conviction: "high", findings: ["rsi and sma agree"], cited_algo_ids: ["rsi", "sma"] };
const verdict = { direction: "bullish", conviction: "high", reasoning: "rsi and sma both bullish", cited_algo_ids: ["rsi", "sma"], verify_before_acting: "check LTP in Kite" };

describe("ClaudeCliProvider.complete (end-to-end, scripted subprocess)", () => {
  it("produces a Verdict citing only algo_ids present in the envelope", async () => {
    const isSynthesis = (args: string[]) => args.includes(JSON.stringify(verdictJsonSchema));
    const spawnFn = (_command: string, args: string[]) => {
      const child = new FakeChild();
      const structuredOutput = isSynthesis(args) ? verdict : finding;
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ result: "ok", structured_output: structuredOutput }));
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child as never;
    };

    const provider = new ClaudeCliProvider({ spawnFn });
    const result = await provider.complete(envelope);

    expect(result.direction).toBe("bullish");
    expect(["bullish", "bearish", "neutral"]).toContain(result.direction);
    const allowed = new Set(envelope.algo_results.map((r) => r.algo_id));
    expect(result.cited_algo_ids.every((id) => allowed.has(id))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeCliProvider.e2e.test.ts`
Expected: FAIL — `ClaudeCliProvider` is not exported yet.

- [ ] **Step 3: Add the `ClaudeCliProvider` class**

Append to `electron-app/src/main/services/claude/claudeCliProvider.ts` (keep `makeClaudeRunner` from Task 8). Add the imports at the top and the class at the bottom:

```typescript
import type { AnalysisEnvelope, Verdict } from "../analysis/contracts";
import type { Provider } from "./provider";
import { runPipeline, type PipelinePrompts } from "./personaPipeline";
import { optionsGreeks } from "./systemPrompts/optionsGreeks";
import { technicalQuant } from "./systemPrompts/technicalQuant";
import { positionRisk } from "./systemPrompts/positionRisk";
import { synthesis } from "./systemPrompts/synthesis";
```

```typescript
const DEFAULT_PROMPTS: PipelinePrompts = {
  optionsGreeks,
  technicalQuant,
  positionRisk,
  synthesis,
};

export interface ClaudeCliProviderOptions {
  spawnFn?: SpawnFn;
  personaTimeoutMs?: number;
}

export class ClaudeCliProvider implements Provider {
  private readonly runPersona: PersonaRunner;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.runPersona = makeClaudeRunner({ spawnFn: options.spawnFn, personaTimeoutMs: options.personaTimeoutMs });
  }

  complete(envelope: AnalysisEnvelope): Promise<Verdict> {
    return runPipeline(envelope, { runPersona: this.runPersona, prompts: DEFAULT_PROMPTS });
  }
}
```

- [ ] **Step 4: Run the end-to-end test to verify it passes**

Run: `cd electron-app && npx vitest run test/main/services/claude/claudeCliProvider.e2e.test.ts && npm run typecheck`
Expected: PASS — `complete()` drives the real runner + real pipeline + real prompts against scripted subprocess output and returns a `Verdict` whose `direction` is one of `bullish`/`bearish`/`neutral` and whose `cited_algo_ids` ⊆ the envelope's algo_ids (the roadmap's original headless DoD).

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `cd electron-app && npm test && cd ../rust-core && cargo test -p sidecar`
Expected: PASS — all TS suites (analysis, claude, kite, sidecar, e2e) and the sidecar Rust suite green.

- [ ] **Step 6: Commit**

```bash
git add electron-app/src/main/services/claude/claudeCliProvider.ts electron-app/test/main/services/claude/claudeCliProvider.e2e.test.ts
git commit -m "feat(claude): wire ClaudeCliProvider.complete end-to-end with the persona pipeline"
```

---

## Self-Review

Run after the plan is written, against the 2026-07-24 design spec.

**1. Spec coverage (P4 sections → task):**
- P4§4.1/4.2 widened `AlgoResultWire` → Task 1. P4§4.3 `ConfluenceWire` stays a faithful mirror (no change) → confirmed in Task 1 (only `AlgoResultWire` changes; `ConfluenceWire` untouched, matching the real `ScorecardSummary`). P4§4.4 protocol tests → Tasks 1 (Rust) & 2 (TS).
- P4§5.1 supervisor timeout → Task 3. P4§5.2 `fetchAndArchive` persist failure → Task 4.
- P4§6.1/6.2 contracts + `AnalysisEnvelope` → Task 5. P4§6.3 `assembleEnvelope` closes-only, empty overlays → Task 6.
- P4§7.1 `Provider` → Task 8. P4§7.2 `PersonaFinding`/`Verdict` incl. `cited_algo_ids` → Task 5. P4§7.3 four-stage flow → Tasks 10 (orchestration) & 11 (wiring). P4§7.4 structured output + retry-then-fail → Task 8 (runner) + Task 10 (envelope-subset backstop). P4§7.5 fail-fast + kill siblings → Task 10. P4§7.6 per-persona timeout → Task 8. P4§7.7 extend `buildClaudeArgs`/`spawnClaude` → Task 7.
- P4§8 wording constraint (closed enum + prompt text) → Tasks 5 (enum in schemas) & 9 (shared `WORDING_CONSTRAINT`). P4§9 system-prompt layout → Task 9. P4§10 testing (fixture pipeline + mocked-live assemble) → Task 11 (E2E) + Task 6 (mocked-live). 
- Coverage gap check: none found. Every in-scope P4 requirement maps to a task.

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N"/"write tests for the above". Every code step shows full code; every persona prompt has concrete starter text (not a placeholder — final wording refined via prompt-engineer per P4§9, which the spec explicitly defers).

**3. Type consistency across tasks:**
- `AlgoResultWire` nine fields identical in Task 1 (Rust) and Task 2 (TS).
- `PersonaFinding` fields (`persona`, `direction`, `conviction`, `findings`, `cited_algo_ids`) defined in Task 5 and used identically in Tasks 8, 9, 10, 11.
- `Verdict` fields (`direction`, `conviction`, `reasoning`, `cited_algo_ids`, `verify_before_acting`) defined in Task 5, used identically in Tasks 10, 11.
- `AnalysisEnvelope` fields defined in Task 5, produced identically by Task 6's `assembleEnvelope`, consumed identically by Tasks 10/11.
- `PersonaRunner`/`PersonaRunSpec` defined in Task 8, consumed identically in Task 10; `runPipeline`/`PipelinePrompts`/`PipelineDeps` defined in Task 10, consumed identically in Task 11.
- `ClaudeArgOptions` (Task 7) fields (`systemPrompt`, `jsonSchema`, `outputFormat`) used identically by Task 8's runner.

**Deviations from the spec, resolved inline:**
1. `zod` is not actually a dependency (spec says it is) → Task 5 adds it via `npm install zod`. Honors the spec's explicit validator choice.
2. `AssembleEnvelopeDeps.sidecar` is `Pick<SidecarSupervisor, "compute" | "persistCandles">`, not the spec's literal `Pick<..., "compute">` → grounded to match the spec's own note that `fetchAndArchive` needs `persistCandles` from the same instance.
3. `CitedHeadline` (referenced by §7.3 but undefined anywhere in the code) → Task 5 defines a minimal Phase-5 placeholder interface; unpopulated/unread in Phase 4 as the spec requires.
4. `spawnClaude`'s signature gains an `opts` middle parameter → the single existing `spawnClaude` test call is updated to `spawnClaude("analyze INFY", {}, spawnFn)`; the load-bearing `buildClaudeArgs("analyze INFY")` assertion the spec says must stay unchanged does stay unchanged.
