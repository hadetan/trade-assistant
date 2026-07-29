import type { AnalysisEnvelope, IntakeResult, Verdict } from "../analysis/contracts";
import type { TraceEmitter } from "../../ipc/rendererApi";

export interface Provider {
  complete(envelope: AnalysisEnvelope): Promise<Verdict>;
}

export interface AiAssistedResult {
  verdict: Verdict;
  narrative: string;
}

export interface CompleteAiAssistedOptions {
  researchNotes?: string;
  onTrace: TraceEmitter;
  signal?: AbortSignal;
  claudeSessionId: string;
  resumeSession: boolean;
}

export interface AiAssistedProvider {
  intake(query: string, opts?: { onTrace?: TraceEmitter }): Promise<IntakeResult>;
  completeAiAssisted(envelope: AnalysisEnvelope, opts: CompleteAiAssistedOptions): Promise<AiAssistedResult>;
}
