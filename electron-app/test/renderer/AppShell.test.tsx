// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../src/renderer/AppShell";
import type { AppShellProps } from "../../src/renderer/AppShell";
import type { AppStatus, BannerEvent, SessionSummary } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const STATUS: AppStatus = { sidecar: "up", kiteSession: "needsLogin", driftWarning: null };
const SESSIONS: SessionSummary[] = [
  { id: "s1", response_mode: "ai_assisted", created_at: "t", last_active_at: new Date().toISOString(), preview: "how is infy" },
];

function renderShell(overrides: Partial<AppShellProps> = {}) {
  const onNewSession = vi.fn();
  const onOpenSession = vi.fn();
  const onOpenBenchmark = vi.fn();
  const utils = render(
    <AppShell
      status={STATUS}
      banners={[]}
      sessions={SESSIONS}
      activeSessionId={null}
      benchmarkActive={false}
      onNewSession={onNewSession}
      onOpenSession={onOpenSession}
      onOpenBenchmark={onOpenBenchmark}
      {...overrides}
    >
      <div>content</div>
    </AppShell>,
  );
  return { ...utils, onNewSession, onOpenSession, onOpenBenchmark };
}

describe("AppShell", () => {
  it("renders the sidebar header, nav, history, footer, and the content pane children", () => {
    renderShell();
    expect(screen.getByText("Trade Assistant")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /benchmark/i })).toBeTruthy();
    expect(screen.getByText("how is infy")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("calls onNewSession, onOpenBenchmark, and onOpenSession", () => {
    const { onNewSession, onOpenBenchmark, onOpenSession } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /benchmark/i }));
    expect(onOpenBenchmark).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("how is infy"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("renders one error Banner per pushed sidecarDown banner, above the content pane", () => {
    const banners: BannerEvent[] = [{ kind: "sidecarDown", message: "sidecar unreachable" }];
    renderShell({ banners });
    expect(screen.getByText("sidecar unreachable")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders a warning Banner for kiteLogin/mcpDrift banners", () => {
    const banners: BannerEvent[] = [{ kind: "kiteLogin", message: "please log in" }];
    renderShell({ banners });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("maps sidecar/Kite status to StatusDot labels in the footer", () => {
    renderShell({ status: { sidecar: "down", kiteSession: "authenticated", driftWarning: null } });
    expect(screen.getByText(/sidecar down/i)).toBeTruthy();
    expect(screen.getByText(/kite authenticated/i)).toBeTruthy();
  });

  it("still reports the sidecar as down with the error tone once status is known", () => {
    const { container } = renderShell({ status: { sidecar: "down", kiteSession: "authenticated", driftWarning: null } });
    expect(container.querySelector(".status-dot-error")).toBeTruthy();
  });

  it("shows a loading tone, not an error tone, for the footer status dots before status has loaded", () => {
    const { container } = renderShell({ status: null });
    expect(screen.getByText(/sidecar …/i)).toBeTruthy();
    expect(screen.getByText(/kite …/i)).toBeTruthy();
    expect(container.querySelector(".status-dot-error")).toBeNull();
  });

  it("renders dark by default and flips the app root's data-theme when the theme toggle is clicked", () => {
    const { container } = renderShell();
    const root = container.querySelector(".app-shell") as HTMLElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("marks the benchmark nav item active when benchmarkActive is true", () => {
    renderShell({ benchmarkActive: true });
    expect(screen.getByRole("button", { name: /benchmark/i }).className).toContain("app-nav-item-active");
  });
});
