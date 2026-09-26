import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../kite/kiteClient";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

// A positive allowlist, not a subtraction from any baseline that might grow:
// KITE_READ_TOOL_NAMES is KiteClient's own closed, hand-curated method set,
// so this allowlist can only ever grow when a human adds a new method to
// KiteClient itself -- there is no live remote tool listing it could
// silently inherit a write tool from (the MCP-era tools/list drift check
// this comment used to reference no longer exists).
export const KITE_READ_TOOL_ALLOWLIST = Object.values(KITE_READ_TOOL_NAMES)
  .map((name) => `mcp__kite__${name}`)
  .join(",");

export const KITE_WRITE_TOOL_DENYLIST = KITE_WRITE_TOOL_NAMES.map((name) => `mcp__kite__${name}`).join(",");

export const WEB_TOOL_NAMES = ["WebSearch", "WebFetch"] as const;
export const WEB_TOOL_ALLOWLIST = WEB_TOOL_NAMES.join(",");

// No caller-supplied extra argv: Claude CLI's flag surface has aliases and
// bypass flags (--dangerously-skip-permissions, --mcp-config, hyphenated
// spellings) this module can't fully enumerate, so stripping known
// spellings from a passthrough array would itself be an incomplete
// denylist. Nothing today needs extra flags here -- when something does,
// add it as its own named parameter with its own explicit validation, not a
// passthrough array.
export const PERSONA_MODEL = "claude-haiku-4-5-20251001";

export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text" | "stream-json";
  allowWebTools?: boolean;
  includePartialMessages?: boolean;
  claudeSessionId?: string;
  resumeSession?: boolean;
  model?: string; // test-override only; defaults to PERSONA_MODEL
}

export function buildClaudeArgs(prompt: string, opts: ClaudeArgOptions = {}): string[] {
  const allowedTools = opts.allowWebTools
    ? `${KITE_READ_TOOL_ALLOWLIST},${WEB_TOOL_ALLOWLIST}`
    : KITE_READ_TOOL_ALLOWLIST;
  const args = [
    "--allowedTools",
    allowedTools,
    "--disallowedTools",
    KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
    "--model",
    opts.model ?? PERSONA_MODEL,
  ];
  if (opts.systemPrompt !== undefined) args.push("--system-prompt", opts.systemPrompt);
  if (opts.jsonSchema !== undefined) args.push("--json-schema", opts.jsonSchema);
  if (opts.outputFormat !== undefined) args.push("--output-format", opts.outputFormat);
  // The CLI rejects --print + --output-format stream-json unless --verbose is
  // also present, so this is derived from outputFormat rather than a
  // separate option callers would have to remember to set.
  if (opts.outputFormat === "stream-json") args.push("--verbose");
  if (opts.includePartialMessages) args.push("--include-partial-messages");
  if (opts.claudeSessionId !== undefined) {
    args.push(opts.resumeSession ? "--resume" : "--session-id", opts.claudeSessionId);
  }
  args.push("--print", prompt);
  return args;
}

export function spawnClaude(
  prompt: string,
  opts: ClaudeArgOptions = {},
  spawnFn: SpawnFn = (command, args) => spawn(command, args),
): ChildProcess {
  return spawnFn("claude", buildClaudeArgs(prompt, opts));
}
