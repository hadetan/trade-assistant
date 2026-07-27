import { HistorySidebar } from "./HistorySidebar";
import type { SessionSummary } from "../main/ipc/rendererApi";

export interface HomeScreenProps {
  sessions: SessionSummary[];
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
}

export function HomeScreen({ sessions, onNewChat, onOpenSession }: HomeScreenProps): JSX.Element {
  return (
    <section className="home-screen">
      <button type="button" onClick={onNewChat}>
        New Chat
      </button>
      <HistorySidebar sessions={sessions} onOpenSession={onOpenSession} />
    </section>
  );
}
