import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { spawnClaude } from "./claudeProvider";
import { consumeStreamJson } from "./streamJsonConsumer";
import { summarizeForTrace } from "./traceDetail";
import type { TraceEmitter } from "../../ipc/rendererApi";

type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface NarrativeStreamSpec {
  systemPrompt: string;
  prompt: string;
  onTrace: TraceEmitter;
  timeoutMs: number;
  signal?: AbortSignal;
  claudeSessionId?: string;
  resumeSession?: boolean;
}

export interface NarrativeStreamerOptions {
  spawnFn?: SpawnFn;
}

export function makeNarrativeStreamer(
  options: NarrativeStreamerOptions = {},
): (spec: NarrativeStreamSpec) => Promise<string> {
  const spawnFn = options.spawnFn ?? ((command, args) => spawn(command, args));

  return (spec: NarrativeStreamSpec): Promise<string> => {
    if (spec.signal?.aborted) return Promise.reject(new Error("narrative aborted"));

    const child = spawnClaude(
      spec.prompt,
      {
        systemPrompt: spec.systemPrompt,
        outputFormat: "stream-json",
        includePartialMessages: true,
        claudeSessionId: spec.claudeSessionId,
        resumeSession: spec.resumeSession,
      },
      spawnFn,
    );

    return new Promise<string>((resolve, reject) => {
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
        // Lives inside fail so it fires exactly once before the reject,
        // regardless of the failure source — timeout, abort, non-zero
        // exit, missing terminal, or a stream_json result failure.
        spec.onTrace({ source: "narrative", kind: "error", detail: error.message });
        reject(error);
        child.kill();
      };
      const succeed = (text: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        spec.onTrace({ source: "narrative", kind: "done" });
        resolve(text);
      };

      spec.onTrace({ source: "narrative", kind: "started" });
      timer = setTimeout(() => fail(new Error(`narrative timed out after ${spec.timeoutMs}ms`)), spec.timeoutMs);
      onAbort = () => fail(new Error("narrative aborted"));
      spec.signal?.addEventListener("abort", onAbort);

      // ChildProcess.on's overloads don't structurally satisfy consumeStreamJson's
      // narrowed (event, cb: (...args: never[]) => void) signature; streamJsonConsumer.ts
      // casts its own internal `on` calls the same way, so this mirrors that precedent.
      consumeStreamJson(child as never, {
        onToken: (text) => {
          if (!settled) spec.onTrace({ source: "narrative", kind: "token", detail: text });
        },
        onToolCall: (name, input) =>
          spec.onTrace({ source: "narrative", kind: "toolCall", detail: `${name} ${summarizeForTrace(JSON.stringify(input ?? {}))}` }),
        onToolResult: (name, resultText) =>
          spec.onTrace({ source: "narrative", kind: "toolResult", detail: `${name} → ${summarizeForTrace(resultText)}` }),
        onResult: (finalText) => succeed(finalText),
        onFailure: (error) => fail(error),
      });
    });
  };
}
