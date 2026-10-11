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
      className={`visual-fade-in flex flex-col gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
      <div className="max-w-3xl space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
          <p className="page-header-eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-amber-300 font-mono">
            {eyebrow}
          </p>
          {badge}
        </div>
        <h1 className="page-header-title text-2xl font-black tracking-tight text-white sm:text-3xl">
          {title}
        </h1>
        <p className="page-header-description text-sm leading-relaxed text-slate-400">
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
