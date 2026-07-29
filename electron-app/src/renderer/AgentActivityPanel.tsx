import type { TraceEvent, TraceSource } from "../main/ipc/rendererApi";

export const LANE_ORDER: TraceSource[] = [
  "intake",
  "sidecar",
  "options_greeks",
  "technical_quant",
  "position_risk",
  "synthesis",
  "narrative",
];

const LANE_LABEL: Record<TraceSource, string> = {
  intake: "Intake",
  sidecar: "Rust compute",
  options_greeks: "Options & Greeks",
  technical_quant: "Technical & Quant",
  position_risk: "Position & Risk",
  synthesis: "Synthesis",
  narrative: "Narrative",
};

export type NodeStatus = "running" | "done" | "error";

export type ChildNode =
  | { kind: "algo"; label: string; status: NodeStatus }
  | { kind: "tool"; variant: "toolCall" | "toolResult"; detail: string };

export interface LaneNode {
  kind: "lane";
  source: TraceSource;
  label: string;
  status: NodeStatus;
  children: ChildNode[];
}

function statusFrom(events: Pick<TraceEvent, "kind">[]): NodeStatus {
  if (events.some((e) => e.kind === "error")) return "error";
  if (events.some((e) => e.kind === "done")) return "done";
  return "running";
}

// A sidecar event is a per-algorithm child iff it is a non-error progress line whose
// detail is an algorithm id: "compute" is the reserved request-step name for the
// bracket, and Rust never emits a per-algorithm error (P9A§9.3), so a sidecar error
// always belongs to the request-level bracket.
function isAlgoEvent(e: TraceEvent): boolean {
  return e.kind !== "error" && e.detail !== undefined && e.detail !== "compute";
}

export function buildLanes(trace: TraceEvent[]): LaneNode[] {
  const bySource = new Map<TraceSource, TraceEvent[]>();
  for (const e of trace) {
    if (e.kind === "token") continue;
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }

  const lanes: LaneNode[] = [];
  for (const source of LANE_ORDER) {
    const events = bySource.get(source);
    if (!events) continue;

    if (source === "sidecar") {
      const bracket = events.filter((e) => !isAlgoEvent(e));
      const algos = new Map<string, TraceEvent[]>();
      for (const e of events) {
        if (!isAlgoEvent(e)) continue;
        const id = e.detail as string;
        const g = algos.get(id);
        if (g) g.push(e);
        else algos.set(id, [e]);
      }
      lanes.push({
        kind: "lane",
        source,
        label: LANE_LABEL[source],
        status: statusFrom(bracket),
        children: [...algos.entries()].map(([id, es]) => ({ kind: "algo", label: id, status: statusFrom(es) })),
      });
    } else {
      lanes.push({
        kind: "lane",
        source,
        label: LANE_LABEL[source],
        status: statusFrom(events),
        children: events
          .filter((e) => e.kind === "toolCall" || e.kind === "toolResult")
          .map((e) => ({ kind: "tool", variant: e.kind as "toolCall" | "toolResult", detail: e.detail ?? "" })),
      });
    }
  }
  return lanes;
}
