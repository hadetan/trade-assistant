import type { TraceEvent } from "./rendererApi";

export const TRACE_CHANNEL = "analysis:trace";

export function makeTraceSender(
  sendToRenderer: (channel: string, payload: unknown) => void,
): (event: TraceEvent) => void {
  return (event) => sendToRenderer(TRACE_CHANNEL, event);
}
