import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { AnalysisEnvelope, IntentLens } from "./contracts";
import type { InstrumentSelection } from "./analysisEnvelope";
import type { TraceEmitter } from "../../ipc/rendererApi";
import type { CandleInterval } from "../market/candleInterval";
import type { WarmedCandles } from "../market/readinessGate";
import { maxRequiredLookback } from "../market/backfillSizing";
import { PERSONA_TIMEOUTS_MS } from "../claude/claudeCliProvider";
import { withTimeout } from "./analysisEnvelope";

export interface WarmedEnvelopeDeps {
  sidecar: Pick<SidecarSupervisor, "compute">;
}

export interface WarmedEnvelopeParams {
  trigger: "reactive" | "proactive_scan";
  instrument: InstrumentSelection;
  interval: CandleInterval;
  intent_lens: IntentLens;
  onComputeId?: (id: number) => void;
  onTrace?: TraceEmitter;
}

// Sized against EVERY linked algorithm, not just the forecasters: a build with no
// forecaster feature compiled in would otherwise report 0 and starve the fast
// indicators that do work (plan open item (iii)).
export async function requiredBarsFor(sidecar: Pick<SidecarSupervisor, "listAlgorithms">): Promise<number> {
  const { algorithms } = await sidecar.listAlgorithms();
  return maxRequiredLookback(algorithms.map((a) => ({ requiredLookback: a.required_lookback })));
}

// `warmed` is produced by checkEngineOnlyReadiness's successful gate check, not
// re-fetched here -- the gate already ran the exact same Kite fetch and lake
// read/write for this symbol/interval to prove enough history exists.
export async function assembleWarmedEnvelope(
  deps: WarmedEnvelopeDeps,
  params: WarmedEnvelopeParams,
  warmed: WarmedCandles,
): Promise<AnalysisEnvelope> {
  const window = warmed.candles.slice(Math.max(0, warmed.candles.length - warmed.requiredBars));

  let compute;
  try {
    compute = await withTimeout(
      deps.sidecar.compute(params.instrument.symbol, params.interval, "intraday", window, params.onComputeId),
      PERSONA_TIMEOUTS_MS.sidecar,
      "sidecar compute",
    );
  } catch (error) {
    params.onTrace?.({ source: "sidecar", kind: "error", detail: (error as Error).message });
    throw error;
  }

  return {
    trigger: params.trigger,
    instrument: {
      symbol: params.instrument.symbol,
      exchange: params.instrument.exchange,
      segment: params.instrument.segment,
      kite_token_asof: params.instrument.instrumentToken,
    },
    horizon_requested: "intraday",
    intent_lens: params.intent_lens,
    algo_results: compute.algo_results,
    confluence: compute.confluence,
    overlays: {},
  };
}
