import { describe, expect, it, vi } from "vitest";
import { KITE_READ_TOOL_NAMES, KITE_WRITE_TOOL_NAMES } from "../../../../src/main/services/kite/kiteClient";
import { KITE_READ_TOOL_ALLOWLIST, KITE_WRITE_TOOL_DENYLIST, buildClaudeArgs, spawnClaude } from "../../../../src/main/services/claude/claudeProvider";
import { WEB_TOOL_NAMES, WEB_TOOL_ALLOWLIST } from "../../../../src/main/services/claude/claudeProvider";
import { PERSONA_MODEL } from "../../../../src/main/services/claude/claudeProvider";

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
      "--model",
      "claude-haiku-4-5-20251001",
      "--print",
      "analyze INFY",
    ]);
  });

  it("passes the safety flags through to the spawned process argv", () => {
    const spawnFn = vi.fn().mockReturnValue({});
    spawnClaude("analyze INFY", {}, spawnFn);
    const [, argv] = spawnFn.mock.calls[0];
    expect(argv).toEqual(buildClaudeArgs("analyze INFY"));
  });

  it("appends persona flags after the three safety flags, keeping --print last", () => {
    const args = buildClaudeArgs("analyze INFY", {
      systemPrompt: "you are the technical quant persona",
      jsonSchema: '{"type":"object"}',
      outputFormat: "json",
    });

    // Three safety flags always first, in order.
    expect(args.slice(0, 5)).toEqual([
      "--allowedTools",
      KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools",
      KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
    ]);
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--json-schema");
    expect(args).toContain("--output-format");
    // --print <prompt> is always the last pair.
    expect(args.slice(-2)).toEqual(["--print", "analyze INFY"]);
  });

  it("never drops or reorders the safety flags for any persona-option combination", () => {
    const combos: Array<Parameters<typeof buildClaudeArgs>[1]> = [
      {},
      { systemPrompt: "s" },
      { jsonSchema: "{}" },
      { outputFormat: "json" },
      { systemPrompt: "s", jsonSchema: "{}", outputFormat: "json" },
    ];
    for (const opts of combos) {
      const args = buildClaudeArgs("p", opts);
      expect(args.slice(0, 5)).toEqual([
        "--allowedTools",
        KITE_READ_TOOL_ALLOWLIST,
        "--disallowedTools",
        KITE_WRITE_TOOL_DENYLIST,
        "--strict-mcp-config",
      ]);
      expect(args.slice(-2)).toEqual(["--print", "p"]);
    }
  });
});

describe("web-tool allowlist extension (additive, closed set)", () => {
  const kiteReads = Object.values(KITE_READ_TOOL_NAMES).map((n) => `mcp__kite__${n}`);

  it("grants exactly the Kite reads plus WebSearch and WebFetch when allowWebTools is true", () => {
    const args = buildClaudeArgs("analyze INFY", { allowWebTools: true });
    const allowed = new Set(args[args.indexOf("--allowedTools") + 1].split(","));
    expect(allowed).toEqual(new Set([...kiteReads, "WebSearch", "WebFetch"]));
  });

  it("never names a write tool or any other built-in tool in the web grant", () => {
    const allowed = new Set(
      buildClaudeArgs("p", { allowWebTools: true })[1].split(","),
    );
    for (const w of KITE_WRITE_TOOL_NAMES) expect(allowed.has(`mcp__kite__${w}`)).toBe(false);
    for (const t of ["Bash", "Write", "Edit", "Read", "Task", "Agent", "Glob", "Grep"]) {
      expect(allowed.has(t)).toBe(false);
    }
    expect(WEB_TOOL_ALLOWLIST).toBe("WebSearch,WebFetch");
    expect([...WEB_TOOL_NAMES]).toEqual(["WebSearch", "WebFetch"]);
  });

  it("returns byte-identical argv to today when allowWebTools is falsy (strictly additive, opt-in)", () => {
    expect(buildClaudeArgs("analyze INFY")).toEqual([
      "--allowedTools",
      KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools",
      KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
      "--model",
      "claude-haiku-4-5-20251001",
      "--print",
      "analyze INFY",
    ]);
    expect(buildClaudeArgs("analyze INFY", { allowWebTools: false })).toEqual(
      buildClaudeArgs("analyze INFY"),
    );
  });

  it("emits stream-json output format and --include-partial-messages only when asked", () => {
    const streamed = buildClaudeArgs("p", { outputFormat: "stream-json", includePartialMessages: true });
    expect(streamed).toContain("--include-partial-messages");
    expect(streamed.slice(streamed.indexOf("--output-format"), streamed.indexOf("--output-format") + 2)).toEqual([
      "--output-format",
      "stream-json",
    ]);
    expect(buildClaudeArgs("p", {})).not.toContain("--include-partial-messages");
  });

  it("keeps the three safety flags first, in order, for every new option combination", () => {
    const combos: Array<Parameters<typeof buildClaudeArgs>[1]> = [
      { allowWebTools: true },
      { outputFormat: "stream-json", includePartialMessages: true },
      { allowWebTools: true, outputFormat: "json", jsonSchema: "{}", systemPrompt: "s" },
    ];
    for (const opts of combos) {
      const args = buildClaudeArgs("p", opts);
      expect(args[0]).toBe("--allowedTools");
      expect(args[2]).toBe("--disallowedTools");
      expect(args[3]).toBe(KITE_WRITE_TOOL_DENYLIST);
      expect(args[4]).toBe("--strict-mcp-config");
      expect(args.slice(-2)).toEqual(["--print", "p"]);
    }
  });
});

describe("session continuity flags (--session-id vs --resume)", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";

  it("pins a new conversation with --session-id when resumeSession is falsy", () => {
    const args = buildClaudeArgs("p", { claudeSessionId: uuid });
    expect(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2)).toEqual(["--session-id", uuid]);
    expect(args).not.toContain("--resume");
  });

  it("resumes with --resume when both fields are set", () => {
    const args = buildClaudeArgs("p", { claudeSessionId: uuid, resumeSession: true });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", uuid]);
    expect(args).not.toContain("--session-id");
  });

  it("emits neither flag and stays byte-identical to today when claudeSessionId is absent", () => {
    expect(buildClaudeArgs("analyze INFY", { resumeSession: true })).toEqual(buildClaudeArgs("analyze INFY"));
    const args = buildClaudeArgs("p", {});
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("keeps the three safety flags first and --print last for every continuity combination", () => {
    const combos: Array<Parameters<typeof buildClaudeArgs>[1]> = [
      { claudeSessionId: uuid },
      { claudeSessionId: uuid, resumeSession: true },
      { claudeSessionId: uuid, outputFormat: "stream-json", includePartialMessages: true, systemPrompt: "s" },
    ];
    for (const opts of combos) {
      const args = buildClaudeArgs("p", opts);
      expect(args[0]).toBe("--allowedTools");
      expect(args[2]).toBe("--disallowedTools");
      expect(args[3]).toBe(KITE_WRITE_TOOL_DENYLIST);
      expect(args[4]).toBe("--strict-mcp-config");
      expect(args.slice(-2)).toEqual(["--print", "p"]);
    }
  });
});

describe("--verbose derivation for stream-json (CLI requirement)", () => {
  it("adds --verbose whenever stream-json output is requested", () => {
    const args = buildClaudeArgs("p", { outputFormat: "stream-json" });
    expect(args).toContain("--verbose");
  });

  it("does not add --verbose for buffered json output or when outputFormat is omitted", () => {
    expect(buildClaudeArgs("p", { outputFormat: "json" })).not.toContain("--verbose");
    expect(buildClaudeArgs("p", {})).not.toContain("--verbose");
    expect(buildClaudeArgs("p")).not.toContain("--verbose");
  });

  it("leaves the safety flags and --model byte-identical whether or not --verbose is emitted", () => {
    const jsonArgs = buildClaudeArgs("p", { outputFormat: "json" });
    const streamArgs = buildClaudeArgs("p", { outputFormat: "stream-json" });
    const safetyPrefix = [
      "--allowedTools",
      KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools",
      KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
      "--model",
      PERSONA_MODEL,
    ];
    expect(jsonArgs.slice(0, 7)).toEqual(safetyPrefix);
    expect(streamArgs.slice(0, 7)).toEqual(safetyPrefix);
  });
});

describe("uniform model flag", () => {
  it("defaults --model to Haiku 4.5 right after the three safety flags", () => {
    expect(PERSONA_MODEL).toBe("claude-haiku-4-5-20251001");
    const args = buildClaudeArgs("analyze INFY");
    expect(args.slice(0, 6)).toEqual([
      "--allowedTools", KITE_READ_TOOL_ALLOWLIST,
      "--disallowedTools", KITE_WRITE_TOOL_DENYLIST,
      "--strict-mcp-config",
      "--model",
    ]);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
    expect(args.slice(-2)).toEqual(["--print", "analyze INFY"]);
  });

  it("honours a test-only model override without touching the tool flags", () => {
    const args = buildClaudeArgs("p", { model: "some-other-model" });
    expect(args[args.indexOf("--model") + 1]).toBe("some-other-model");
    expect(args[0]).toBe("--allowedTools");
    expect(args[2]).toBe("--disallowedTools");
    expect(args[3]).toBe(KITE_WRITE_TOOL_DENYLIST);
  });
});
