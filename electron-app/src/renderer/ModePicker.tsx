import type { AnalysisMode } from "../main/ipc/rendererApi";

export interface ModePickerProps {
  onSelect: (mode: AnalysisMode) => void;
}

export function ModePicker({ onSelect }: ModePickerProps): JSX.Element {
  return (
    <section className="mode-picker">
      <h2>Choose this session's mode</h2>
      <button type="button" onClick={() => onSelect("ai_assisted")}>
        AI-Assisted (free-text, web research, streamed narrative)
      </button>
      <button type="button" onClick={() => onSelect("engine_only")}>
        Engine-Only (deterministic templated analysis)
      </button>
    </section>
  );
}
