import { PERSONA_TIMEOUTS_MS, type PersonaRunner } from "./claudeCliProvider";
import { intakeResultSchema, type IntakeResult } from "../analysis/contracts";
import { intake as intakePrompt } from "./systemPrompts/intake";
import type { TraceEmitter } from "../../ipc/rendererApi";

export interface RunIntakeDeps {
  runPersona: PersonaRunner;
}

export function runIntake(deps: RunIntakeDeps, query: string, opts?: { onTrace?: TraceEmitter }): Promise<IntakeResult> {
  return deps.runPersona<IntakeResult>({
    name: "intake",
    systemPrompt: intakePrompt.systemPrompt,
    jsonSchema: intakePrompt.outputSchema,
    schema: intakeResultSchema,
    prompt: `Resolve this request into a structured instrument + horizon. Call search_instruments to obtain the exact instrument_token; use web tools only for brief context.\n\nUser request: ${query}`,
    timeoutMs: PERSONA_TIMEOUTS_MS.intake,
    allowWebTools: true,
    onTrace: opts?.onTrace,
  });
}
