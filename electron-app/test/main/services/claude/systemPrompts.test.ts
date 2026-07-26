import { describe, expect, it } from "vitest";
import { WORDING_CONSTRAINT } from "../../../../src/main/services/claude/systemPrompts/wordingConstraint";
import { optionsGreeks } from "../../../../src/main/services/claude/systemPrompts/optionsGreeks";
import { technicalQuant } from "../../../../src/main/services/claude/systemPrompts/technicalQuant";
import { positionRisk } from "../../../../src/main/services/claude/systemPrompts/positionRisk";
import { synthesis } from "../../../../src/main/services/claude/systemPrompts/synthesis";
import { INJECTION_DEFENSE } from "../../../../src/main/services/claude/systemPrompts/injectionDefense";
import { INTENT_LENS_FRAMING } from "../../../../src/main/services/claude/systemPrompts/intentLensFraming";
import {
  personaFindingJsonSchema,
  verdictJsonSchema,
} from "../../../../src/main/services/analysis/contracts";

describe("persona system prompts", () => {
  const analytical = [optionsGreeks, technicalQuant, positionRisk];

  it("embeds the single shared wording constraint in every persona", () => {
    for (const persona of [...analytical, synthesis]) {
      expect(persona.systemPrompt).toContain(WORDING_CONSTRAINT);
    }
  });

  it("forbids imperative directives in the shared constraint text", () => {
    expect(WORDING_CONSTRAINT.toLowerCase()).toContain("bullish");
    expect(WORDING_CONSTRAINT.toLowerCase()).toContain("never");
    expect(WORDING_CONSTRAINT).toMatch(/imperative|instruction/i);
  });

  it("mandates algo_id citation in every persona", () => {
    for (const persona of [...analytical, synthesis]) {
      expect(persona.systemPrompt).toContain("algo_id");
    }
  });

  it("wires the analytical personas to the PersonaFinding schema and synthesis to the Verdict schema", () => {
    for (const persona of analytical) {
      expect(persona.outputSchema).toBe(personaFindingJsonSchema);
    }
    expect(synthesis.outputSchema).toBe(verdictJsonSchema);
  });
});

describe("shared injection-defense and intent-lens fragments", () => {
  const analytical = [optionsGreeks, technicalQuant, positionRisk];

  it("names fetched/web content as untrusted data, never instructions", () => {
    expect(INJECTION_DEFENSE.toLowerCase()).toContain("untrusted");
    expect(INJECTION_DEFENSE).toMatch(/WebSearch|WebFetch|fetched/);
    expect(INJECTION_DEFENSE.toLowerCase()).toMatch(/never .*instruction|not .*instruction/);
  });

  it("frames intent_lens as the user's stance, never a recommendation", () => {
    expect(INTENT_LENS_FRAMING).toMatch(/intent_lens/);
    expect(INTENT_LENS_FRAMING.toLowerCase()).toContain("buying");
    expect(INTENT_LENS_FRAMING.toLowerCase()).toContain("selling");
    expect(INTENT_LENS_FRAMING.toLowerCase()).toMatch(/never an instruction|not an instruction/);
  });

  it("embeds INJECTION_DEFENSE in every web-touching analytical persona and synthesis", () => {
    for (const persona of [...analytical, synthesis]) {
      expect(persona.systemPrompt).toContain(INJECTION_DEFENSE);
    }
  });

  it("embeds INTENT_LENS_FRAMING in the three analytical personas only", () => {
    for (const persona of analytical) expect(persona.systemPrompt).toContain(INTENT_LENS_FRAMING);
    expect(synthesis.systemPrompt).not.toContain(INTENT_LENS_FRAMING);
  });
});
