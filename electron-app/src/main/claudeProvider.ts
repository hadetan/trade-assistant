import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { KITE_WRITE_TOOL_NAMES } from "./kiteClient";
import { EXPECTED_KITE_TOOLS } from "./mcpDriftMonitor";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

const writeToolNames = new Set<string>(KITE_WRITE_TOOL_NAMES);

// Kite's live MCP server exposes tools beyond what's individually named here
// (Task 4/5 review: MF-order/SIP/position-conversion write tools exist and
// aren't in KITE_WRITE_TOOL_NAMES) -- and unlike KiteClient's closed method
// set, the claude subprocess connects to the server's FULL live tool surface,
// so a denylist of only 6 names can't structurally rule out an unnamed write
// tool. --allowedTools flips this to an allowlist: only the read tools named
// here (and nothing else -- no Bash/Write/Edit/other MCP servers) are
// reachable, so any tool not on this list, named or not, is unreachable by
// construction. The denylist stays as defense-in-depth on top of that.
export const KITE_READ_TOOL_ALLOWLIST = EXPECTED_KITE_TOOLS.filter((name) => !writeToolNames.has(name))
  .map((name) => `mcp__kite__${name}`)
  .join(",");

export const KITE_WRITE_TOOL_DENYLIST = KITE_WRITE_TOOL_NAMES.map((name) => `mcp__kite__${name}`).join(",");

const SAFETY_FLAGS_WITH_VALUE = new Set(["--allowedTools", "--disallowedTools"]);
const SAFETY_FLAGS_WITHOUT_VALUE = new Set(["--strict-mcp-config"]);

// Claude CLI's precedence when a flag is repeated is undocumented (last-wins
// is documented for MCP server lists, but untested for tool-permission
// flags) -- rather than depend on that, strip any of these three flags (and,
// for the two that take a value, the value after them) out of caller-
// supplied extraArgs, so our safety flags are the ONLY occurrence in the
// final argv and no parser ambiguity can widen them.
function stripSafetyFlags(extraArgs: string[]): string[] {
  const sanitized: string[] = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    if (SAFETY_FLAGS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (SAFETY_FLAGS_WITHOUT_VALUE.has(arg)) {
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

export function buildClaudeArgs(prompt: string, extraArgs: string[] = []): string[] {
  return [
    "--allowedTools",
    KITE_READ_TOOL_ALLOWLIST,
    "--disallowedTools",
    KITE_WRITE_TOOL_DENYLIST,
    "--strict-mcp-config",
    ...stripSafetyFlags(extraArgs),
    "--print",
    prompt,
  ];
}

export function spawnClaude(
  prompt: string,
  extraArgs: string[] = [],
  spawnFn: SpawnFn = (command, args) => spawn(command, args),
): ChildProcess {
  return spawnFn("claude", buildClaudeArgs(prompt, extraArgs));
}
