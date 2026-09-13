import type { ReactNode } from "react";
import "./Banner.css";
import { AlertTriangle, Info } from "./icons";
import type { LucideIcon } from "./icons";

export type BannerVariant = "info" | "warning" | "error";

export interface BannerProps {
  variant: BannerVariant;
  children: ReactNode;
  className?: string;
}

const BANNER_ICON: Record<BannerVariant, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertTriangle,
};

export function Banner({ variant, children, className }: BannerProps): JSX.Element {
  const Icon = BANNER_ICON[variant];
  const classes = ["banner", `banner-${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={variant === "error" ? "alert" : "status"}>
      <Icon className="banner-icon" size={16} aria-hidden="true" />
      <div className="banner-message">{children}</div>
    </div>
  );
}
