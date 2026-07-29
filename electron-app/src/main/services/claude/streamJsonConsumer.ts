interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

interface StreamLine {
  type: string;
  subtype?: string;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: ContentBlock[] };
}

export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, resultText: string) => void;
  onResult: (finalText: string) => void;
  onFailure: (error: Error) => void;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as ContentBlock).text === "string" ? (b as ContentBlock).text : ""))
      .join("");
  }
  return JSON.stringify(content ?? "");
}

export function consumeStreamJson(
  child: { stdout: NodeJS.ReadableStream | null; on(event: "error" | "exit", cb: (...args: never[]) => void): unknown },
  callbacks: StreamCallbacks,
): void {
  let buffer = "";
  let finalText: string | undefined;
  let settled = false;
  const toolNamesById = new Map<string, string>();

  // A failing result line settles onFailure immediately; the exit handler that
  // follows would otherwise re-derive "no terminal result" and fire again.
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    callbacks.onFailure(error);
  };
  const succeed = (text: string): void => {
    if (settled) return;
    settled = true;
    callbacks.onResult(text);
  };

  const handleLine = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    let line: StreamLine;
    try {
      line = JSON.parse(trimmed) as StreamLine;
    } catch (error) {
      console.error(`stream-json: failed to parse line: ${(error as Error).message}`, trimmed);
      return;
    }

    if (
      line.type === "stream_event" &&
      line.event?.type === "content_block_delta" &&
      line.event.delta?.type === "text_delta" &&
      typeof line.event.delta.text === "string"
    ) {
      try {
        callbacks.onToken?.(line.event.delta.text);
      } catch (error) {
        console.error(`stream-json: onToken threw: ${(error as Error).message}`);
      }
      return;
    }
    if (line.type === "assistant" && Array.isArray(line.message?.content)) {
      for (const block of line.message!.content!) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") toolNamesById.set(block.id, block.name);
          try {
            callbacks.onToolCall?.(block.name, block.input);
          } catch (error) {
            console.error(`stream-json: onToolCall threw: ${(error as Error).message}`);
          }
        }
      }
      return;
    }
    if (line.type === "user" && Array.isArray(line.message?.content)) {
      for (const block of line.message!.content!) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const name = toolNamesById.get(block.tool_use_id) ?? block.tool_use_id;
          try {
            callbacks.onToolResult?.(name, toolResultText(block.content));
          } catch (error) {
            console.error(`stream-json: onToolResult threw: ${(error as Error).message}`);
          }
        }
      }
      return;
    }
    if (line.type === "result") {
      if (line.subtype === "success" && typeof line.result === "string") finalText = line.result;
      else fail(new Error(`result was not successful: ${line.subtype ?? "unknown"}`));
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  child.on("error", ((error: Error) => fail(error)) as never);
  child.on("exit", ((code: number | null) => {
    if (buffer.trim().length > 0) handleLine(buffer);
    if (code !== 0 && code !== null) {
      fail(new Error(`claude exited with code ${code}`));
      return;
    }
    if (finalText === undefined) {
      fail(new Error("stream ended without a terminal result"));
      return;
    }
    succeed(finalText);
  }) as never);
}
