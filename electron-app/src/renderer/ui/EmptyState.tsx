import "./EmptyState.css";
import { Button } from "./Button";
import type { LucideIcon } from "./icons";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: EmptyStateAction;
  className?: string;
}

export function EmptyState({ icon: Icon, message, action, className }: EmptyStateProps): JSX.Element {
  const classes = ["empty-state", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Icon className="empty-state-icon" size={32} aria-hidden="true" />
      <p className="empty-state-message">{message}</p>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}
