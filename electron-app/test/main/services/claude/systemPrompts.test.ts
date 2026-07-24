import { describe, expect, it } from "vitest";
import { WORDING_CONSTRAINT } from "../../../../src/main/services/claude/systemPrompts/wordingConstraint";
import { optionsGreeks } from "../../../../src/main/services/claude/systemPrompts/optionsGreeks";
import { technicalQuant } from "../../../../src/main/services/claude/systemPrompts/technicalQuant";
import { positionRisk } from "../../../../src/main/services/claude/systemPrompts/positionRisk";
import { synthesis } from "../../../../src/main/services/claude/systemPrompts/synthesis";
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
