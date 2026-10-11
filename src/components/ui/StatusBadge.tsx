import type { ReactNode } from "react";

type StatusTone = "info" | "success" | "warning" | "danger" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  info: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  danger: "border-rose-400/25 bg-rose-400/10 text-rose-200",
  neutral: "border-slate-700 bg-slate-900/80 text-slate-300",
};

interface StatusBadgeProps {
  children: ReactNode;
  className?: string;
  tone?: StatusTone;
}

export function StatusBadge({
  children,
  className = "",
  tone = "neutral",
}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
