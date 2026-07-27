// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "../../src/renderer/HomeScreen";
import type { SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: "t2", preview: "how is infy" },
];

describe("HomeScreen", () => {
  it("offers New Chat and lists existing sessions", () => {
    const onNewChat = vi.fn();
    render(<HomeScreen sessions={sessions} onNewChat={onNewChat} onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText("how is infy")).toBeTruthy();
  });

  it("forwards a session click to onOpenSession", () => {
    const onOpenSession = vi.fn();
    render(<HomeScreen sessions={sessions} onNewChat={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });
});
