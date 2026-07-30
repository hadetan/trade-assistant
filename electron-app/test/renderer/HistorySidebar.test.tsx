// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySidebar } from "../../src/renderer/HistorySidebar";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: new Date().toISOString(), preview: "how is infy" },
  { id: "s2", response_mode: "engine_only", created_at: "t", last_active_at: new Date().toISOString(), preview: "(no messages yet)" },
];

describe("HistorySidebar", () => {
  it("renders one row per session showing its preview and mode label", () => {
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={vi.fn()} />);
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("(no messages yet)")).toBeTruthy();
    expect(screen.getByText("AI-Assisted")).toBeTruthy();
    expect(screen.getByText("Engine-Only")).toBeTruthy();
  });

  it("calls onOpenSession with the session id when a row is clicked", () => {
    const onOpenSession = vi.fn();
    render(<HistorySidebar sessions={sessions} activeSessionId={null} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("marks the active session's row with the active class and leaves the rest unmarked", () => {
    render(<HistorySidebar sessions={sessions} activeSessionId="s2" onOpenSession={vi.fn()} />);
    expect(screen.getByRole("button", { name: /engine-only/i }).className).toContain("history-row-active");
    expect(screen.getByRole("button", { name: /ai-assisted/i }).className).not.toContain("history-row-active");
  });

  it("renders an EmptyState instead of a list when there are no sessions", () => {
    render(<HistorySidebar sessions={[]} activeSessionId={null} onOpenSession={vi.fn()} />);
    expect(screen.getByText("No sessions yet — start a new one.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
