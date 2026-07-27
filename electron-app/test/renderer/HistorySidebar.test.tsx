// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "../../src/renderer/HistorySidebar";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t2", preview: "how is infy" },
  { id: "s2", response_mode: "engine_only", created_at: "t", last_active_at: "t1", preview: "(no messages yet)" },
];

describe("HistorySidebar", () => {
  it("renders one entry per session showing its preview", () => {
    render(<HistorySidebar sessions={sessions} onOpenSession={vi.fn()} />);
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("(no messages yet)")).toBeTruthy();
  });

  it("calls onOpenSession with the session id when an entry is clicked", () => {
    const onOpenSession = vi.fn();
    render(<HistorySidebar sessions={sessions} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });
});
