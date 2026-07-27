import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import type { IntentLens, NarrativeEvent, Verdict } from "../main/ipc/rendererApi";

export interface ChatViewProps {
  intentLens: IntentLens;
}

interface AssistantMessage {
  role: "assistant";
  requestId: string;
  text: string;
  verdict?: Verdict;
}

interface UserMessage {
  role: "user";
  text: string;
}

type ChatMessage = UserMessage | AssistantMessage;

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ChatView({ intentLens }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    bridge().onNarrative((event: NarrativeEvent) => {
      if (event.requestId !== activeRequestId.current) return;
      if (event.chunk !== undefined) {
        setMessages((prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.requestId === event.requestId
              ? { ...message, text: message.text + event.chunk }
              : message,
          ),
        );
      }
      if (event.error !== undefined) setError(event.error);
    });
  }, []);

  const onSend = async (): Promise<void> => {
    const query = input.trim();
    if (query.length === 0 || busy) return;
    const requestId = newRequestId();
    activeRequestId.current = requestId;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: query }, { role: "assistant", requestId, text: "" }]);
    try {
      const result = await bridge().runAnalysis({ mode: "ai_assisted", query, intent_lens: intentLens, requestId });
      if (result.mode === "ai_assisted") {
        setMessages((prev) =>
          prev.map((message) =>
            message.role === "assistant" && message.requestId === requestId
              ? { ...message, text: result.narrative, verdict: result.verdict }
              : message,
          ),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat-view">
      <ul className="messages">
        {messages.map((message, index) => (
          <li key={index} className={`message message-${message.role}`}>
            {message.role === "assistant" ? (
              <>
                {message.verdict && (
                  <div className="verdict">
                    {message.verdict.direction} · {message.verdict.conviction} conviction
                  </div>
                )}
                <MessageMarkdown text={message.text} />
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
      <div className="chat-input">
        <input
          aria-label="ask about an instrument"
          placeholder="Ask about an instrument…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="button" onClick={onSend} disabled={busy}>
          {busy ? "Analyzing…" : "Send"}
        </button>
      </div>
    </section>
  );
}
