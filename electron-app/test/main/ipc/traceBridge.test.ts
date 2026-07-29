import { describe, expect, it, vi } from "vitest";
import { TRACE_CHANNEL, makeTraceSender } from "../../../src/main/ipc/traceBridge";
import type { TraceEvent } from "../../../src/main/ipc/rendererApi";

describe("makeTraceSender", () => {
  it("publishes every TraceEvent on the analysis:trace channel", () => {
    const sendToRenderer = vi.fn();
    const send = makeTraceSender(sendToRenderer);
    const event: TraceEvent = { requestId: "r1", source: "intake", kind: "started", at: "2026-07-29T00:00:00.000Z" };
    send(event);
    expect(TRACE_CHANNEL).toBe("analysis:trace");
    expect(sendToRenderer).toHaveBeenCalledWith("analysis:trace", event);
  });
});
