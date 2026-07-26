import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { spawnClaude } from "./claudeProvider";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface NarrativeStreamSpec {
  systemPrompt: string;
  prompt: string;
  onToken: (text: string) => void;
  signal?: AbortSignal;
}

export interface NarrativeStreamerOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

const DEFAULT_NARRATIVE_TIMEOUT_MS = 180000;

interface StreamLine {
  type: string;
  subtype?: string;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

export function makeNarrativeStreamer(
  options: NarrativeStreamerOptions = {},
): (spec: NarrativeStreamSpec) => Promise<string> {
  const spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_NARRATIVE_TIMEOUT_MS;

  return (spec: NarrativeStreamSpec): Promise<string> => {
    if (spec.signal?.aborted) return Promise.reject(new Error("narrative aborted"));

    const child = spawnClaude(
      spec.prompt,
      { systemPrompt: spec.systemPrompt, outputFormat: "stream-json", includePartialMessages: true },
      spawnFn,
    );

    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      let finalText: string | undefined;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (onAbort) spec.signal?.removeEventListener("abort", onAbort);
      };
      // Reject before killing so the exit the kill triggers can't win the race
      // and re-settle — same discipline as makeClaudeRunner's guard.
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
        child.kill();
      };
      const succeed = (text: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(text);
      };

      timer = setTimeout(() => fail(new Error(`narrative timed out after ${timeoutMs}ms`)), timeoutMs);
      onAbort = () => fail(new Error("narrative aborted"));
      spec.signal?.addEventListener("abort", onAbort);

      const handleLine = (raw: string): void => {
        const trimmed = raw.trim();
        if (trimmed.length === 0) return;
        let line: StreamLine;
        try {
          line = JSON.parse(trimmed) as StreamLine;
        } catch (error) {
          console.error(`narrative: failed to parse stream line: ${(error as Error).message}`, trimmed);
          return;
        }
        if (
          line.type === "stream_event" &&
          line.event?.type === "content_block_delta" &&
          line.event.delta?.type === "text_delta" &&
          typeof line.event.delta.text === "string"
        ) {
          spec.onToken(line.event.delta.text);
          return;
        }
        if (line.type === "result") {
          if (line.subtype === "success" && typeof line.result === "string") finalText = line.result;
          else fail(new Error(`narrative result was not successful: ${line.subtype ?? "unknown"}`));
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
      child.on("error", (error: Error) => fail(error));
      child.on("exit", (code: number | null) => {
        if (buffer.trim().length > 0) handleLine(buffer);
        if (code !== 0 && code !== null) {
          fail(new Error(`claude exited with code ${code}`));
          return;
        }
        if (finalText === undefined) {
          fail(new Error("narrative stream ended without a terminal result"));
          return;
        }
        succeed(finalText);
      });
    });
  };
}
