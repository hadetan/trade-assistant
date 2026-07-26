import type { NarrativeEvent } from "./rendererApi";

export const NARRATIVE_CHANNEL = "analysis:narrative";

export function makeNarrativeSender(
  sendToRenderer: (channel: string, payload: unknown) => void,
): (event: NarrativeEvent) => void {
  return (event) => sendToRenderer(NARRATIVE_CHANNEL, event);
}
