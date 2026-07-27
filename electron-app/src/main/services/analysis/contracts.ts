import { z } from "zod";
import type { AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { InstrumentSelection } from "./analysisEnvelope";
import type { Horizon } from "../../ipc/rendererApi";

export type Direction = "bullish" | "bearish" | "neutral";
export type Conviction = "high" | "medium" | "low";
export type PersonaName = "options_greeks" | "technical_quant" | "position_risk";
export type IntentLens = "buying" | "selling";

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

export interface IntakeResult {
  instrument: InstrumentSelection;
  horizon: Horizon;
  researchNotes?: string;
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
  intent_lens: IntentLens;
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
    cited_algo_ids: z.array(z.string()).min(1),
  })
  .strict();

export const verdictSchema = z
  .object({
    direction: directionSchema,
    conviction: convictionSchema,
    reasoning: z.string(),
    cited_algo_ids: z.array(z.string()).min(1),
    verify_before_acting: z.string(),
  })
  .strict();

export const intakeResultSchema = z
  .object({
    instrument: z
      .object({
        symbol: z.string().min(1),
        exchange: z.string(),
        segment: z.string(),
        instrumentToken: z.string().min(1),
      })
      .strict(),
    horizon: z.enum(["intraday", "positional"]),
    researchNotes: z.string().optional(),
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
    cited_algo_ids: { type: "array", items: { type: "string" }, minItems: 1 },
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
    cited_algo_ids: { type: "array", items: { type: "string" }, minItems: 1 },
    verify_before_acting: { type: "string" },
  },
} as const;

export const intakeResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instrument", "horizon"],
  properties: {
    instrument: {
      type: "object",
      additionalProperties: false,
      required: ["symbol", "exchange", "segment", "instrumentToken"],
      properties: {
        symbol: { type: "string" },
        exchange: { type: "string" },
        segment: { type: "string" },
        instrumentToken: { type: "string" },
      },
    },
    horizon: { type: "string", enum: ["intraday", "positional"] },
    researchNotes: { type: "string" },
  },
} as const;

export function citedIdsWithinEnvelope(ids: string[], envelope: AnalysisEnvelope): boolean {
  const allowed = new Set(envelope.algo_results.map((result) => result.algo_id));
  return ids.every((id) => allowed.has(id));
}
