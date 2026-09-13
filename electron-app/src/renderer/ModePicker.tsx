import type { KeyboardEvent } from "react";
import { Card } from "./ui/Card";
import { Gauge, MessageSquare } from "./ui/icons";
import "./ModePicker.css";
import type { AnalysisMode } from "../main/ipc/rendererApi";

export interface ModePickerProps {
  onSelect: (mode: AnalysisMode) => void;
}

function selectOnKey(event: KeyboardEvent, select: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select();
  }
}

export function ModePicker({ onSelect }: ModePickerProps): JSX.Element {
  return (
    <section className="mode-picker">
      <h2 className="mode-picker-heading">Choose this session's mode</h2>
      <div className="mode-picker-cards">
        <Card
          interactive
          className="mode-card"
          role="button"
          tabIndex={0}
          onClick={() => onSelect("ai_assisted")}
          onKeyDown={(event) => selectOnKey(event, () => onSelect("ai_assisted"))}
        >
          <MessageSquare className="mode-card-icon" size={28} aria-hidden="true" />
          <h3>AI-Assisted</h3>
          <p>Full reasoning chat with live agent trace</p>
        </Card>
        <Card
          interactive
          className="mode-card"
          role="button"
          tabIndex={0}
          onClick={() => onSelect("engine_only")}
          onKeyDown={(event) => selectOnKey(event, () => onSelect("engine_only"))}
        >
          <Gauge className="mode-card-icon" size={28} aria-hidden="true" />
          <h3>Engine-Only</h3>
          <p>Deterministic instant verdict, no AI call</p>
        </Card>
      </div>
    </section>
  );
}
