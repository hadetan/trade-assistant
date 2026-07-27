import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { AnalysisMode } from "../../ipc/rendererApi";

export type MessageRole = "user" | "assistant";

export interface SessionSummary {
  id: string;
  response_mode: AnalysisMode;
  created_at: string;
  last_active_at: string;
  preview: string;
}

export interface HistoryMessage {
  role: MessageRole;
  rendered_text: string;
  structured_payload: unknown;
  created_at: string;
}

export interface SessionDetail {
  id: string;
  response_mode: AnalysisMode;
  messages: HistoryMessage[];
}

export interface AppendMessageParams {
  sessionId: string;
  role: MessageRole;
  renderedText: string;
  structuredPayload?: unknown;
}

export interface HistoryStoreOptions {
  path: string;
  now?: () => Date;
}

const PREVIEW_MAX_LENGTH = 120;

function summarizePreview(latestMessageText: string | null): string {
  if (latestMessageText === null) return "(no messages yet)";
  const collapsed = latestMessageText.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_LENGTH ? `${collapsed.slice(0, PREVIEW_MAX_LENGTH)}…` : collapsed;
}

export class HistoryStore {
  private readonly db: DatabaseHandle;
  private readonly now: () => Date;
  private readonly appendMessageTxn: (params: AppendMessageParams, timestamp: string) => void;

  constructor(options: HistoryStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.db = new Database(options.path);
    // Without this pragma SQLite treats REFERENCES as inert documentation; it
    // must be set per connection, before any write, for the messages ->
    // sessions foreign key to actually be enforced (P5c§3.1).
    this.db.pragma("foreign_keys = ON");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         response_mode TEXT NOT NULL,
         claude_session_id TEXT,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id),
         role TEXT NOT NULL,
         rendered_text TEXT NOT NULL,
         structured_payload TEXT,
         created_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
       CREATE INDEX IF NOT EXISTS sessions_last_active_at_idx ON sessions(last_active_at);`,
    );

    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, role, rendered_text, structured_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const bumpSession = this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?");
    this.appendMessageTxn = this.db.transaction((params: AppendMessageParams, timestamp: string) => {
      insertMessage.run(
        randomUUID(),
        params.sessionId,
        params.role,
        params.renderedText,
        params.structuredPayload === undefined ? null : JSON.stringify(params.structuredPayload),
        timestamp,
      );
      bumpSession.run(timestamp, params.sessionId);
    });
  }

  createSession(mode: AnalysisMode): SessionSummary {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, response_mode, claude_session_id, created_at, last_active_at) VALUES (?, ?, NULL, ?, ?)",
      )
      .run(id, mode, timestamp, timestamp);
    return { id, response_mode: mode, created_at: timestamp, last_active_at: timestamp, preview: "(no messages yet)" };
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.response_mode, s.created_at, s.last_active_at,
                (SELECT m.rendered_text FROM messages m WHERE m.session_id = s.id
                 ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS latest_message_text
         FROM sessions s
         ORDER BY s.last_active_at DESC`,
      )
      .all() as Array<{
      id: string;
      response_mode: AnalysisMode;
      created_at: string;
      last_active_at: string;
      latest_message_text: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      response_mode: row.response_mode,
      created_at: row.created_at,
      last_active_at: row.last_active_at,
      preview: summarizePreview(row.latest_message_text),
    }));
  }

  getSession(id: string): SessionDetail | null {
    const session = this.db
      .prepare("SELECT id, response_mode FROM sessions WHERE id = ?")
      .get(id) as { id: string; response_mode: AnalysisMode } | undefined;
    if (!session) return null;
    const rows = this.db
      .prepare(
        `SELECT role, rendered_text, structured_payload, created_at FROM messages
         WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(id) as Array<{
      role: MessageRole;
      rendered_text: string;
      structured_payload: string | null;
      created_at: string;
    }>;
    return {
      id: session.id,
      response_mode: session.response_mode,
      messages: rows.map((row) => ({
        role: row.role,
        rendered_text: row.rendered_text,
        structured_payload: row.structured_payload === null ? null : JSON.parse(row.structured_payload),
        created_at: row.created_at,
      })),
    };
  }

  appendMessage(params: AppendMessageParams): void {
    const timestamp = this.now().toISOString();
    this.appendMessageTxn(params, timestamp);
  }

  getClaudeSessionId(sessionId: string): string | null {
    const row = this.db.prepare("SELECT claude_session_id FROM sessions WHERE id = ?").get(sessionId) as
      | { claude_session_id: string | null }
      | undefined;
    if (!row) throw new Error(`unknown session ${sessionId}`);
    return row.claude_session_id;
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeSessionId, sessionId);
  }

  close(): void {
    this.db.close();
  }
}
