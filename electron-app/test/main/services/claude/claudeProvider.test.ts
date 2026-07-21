import { describe, expect, it, vi } from "vitest";
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../../../../src/main/services/kite/kiteClient";
import { KITE_READ_TOOL_ALLOWLIST, KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "../../../../src/main/services/claude/claudeProvider";

describe("claude subprocess scaffolding", () => {
  it("allowlists exactly KiteClient's own read tool set and nothing else", () => {
    expect(KITE_READ_TOOL_ALLOWLIST).toBe(
      Object.values(KITE_READ_TOOL_NAMES)
        .map((name) => `mcp__kite__${name}`)
        .join(","),
    );
    for (const writeName of KITE_WRITE_TOOL_NAMES) {
      expect(KITE_READ_TOOL_ALLOWLIST).not.toContain(`mcp__kite__${writeName}`);
    }
  });

  it("names all six write tools in the denylist", () => {
    expect(KITE_WRITE_TOOL_DENYLIST).toBe(
      "mcp__kite__place_order,mcp__kite__modify_order,mcp__kite__cancel_order,mcp__kite__place_gtt_order,mcp__kite__modify_gtt_order,mcp__kite__delete_gtt_order",
    );
  });

  it("builds exactly the fixed safety flags plus the prompt, nothing else", () => {
    expect(buildClaudeArgs("analyze INFY")).toEqual([
      "--allowedTools",
      KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools",
      KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
      "--print",
      "analyze INFY",
    ]);
  });

  it("passes the safety flags through to the spawned process argv", () => {
    const spawnFn = vi.fn().mockReturnValue({});
    spawnClaude("analyze INFY", spawnFn);
    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(buildClaudeArgs("analyze INFY"));
  });
});
