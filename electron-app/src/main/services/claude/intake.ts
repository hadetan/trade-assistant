import type { PersonaRunner } from "./claudeCliProvider";
import { intakeResultSchema, type IntakeResult } from "../analysis/contracts";
import { intake as intakePrompt } from "./systemPrompts/intake";

export interface RunIntakeDeps {
  runPersona: PersonaRunner;
}

export function runIntake(deps: RunIntakeDeps, query: string): Promise<IntakeResult> {
  return deps.runPersona<IntakeResult>({
    name: "intake",
    systemPrompt: intakePrompt.systemPrompt,
    jsonSchema: intakePrompt.outputSchema,
    schema: intakeResultSchema,
    prompt: `Resolve this request into a structured instrument + horizon. Call search_instruments to obtain the exact instrument_token; use web tools only for brief context.\n\nUser request: ${query}`,
    allowWebTools: true,
  });
}
