import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ZodType } from "zod";
import { spawnClaude } from "./claudeProvider";
import type { AnalysisEnvelope, IntakeResult, Verdict } from "../analysis/contracts";
import type { AiAssistedProvider, AiAssistedResult, CompleteAiAssistedOptions, Provider } from "./provider";
import { runPipeline, runPersonaPipeline, narrativePrompt, type PipelinePrompts } from "./personaPipeline";
import { makeNarrativeStreamer, type NarrativeStreamSpec } from "./streamingNarrative";
import { runIntake } from "./intake";
import { optionsGreeks } from "./systemPrompts/optionsGreeks";
import { technicalQuant } from "./systemPrompts/technicalQuant";
import { positionRisk } from "./systemPrompts/positionRisk";
import { synthesis } from "./systemPrompts/synthesis";
import { narrative } from "./systemPrompts/narrative";
import type { TraceSource } from "../../ipc/rendererApi";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface PersonaRunSpec<T> {
  name: TraceSource;
  systemPrompt: string;
  jsonSchema: object;
  schema: ZodType<T>;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  allowWebTools?: boolean;
}

export type PersonaRunner = <T>(spec: PersonaRunSpec<T>) => Promise<T>;

export interface ClaudeRunnerOptions {
  spawnFn?: SpawnFn;
}

export const PERSONA_TIMEOUTS_MS: Record<TraceSource, number> = {
  sidecar: 20000, // used by P9A§7's compute bound, kept here for co-location
  intake: 20000,
  options_greeks: 45000,
  technical_quant: 45000,
  position_risk: 45000,
  synthesis: 25000,
  narrative: 60000,
};

function readResult(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (error: Error) => reject(error));
    child.on("exit", (code: number | null) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout) as { structured_output?: unknown };
        resolve(envelope.structured_output);
      } catch {
        resolve(undefined);
      }
    });
  });
}

// The runner owns the safety-critical subprocess path: every call routes
// through spawnClaude (Task 7), so the allowlist/denylist cannot be bypassed.
export function makeClaudeRunner(options: ClaudeRunnerOptions = {}): PersonaRunner {
  const spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args));

  return async <T>(spec: PersonaRunSpec<T>): Promise<T> => {
    const attempt = async (prompt: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      if (spec.signal?.aborted) {
        throw new Error(`persona ${spec.name} aborted`);
      }
      const child = spawnClaude(
        prompt,
        {
          systemPrompt: spec.systemPrompt,
          jsonSchema: JSON.stringify(spec.jsonSchema),
          outputFormat: "json",
          allowWebTools: spec.allowWebTools,
        },
        spawnFn,
      );
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      // Reject BEFORE killing: killing the child emits `exit`, which would
      // otherwise let readResult settle the race with `undefined` first and
      // swallow the timeout/abort rejection.
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`persona ${spec.name} timed out after ${spec.timeoutMs}ms`));
          child.kill();
        }, spec.timeoutMs);
        onAbort = () => {
          reject(new Error(`persona ${spec.name} aborted`));
          child.kill();
        };
        spec.signal?.addEventListener("abort", onAbort);
      });
      let raw: unknown;
      try {
        raw = await Promise.race([readResult(child), guard]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) spec.signal?.removeEventListener("abort", onAbort);
      }
      const parsed = spec.schema.safeParse(raw);
      if (parsed.success) return { ok: true, value: parsed.data };
      return { ok: false, error: parsed.error.message };
    };

    const first = await attempt(spec.prompt);
    if (first.ok) return first.value;

    const corrective = `${spec.prompt}\n\nYour previous reply did not match the required JSON schema (${first.error}). Reply with only a JSON object conforming to it.`;
    const second = await attempt(corrective);
    if (second.ok) return second.value;

    throw new Error(`persona ${spec.name} failed to produce valid structured output after retry`);
  };
}

const DEFAULT_PROMPTS: PipelinePrompts = {
  optionsGreeks,
  technicalQuant,
  positionRisk,
  synthesis,
};

export interface ClaudeCliProviderOptions {
  spawnFn?: SpawnFn;
  streamNarrative?: (spec: NarrativeStreamSpec) => Promise<string>;
}

export class ClaudeCliProvider implements Provider, AiAssistedProvider {
  private readonly runPersona: PersonaRunner;
  private readonly streamNarrative: (spec: NarrativeStreamSpec) => Promise<string>;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.runPersona = makeClaudeRunner({ spawnFn: options.spawnFn });
    this.streamNarrative = options.streamNarrative ?? makeNarrativeStreamer({ spawnFn: options.spawnFn });
  }

  complete(envelope: AnalysisEnvelope): Promise<Verdict> {
    return runPipeline(envelope, { runPersona: this.runPersona, prompts: DEFAULT_PROMPTS });
  }

  intake(query: string): Promise<IntakeResult> {
    return runIntake({ runPersona: this.runPersona }, query);
  }

  async completeAiAssisted(envelope: AnalysisEnvelope, opts: CompleteAiAssistedOptions): Promise<AiAssistedResult> {
    const { verdict, findings } = await runPersonaPipeline(
      envelope,
      { runPersona: this.runPersona, prompts: DEFAULT_PROMPTS },
      { researchNotes: opts.researchNotes },
    );
    const narrativeText = await this.streamNarrative({
      systemPrompt: narrative.systemPrompt,
      prompt: narrativePrompt(verdict, findings, envelope.intent_lens, opts.researchNotes),
      onToken: opts.onNarrativeToken,
      timeoutMs: PERSONA_TIMEOUTS_MS.narrative,
      signal: opts.signal,
      claudeSessionId: opts.claudeSessionId,
      resumeSession: opts.resumeSession,
    });
    return { verdict, narrative: narrativeText };
  }
}
