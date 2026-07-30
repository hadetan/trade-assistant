import type { HTMLAttributes } from "react";
import "./Card.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive = false, className, ...rest }: CardProps): JSX.Element {
  const classes = ["card", interactive && "card-interactive", className].filter(Boolean).join(" ");
  return <div className={classes} {...rest} />;
}
