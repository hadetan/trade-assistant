// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceStepRow } from "../../src/renderer/TraceStepRow";
import type { LaneNode } from "../../src/renderer/AgentActivityPanel";

afterEach(cleanup);

function lane(status: LaneNode["status"], children: LaneNode["children"] = []): LaneNode {
  return { kind: "lane", source: "intake", label: "Intake", status, children };
}

describe("TraceStepRow", () => {
  it("auto-expands a running row and shows its children while live", () => {
    const node = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("⟳")).toBeTruthy();
    expect(screen.getByText("Read {}")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("auto-collapses a done row while live", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("✓")).toBeTruthy();
    expect(screen.queryByText("Read {}")).toBeNull();
    expect(screen.getByText("▸")).toBeTruthy();
  });

  it("stays expanded on error while live", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    render(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("✗")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("lets a manual expand override auto-collapse on a done row, and the override persists across a same-status re-render", () => {
    const node = lane("done", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={node} live={true} />);
    expect(screen.queryByText("Read {}")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Read {}")).toBeTruthy();
    rerender(<TraceStepRow node={node} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();
  });

  it("reverts a manual collapse back to auto-expand when a running row transitions to error", () => {
    const runningNode = lane("running", [{ kind: "tool", variant: "toolCall", detail: "Read {}" }]);
    const { rerender } = render(<TraceStepRow node={runningNode} live={true} />);
    expect(screen.getByText("Read {}")).toBeTruthy();

    fireEvent.click(screen.getByRole("button")); // manual collapse while running
    expect(screen.queryByText("Read {}")).toBeNull();

    const erroredNode = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    rerender(<TraceStepRow node={erroredNode} live={true} />);
    expect(screen.getByText("boom")).toBeTruthy(); // status transitioned; auto takes back over and re-expands
  });

  it("renders every row collapsed by default in history replay (live=false), even an errored one, until manually toggled", () => {
    const node = lane("error", [{ kind: "tool", variant: "toolResult", detail: "boom" }]);
    render(<TraceStepRow node={node} live={false} />);
    expect(screen.queryByText("boom")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("disables the toggle button and shows no caret for a childless algo leaf", () => {
    const node = { kind: "algo" as const, label: "rsi", status: "done" as const };
    render(<TraceStepRow node={node} live={false} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("▾")).toBeNull();
    expect(screen.queryByText("▸")).toBeNull();
  });
});
