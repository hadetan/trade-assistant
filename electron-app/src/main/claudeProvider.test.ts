import { describe, expect, it, vi } from "vitest";
import { KITE_WRITE_TOOL_NAMES } from "./kiteClient";
import { EXPECTED_KITE_TOOLS } from "./mcpDriftMonitor";
import { KITE_READ_TOOL_ALLOWLIST, KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "./claudeProvider";

function assertSafetyFlagsPresentExactlyOnce(args: string[]): void {
  expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
  expect(args.filter((a) => a === "--disallowedTools")).toHaveLength(1);
  expect(args.filter((a) => a === "--strict-mcp-config")).toHaveLength(1);

  const allowIndex = args.indexOf("--allowedTools");
  expect(args[allowIndex + 1]).toBe(KITE_READ_TOOL_ALLOWLIST);

  const denyIndex = args.indexOf("--disallowedTools");
  expect(args[denyIndex + 1]).toBe(KITE_WRITE_TOOL_DENYLIST);
}

describe("claude subprocess scaffolding", () => {
  it("allowlists every known Kite read tool and nothing else", () => {
    const writeNames = new Set<string>(KITE_WRITE_TOOL_NAMES);
    const expectedReadNames = EXPECTED_KITE_TOOLS.filter((name) => !writeNames.has(name));
    expect(KITE_READ_TOOL_ALLOWLIST).toBe(expectedReadNames.map((name) => `mcp__kite__${name}`).join(","));
    for (const writeName of KITE_WRITE_TOOL_NAMES) {
      expect(KITE_READ_TOOL_ALLOWLIST).not.toContain(`mcp__kite__${writeName}`);
    }
  });

  it("names all six write tools in the denylist", () => {
    expect(KITE_WRITE_TOOL_DENYLIST).toBe(
      "mcp__kite__place_order,mcp__kite__modify_order,mcp__kite__cancel_order,mcp__kite__place_gtt_order,mcp__kite__modify_gtt_order,mcp__kite__delete_gtt_order",
    );
  });

  it("always includes exactly one allowlist, denylist, and strict-mcp-config flag for a plain prompt", () => {
    assertSafetyFlagsPresentExactlyOnce(buildClaudeArgs("analyze INFY"));
  });

  it("strips a caller-supplied --allowedTools attempting to re-allow a write tool, instead of appending a second occurrence", () => {
    const args = buildClaudeArgs("analyze INFY", ["--allowedTools", "mcp__kite__place_order"]);
    assertSafetyFlagsPresentExactlyOnce(args);
    expect(args).not.toContain("mcp__kite__place_order");
  });

  it("strips caller-supplied --disallowedTools/--strict-mcp-config duplicates too, leaving other extra args intact", () => {
    const args = buildClaudeArgs("analyze INFY", [
      "--disallowedTools",
      "mcp__kite__cancel_order",
      "--strict-mcp-config",
      "--some-other-flag",
    ]);
    assertSafetyFlagsPresentExactlyOnce(args);
    expect(args).toContain("--some-other-flag");
  });

  it("passes the safety flags through to the spawned process argv", () => {
    const spawnFn = vi.fn().mockReturnValue({});
    spawnClaude("analyze INFY", [], spawnFn);
    const [, argv] = spawnFn.mock.calls[0];
    assertSafetyFlagsPresentExactlyOnce(argv);
  });
});
