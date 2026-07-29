// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActivityPanel } from "../../src/renderer/AgentActivityPanel";
import type { TraceEvent } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

describe("AgentActivityPanel", () => {
  it("renders nothing for an empty trace (engine_only turns carry none)", () => {
    const { container } = render(<AgentActivityPanel trace={[]} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a trace containing only narrative tokens", () => {
    const trace: TraceEvent[] = [{ requestId: "r1", source: "narrative", kind: "token", detail: "hi", at: "t" }];
    const { container } = render(<AgentActivityPanel trace={trace} live={true} />);
    expect(container.firstChild).toBeNull();
  });

  it("opens by default while live and renders one lane per started source", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    render(<AgentActivityPanel trace={trace} live={true} />);
    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.getByText("Intake")).toBeTruthy();
    expect(screen.getByText("▾")).toBeTruthy();
  });

  it("collapses by default on history replay (live=false) and expands on click", () => {
    const trace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    render(<AgentActivityPanel trace={trace} live={false} />);
    expect(screen.queryByText("Intake")).toBeNull();
    fireEvent.click(screen.getByText("Agent activity"));
    expect(screen.getByText("Intake")).toBeTruthy();
  });

  it("re-renders correctly when trace transitions from empty to populated", () => {
    const emptyTrace: TraceEvent[] = [];
    const { container, rerender } = render(<AgentActivityPanel trace={emptyTrace} live={true} />);
    expect(container.firstChild).toBeNull();

    const populatedTrace: TraceEvent[] = [
      { requestId: "r1", source: "intake", kind: "started", at: "t" },
      { requestId: "r1", source: "intake", kind: "done", at: "t" },
    ];
    rerender(<AgentActivityPanel trace={populatedTrace} live={true} />);

    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.getByText("Intake")).toBeTruthy();
  });
});
