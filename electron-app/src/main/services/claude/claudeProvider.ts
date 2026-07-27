import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../kite/kiteClient";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

// A positive allowlist, not a subtraction from any baseline that might grow:
// Task 5's EXPECTED_KITE_TOOLS is explicitly slated to absorb the live
// tools/list surface (see mcpDriftMonitor.ts), which would include any
// currently-unnamed write tool -- deriving this allowlist from that baseline
// would silently widen it to cover a write tool the moment that happens.
// KITE_READ_TOOL_NAMES is KiteClient's own closed, hand-curated method set
// instead, so this allowlist can only ever grow when a human adds a new
// method to KiteClient itself.
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
export interface ClaudeArgOptions {
  systemPrompt?: string;
  jsonSchema?: string;
  outputFormat?: "json" | "text" | "stream-json";
  allowWebTools?: boolean;
  includePartialMessages?: boolean;
  claudeSessionId?: string;
  resumeSession?: boolean;
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
  ];
  if (opts.systemPrompt !== undefined) args.push("--system-prompt", opts.systemPrompt);
  if (opts.jsonSchema !== undefined) args.push("--json-schema", opts.jsonSchema);
  if (opts.outputFormat !== undefined) args.push("--output-format", opts.outputFormat);
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
