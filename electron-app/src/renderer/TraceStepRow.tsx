import { useEffect, useState } from "react";
import "./TraceStepRow.css";
import type { ChildNode, LaneNode, NodeStatus } from "./AgentActivityPanel";

const STATUS_ICON: Record<NodeStatus, string> = { running: "⟳", done: "✓", error: "✗" };

type BracketNode = LaneNode | Extract<ChildNode, { kind: "algo" }>;

export interface TraceStepRowProps {
  node: BracketNode;
  live: boolean;
}

export function TraceStepRow({ node, live }: TraceStepRowProps): JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null);
  // A manual toggle owns the row until its status next transitions; on any status
  // change (running → done/error) auto-behavior takes back over. In practice a row's
  // status never transitions after a terminal event, so a manual toggle on a
  // done/error row persists for the rest of that row's life.
  useEffect(() => setOverride(null), [node.status]);

  const hasChildren = node.kind === "lane" && node.children.length > 0;
  const auto = live && (node.status === "running" || node.status === "error");
  const expanded = override ?? auto;

  return (
    <div className={`trace-step trace-step-${node.status}`}>
      <button
        type="button"
        className="trace-step-head"
        onClick={() => hasChildren && setOverride(!expanded)}
        disabled={!hasChildren}
      >
        <span className="trace-step-icon">{STATUS_ICON[node.status]}</span>
        {hasChildren && <span className="trace-step-caret">{expanded ? "▾" : "▸"}</span>}
        <span className="trace-step-label">{node.label}</span>
      </button>
      {node.kind === "lane" && expanded && node.children.length > 0 && (
        <div className="trace-step-children">
          {node.children.map((child, i) =>
            child.kind === "tool" ? (
              <ToolLeafRow key={i} variant={child.variant} detail={child.detail} />
            ) : (
              <TraceStepRow key={i} node={child} live={live} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolLeafRow({ variant, detail }: { variant: "toolCall" | "toolResult"; detail: string }): JSX.Element {
  return (
    <div className={`trace-tool trace-tool-${variant}`}>
      <code className="trace-tool-detail">{detail}</code>
    </div>
  );
}
