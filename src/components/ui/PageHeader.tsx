import type { ReactNode } from "react";

interface PageHeaderProps {
  actions?: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
  badge?: ReactNode;
  className?: string;
}

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
  badge,
  className = "",
}: PageHeaderProps) {
  return (
    <div
      className={`page-header visual-fade-in flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
      <div className="max-w-3xl space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="page-header-dot inline-block size-2 rounded-full"
          />
          <p className="page-header-eyebrow font-bold font-mono text-[11px] uppercase tracking-[0.2em]">
            {eyebrow}
          </p>
          {badge}
        </div>
        <h1 className="page-header-title font-black text-2xl tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="page-header-description text-sm leading-relaxed">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2.5 shrink-0 sm:self-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
