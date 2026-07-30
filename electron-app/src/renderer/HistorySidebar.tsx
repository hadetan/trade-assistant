import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import { Inbox } from "./ui/icons";
import "./HistorySidebar.css";
import type { AnalysisMode, SessionSummary } from "../main/ipc/rendererApi";

export interface HistorySidebarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
}

const MODE_LABEL: Record<AnalysisMode, string> = { ai_assisted: "AI-Assisted", engine_only: "Engine-Only" };

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function HistorySidebar({ sessions, activeSessionId, onOpenSession }: HistorySidebarProps): JSX.Element {
  if (sessions.length === 0) {
    return <EmptyState icon={Inbox} message="No sessions yet — start a new one." />;
  }
  return (
    <ul className="history-sidebar">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={`history-row${session.id === activeSessionId ? " history-row-active" : ""}`}
            onClick={() => onOpenSession(session.id)}
          >
            <Badge tone="neutral">{MODE_LABEL[session.response_mode]}</Badge>
            <span className="history-row-preview">{session.preview}</span>
            <span className="history-row-time">{relativeTime(session.last_active_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
