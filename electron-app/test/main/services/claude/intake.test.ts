import { describe, expect, it, vi } from "vitest";
import { runIntake } from "../../../../src/main/services/claude/intake";
import { intake } from "../../../../src/main/services/claude/systemPrompts/intake";
import { INJECTION_DEFENSE } from "../../../../src/main/services/claude/systemPrompts/injectionDefense";
import type { PersonaRunner, PersonaRunSpec } from "../../../../src/main/services/claude/claudeCliProvider";
import { intakeResultSchema } from "../../../../src/main/services/analysis/contracts";

const validIntake = {
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
  horizon: "positional" as const,
  researchNotes: "earnings soon",
};

describe("intake prompt", () => {
  it("carries the injection-defense fragment and is wired to the intake JSON schema", () => {
    expect(intake.systemPrompt).toContain(INJECTION_DEFENSE);
    expect(intake.systemPrompt).toContain("search_instruments");
  });
});

describe("runIntake", () => {
  it("requests web tools and validates the structured intake result", async () => {
    let captured: PersonaRunSpec<unknown> | undefined;
    const runPersona: PersonaRunner = vi.fn(async (spec: PersonaRunSpec<unknown>) => {
      captured = spec;
      return validIntake as never;
    });
    const result = await runIntake({ runPersona }, "how does infosys look for a swing trade");
    expect(result).toEqual(validIntake);
    expect(captured?.allowWebTools).toBe(true);
    expect(captured?.schema).toBe(intakeResultSchema);
    expect(captured?.prompt).toContain("how does infosys look");
  });

  it("propagates the runner's retry-then-fail rejection unchanged", async () => {
    const runPersona: PersonaRunner = async () => {
      throw new Error("persona intake failed to produce valid structured output after retry");
    };
    await expect(runIntake({ runPersona }, "q")).rejects.toThrow(/failed to produce valid structured output/);
  });
});
