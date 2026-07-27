import type { IntentLens } from "../main/ipc/rendererApi";

export interface IntentLensSelectorProps {
  value: IntentLens;
  onChange: (value: IntentLens) => void;
}

export function IntentLensSelector({ value, onChange }: IntentLensSelectorProps): JSX.Element {
  return (
    <fieldset className="intent-lens">
      <legend>Examining this instrument from a</legend>
      <label>
        <input type="radio" name="intent-lens" checked={value === "buying"} onChange={() => onChange("buying")} />
        buying stance
      </label>
      <label>
        <input type="radio" name="intent-lens" checked={value === "selling"} onChange={() => onChange("selling")} />
        selling stance
      </label>
    </fieldset>
  );
}
