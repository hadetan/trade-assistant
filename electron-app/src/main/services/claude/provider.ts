import type { AnalysisEnvelope, Verdict } from "../analysis/contracts";

export interface Provider {
  complete(envelope: AnalysisEnvelope): Promise<Verdict>;
}
