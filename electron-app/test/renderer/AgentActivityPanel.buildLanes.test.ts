import { describe, expect, it } from "vitest";
import { LANE_ORDER, buildLanes } from "../../src/renderer/AgentActivityPanel";
import type { TraceEvent } from "../../src/main/ipc/rendererApi";

function ev(partial: Partial<TraceEvent> & Pick<TraceEvent, "source" | "kind">): TraceEvent {
  return { requestId: "r1", at: "2026-07-29T00:00:00.000Z", ...partial };
}

describe("buildLanes", () => {
  it("orders lanes per LANE_ORDER regardless of arrival order", () => {
    const trace: TraceEvent[] = [
      ev({ source: "narrative", kind: "started" }),
      ev({ source: "intake", kind: "started" }),
      ev({ source: "synthesis", kind: "started" }),
    ];
    const lanes = buildLanes(trace);
    expect(lanes.map((l) => l.source)).toEqual(
      LANE_ORDER.filter((s) => ["intake", "synthesis", "narrative"].includes(s)),
    );
  });

  it("produces no lane for a source with zero events", () => {
    const trace: TraceEvent[] = [ev({ source: "intake", kind: "started" }), ev({ source: "intake", kind: "done" })];
    const lanes = buildLanes(trace);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].source).toBe("intake");
  });

  it("splits sidecar events into the compute bracket plus per-algorithm children in first-arrival order", () => {
    const trace: TraceEvent[] = [
      ev({ source: "sidecar", kind: "started", detail: "compute" }),
      ev({ source: "sidecar", kind: "started", detail: "rsi" }),
      ev({ source: "sidecar", kind: "started", detail: "macd" }),
      ev({ source: "sidecar", kind: "done", detail: "rsi" }),
      ev({ source: "sidecar", kind: "done", detail: "macd" }),
      ev({ source: "sidecar", kind: "done", detail: "compute" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.source).toBe("sidecar");
    expect(lane.status).toBe("done");
    expect(lane.children).toEqual([
      { kind: "algo", label: "rsi", status: "done" },
      { kind: "algo", label: "macd", status: "done" },
    ]);
  });

  it("classifies a lone sidecar error as the request-level bracket, not an algorithm", () => {
    const trace: TraceEvent[] = [
      ev({ source: "sidecar", kind: "started", detail: "compute" }),
      ev({ source: "sidecar", kind: "started", detail: "rsi" }),
      ev({ source: "sidecar", kind: "error", detail: "sidecar compute timed out after 20000ms" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.status).toBe("error");
    expect(lane.children).toEqual([{ kind: "algo", label: "rsi", status: "running" }]);
  });

  it("turns persona toolCall/toolResult events into tool leaves with detail verbatim", () => {
    const trace: TraceEvent[] = [
      ev({ source: "intake", kind: "started" }),
      ev({ source: "intake", kind: "toolCall", detail: 'Read {"file":"a.ts"}' }),
      ev({ source: "intake", kind: "toolResult", detail: "Read → contents" }),
      ev({ source: "intake", kind: "done" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.children).toEqual([
      { kind: "tool", variant: "toolCall", detail: 'Read {"file":"a.ts"}' },
      { kind: "tool", variant: "toolResult", detail: "Read → contents" },
    ]);
  });

  it("resolves status precedence as error > done > running", () => {
    const running = buildLanes([ev({ source: "intake", kind: "started" })])[0];
    const done = buildLanes([ev({ source: "intake", kind: "started" }), ev({ source: "intake", kind: "done" })])[0];
    const errored = buildLanes([
      ev({ source: "intake", kind: "started" }),
      ev({ source: "intake", kind: "done" }),
      ev({ source: "intake", kind: "error", detail: "boom" }),
    ])[0];
    expect(running.status).toBe("running");
    expect(done.status).toBe("done");
    expect(errored.status).toBe("error");
  });

  it("filters out narrative token events so they never become panel rows", () => {
    const trace: TraceEvent[] = [
      ev({ source: "narrative", kind: "started" }),
      ev({ source: "narrative", kind: "token", detail: "hello " }),
      ev({ source: "narrative", kind: "toolCall", detail: "WebFetch {}" }),
      ev({ source: "narrative", kind: "token", detail: "world" }),
      ev({ source: "narrative", kind: "done" }),
    ];
    const lane = buildLanes(trace)[0];
    expect(lane.children).toEqual([{ kind: "tool", variant: "toolCall", detail: "WebFetch {}" }]);
  });

  it("produces no lane for a source with only token events", () => {
    const trace: TraceEvent[] = [
      ev({ source: "narrative", kind: "token", detail: "hello " }),
      ev({ source: "narrative", kind: "token", detail: "world" }),
      ev({ source: "narrative", kind: "token", detail: "end" }),
    ];
    const lanes = buildLanes(trace);
    expect(lanes).toEqual([]);
  });

  it("returns an empty array for an empty trace", () => {
    expect(buildLanes([])).toEqual([]);
  });
});
