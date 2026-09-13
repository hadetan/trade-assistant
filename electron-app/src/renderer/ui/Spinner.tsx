import "./Spinner.css";
import { Loader2 } from "./icons";

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({ size = 16, className, label = "Loading" }: SpinnerProps): JSX.Element {
  const classes = ["spinner", className].filter(Boolean).join(" ");
  return <Loader2 className={classes} size={size} role="status" aria-label={label} />;
}
