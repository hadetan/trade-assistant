import type { AnalysisEnvelope, IntakeResult, Verdict } from "../analysis/contracts";

export interface Provider {
  complete(envelope: AnalysisEnvelope): Promise<Verdict>;
}

export interface AiAssistedResult {
  verdict: Verdict;
  narrative: string;
}

export interface CompleteAiAssistedOptions {
  researchNotes?: string;
  onNarrativeToken: (text: string) => void;
  signal?: AbortSignal;
}

export interface AiAssistedProvider {
  intake(query: string): Promise<IntakeResult>;
  completeAiAssisted(envelope: AnalysisEnvelope, opts: CompleteAiAssistedOptions): Promise<AiAssistedResult>;
}
