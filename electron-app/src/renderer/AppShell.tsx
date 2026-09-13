import type { ReactNode } from "react";
import "./AppShell.css";
import { HistorySidebar } from "./HistorySidebar";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/StatusDot";
import type { StatusDotTone } from "./ui/StatusDot";
import { Banner } from "./ui/Banner";
import type { BannerVariant } from "./ui/Banner";
import { ThemeToggle, useChatTheme } from "./ThemeToggle";
import { BarChart3, Plus } from "./ui/icons";
import type { AppStatus, BannerEvent, BannerKind, KiteSessionStatus, SessionSummary, SidecarStatus } from "../main/ipc/rendererApi";

export interface AppShellProps {
  status: AppStatus | null;
  banners: BannerEvent[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  benchmarkActive: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onOpenBenchmark: () => void;
  children: ReactNode;
}

function sidecarTone(status: SidecarStatus | undefined): StatusDotTone {
  if (status === "up") return "done";
  // undefined means the initial getStatus() call hasn't resolved yet — that's a
  // loading state, not a failure, so it reads the same as an active restart.
  if (status === "restarting" || status === undefined) return "running";
  return "error";
}

function kiteTone(status: KiteSessionStatus | undefined): StatusDotTone {
  if (status === "authenticated") return "done";
  if (status === "needsLogin" || status === "unknown" || status === undefined) return "running";
  return "error";
}

function bannerVariant(kind: BannerKind): BannerVariant {
  return kind === "sidecarDown" ? "error" : "warning";
}

export function AppShell({
  status,
  banners,
  sessions,
  activeSessionId,
  benchmarkActive,
  onNewSession,
  onOpenSession,
  onOpenBenchmark,
  children,
}: AppShellProps): JSX.Element {
  const [theme, toggleTheme] = useChatTheme();

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="app-sidebar">
        <div className="app-sidebar-header">
          <div className="app-brand">Trade Assistant</div>
          <Button className="app-sidebar-new" onClick={onNewSession}>
            <Plus size={16} aria-hidden="true" /> New session
          </Button>
        </div>
        <nav className="app-sidebar-nav">
          <button
            type="button"
            className={`app-nav-item${benchmarkActive ? " app-nav-item-active" : ""}`}
            onClick={onOpenBenchmark}
          >
            <BarChart3 size={16} aria-hidden="true" /> Benchmark
          </button>
        </nav>
        <div className="app-sidebar-body">
          <HistorySidebar sessions={sessions} activeSessionId={activeSessionId} onOpenSession={onOpenSession} />
        </div>
        <div className="app-sidebar-footer">
          <StatusDot tone={sidecarTone(status?.sidecar)} label={`Sidecar ${status?.sidecar ?? "…"}`} />
          <StatusDot tone={kiteTone(status?.kiteSession)} label={`Kite ${status?.kiteSession ?? "…"}`} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </aside>
      <main className="app-content">
        {banners.length > 0 && (
          <div className="app-banners">
            {banners.map((banner, index) => (
              <Banner key={index} variant={bannerVariant(banner.kind)}>
                {banner.message}
              </Banner>
            ))}
          </div>
        )}
        <div className="app-content-pane">{children}</div>
      </main>
    </div>
  );
}
