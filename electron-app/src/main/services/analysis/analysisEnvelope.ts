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
