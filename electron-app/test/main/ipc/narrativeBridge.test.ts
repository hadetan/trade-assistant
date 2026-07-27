import { describe, expect, it, vi } from "vitest";
import { NARRATIVE_CHANNEL, makeNarrativeSender } from "../../../src/main/ipc/narrativeBridge";

describe("makeNarrativeSender", () => {
  it("pushes events on the analysis:narrative channel", () => {
    const sendToRenderer = vi.fn();
    const send = makeNarrativeSender(sendToRenderer);
    send({ requestId: "r1", chunk: "hi" });
    send({ requestId: "r1", done: true });
    expect(NARRATIVE_CHANNEL).toBe("analysis:narrative");
    expect(sendToRenderer).toHaveBeenNthCalledWith(1, "analysis:narrative", { requestId: "r1", chunk: "hi" });
    expect(sendToRenderer).toHaveBeenNthCalledWith(2, "analysis:narrative", { requestId: "r1", done: true });
  });
});
