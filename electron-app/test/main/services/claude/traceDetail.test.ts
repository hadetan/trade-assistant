import { describe, expect, it } from "vitest";
import { TRACE_DETAIL_MAX, summarizeForTrace } from "../../../../src/main/services/claude/traceDetail";

describe("summarizeForTrace", () => {
  it("caps at 200 chars by default", () => {
    expect(TRACE_DETAIL_MAX).toBe(200);
  });
  it("collapses whitespace runs to a single space and trims", () => {
    expect(summarizeForTrace("  a\n\t  b   c  ")).toBe("a b c");
  });
  it("returns short text unchanged", () => {
    expect(summarizeForTrace("hello")).toBe("hello");
  });
  it("truncates with an explicit suffix naming the full length", () => {
    const raw = "x".repeat(250);
    expect(summarizeForTrace(raw)).toBe(`${"x".repeat(200)}… (truncated, 250 chars)`);
  });
});
