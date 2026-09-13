import type { InputHTMLAttributes } from "react";
import "./TextField.css";
import { Search } from "./icons";

export type TextFieldVariant = "default" | "search";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: TextFieldVariant;
}

export function TextField({ variant = "default", className, ...rest }: TextFieldProps): JSX.Element {
  const wrapperClasses = ["text-field", `text-field-${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClasses}>
      {variant === "search" && <Search className="text-field-icon" size={14} aria-hidden="true" />}
      <input className="text-field-input" {...rest} />
    </div>
  );
}
