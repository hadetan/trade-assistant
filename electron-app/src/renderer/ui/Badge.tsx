import type { HTMLAttributes } from "react";
import "./Badge.css";
import { X } from "./icons";

export type BadgeTone = "bullish" | "bearish" | "neutral" | "running" | "done" | "error";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone: BadgeTone;
  onRemove?: () => void;
  removeLabel?: string;
}

export function Badge({ tone, onRemove, removeLabel, className, children, ...rest }: BadgeProps): JSX.Element {
  const classes = ["badge", `badge-${tone}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
      {onRemove && (
        <button type="button" className="badge-remove" onClick={onRemove} aria-label={removeLabel ?? "Remove"}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function directionTone(direction: string): BadgeTone {
  if (direction === "bullish") return "bullish";
  if (direction === "bearish") return "bearish";
  return "neutral";
}
