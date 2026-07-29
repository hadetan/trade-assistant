import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import { fetchAndArchive } from "../kite/historicalDataArchive";
import type { AnalysisEnvelope, IntentLens } from "./contracts";
import { PERSONA_TIMEOUTS_MS } from "../claude/claudeCliProvider";
import type { TraceEmitter } from "../../ipc/rendererApi";
import type { ComputeResponseWire } from "../sidecar/sidecarProtocol";

export interface AssembleEnvelopeDeps {
  kite: KiteClient;
  sidecar: Pick<SidecarSupervisor, "compute" | "persistCandles">;
}

export interface InstrumentSelection {
  symbol: string;
  exchange: string;
  segment: string;
  instrumentToken: string;
}

export interface AssembleEnvelopeParams {
  trigger: "reactive" | "proactive_scan";
  instrument: InstrumentSelection;
  timeframe: string;
  horizon_requested: "intraday" | "positional" | "auto";
  intent_lens: IntentLens;
  from: string;
  to: string;
  onComputeId?: (id: number) => void;
  onTrace?: TraceEmitter;
}

export const KITE_FETCH_TIMEOUT_MS = 15000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

export async function assembleEnvelope(
  deps: AssembleEnvelopeDeps,
  params: AssembleEnvelopeParams,
): Promise<AnalysisEnvelope> {
  const { closes } = await withTimeout(
    fetchAndArchive(
      { kite: deps.kite, sidecar: deps.sidecar },
      {
        symbol: params.instrument.symbol,
        instrumentToken: params.instrument.instrumentToken,
        timeframe: params.timeframe,
        from: params.from,
        to: params.to,
      },
    ),
    KITE_FETCH_TIMEOUT_MS,
    "kite fetch",
  );

  let compute: ComputeResponseWire;
  try {
    compute = await withTimeout(
      deps.sidecar.compute(params.instrument.symbol, params.timeframe, closes, params.onComputeId),
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
    horizon_requested: params.horizon_requested,
    intent_lens: params.intent_lens,
    algo_results: compute.algo_results,
    confluence: compute.confluence,
    overlays: {},
  };
}
