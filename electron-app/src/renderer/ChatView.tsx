import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { MessageMarkdown } from "./MessageMarkdown";
import { AgentActivityPanel } from "./AgentActivityPanel";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { Badge, directionTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Send } from "./ui/icons";
import "./ChatView.css";
import type { AnalysisResult, HistoryMessage, IntentLens, TraceEvent, Verdict } from "../main/ipc/rendererApi";

export interface ChatViewProps {
  intentLens: IntentLens;
  sessionId: string;
  initialMessages?: ChatMessage[];
}

interface AssistantMessage {
  role: "assistant";
  requestId: string;
  text: string;
  verdict?: Verdict;
  trace: TraceEvent[];
  live: boolean;
}

interface UserMessage {
  role: "user";
  text: string;
}

type ChatMessage = UserMessage | AssistantMessage;

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function historyToChatMessages(messages: HistoryMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", text: message.rendered_text };
    const payload = message.structured_payload as AnalysisResult | null;
    const verdict = payload && payload.mode === "ai_assisted" ? payload.verdict : undefined;
    return {
      role: "assistant",
      requestId: newRequestId(),
      text: message.rendered_text,
      verdict,
      trace: message.trace ?? [],
      live: false,
    };
  });
}

export function ChatView({ intentLens, sessionId, initialMessages }: ChatViewProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    bridge().onTrace((event: TraceEvent) => {
      if (event.requestId !== activeRequestId.current) return;
      const isNarrativeToken = event.source === "narrative" && event.kind === "token";
      setMessages((prev) =>
        prev.map((message) =>
          message.role === "assistant" && message.requestId === event.requestId
            ? {
                ...message,
                text: isNarrativeToken ? message.text + (event.detail ?? "") : message.text,
                trace: isNarrativeToken ? message.trace : [...message.trace, event],
              }
            : message,
        ),
      );
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
    setMessages((prev) => [
      ...prev,
      { role: "user", text: query },
      { role: "assistant", requestId, text: "", trace: [], live: true },
    ]);
    try {
      const result = await bridge().runAnalysis({ mode: "ai_assisted", sessionId, query, intent_lens: intentLens, requestId });
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
                {message.trace.length > 0 && <AgentActivityPanel trace={message.trace} live={message.live} />}
                {message.verdict && (
                  <Badge tone={directionTone(message.verdict.direction)} className="verdict">
                    {message.verdict.direction} · {message.verdict.conviction} conviction
                  </Badge>
                )}
                <MessageMarkdown text={message.text} />
              </>
            ) : (
              <p>{message.text}</p>
            )}
          </li>
        ))}
      </ul>
      {error && <Banner variant="error">{error}</Banner>}
      <div className="chat-input">
        <TextField
          aria-label="ask about an instrument"
          placeholder="Ask about an instrument…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button onClick={() => void onSend()} disabled={busy}>
          {busy ? (
            "Analyzing…"
          ) : (
            <>
              <Send size={14} aria-hidden="true" /> Send
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
