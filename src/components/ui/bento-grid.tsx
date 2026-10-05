// Aceternity UI: https://ui.aceternity.com/registry/bento-grid.json
// Manual installation; theme classes and hover movement adapted for a work dashboard.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BentoGrid({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return <div className={cn("bento-grid", className)}>{children}</div>;
}

export function BentoGridItem({
  className,
  title,
  description,
  header,
  icon,
}: {
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  header?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={cn("bento-item", className)}>
      <div className="bento-item-top">
        {icon}
        <div className="bento-item-title">{title}</div>
      </div>
      {header}
      <div className="bento-item-description">{description}</div>
    </div>
  );
}
