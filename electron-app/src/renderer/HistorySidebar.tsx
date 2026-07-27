import type { SessionSummary } from "../main/ipc/rendererApi";

export interface HistorySidebarProps {
  sessions: SessionSummary[];
  onOpenSession: (id: string) => void;
}

export function HistorySidebar({ sessions, onOpenSession }: HistorySidebarProps): JSX.Element {
  return (
    <ul className="history-sidebar">
      {sessions.map((session) => (
        <li key={session.id}>
          <button type="button" className={`session session-${session.response_mode}`} onClick={() => onOpenSession(session.id)}>
            <span className="session-mode">{session.response_mode}</span>
            <span className="session-preview">{session.preview}</span>
            <span className="session-active-at">{session.last_active_at}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
