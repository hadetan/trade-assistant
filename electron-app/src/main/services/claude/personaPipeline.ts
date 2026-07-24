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
