import "./StatusDot.css";
import { Check, Loader2, X } from "./icons";
import type { LucideIcon } from "./icons";

export type StatusDotTone = "running" | "done" | "error";

export interface StatusDotProps {
  tone: StatusDotTone;
  label: string;
  className?: string;
}

const STATUS_ICON: Record<StatusDotTone, LucideIcon> = {
  running: Loader2,
  done: Check,
  error: X,
};

export function StatusDot({ tone, label, className }: StatusDotProps): JSX.Element {
  const Icon = STATUS_ICON[tone];
  const classes = ["status-dot", `status-dot-${tone}`, className].filter(Boolean).join(" ");
  const iconClasses = ["status-dot-icon", tone === "running" && "status-dot-icon-spin"].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <Icon className={iconClasses} size={14} aria-hidden="true" />
      <span className="status-dot-label">{label}</span>
    </span>
  );
}
