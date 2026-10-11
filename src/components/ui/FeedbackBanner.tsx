import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface FeedbackBannerProps {
  children: ReactNode;
  onDismiss?: () => void;
  tone: "error" | "success" | "warning";
}

const toneClasses = {
  error: "border-rose-400/25 bg-rose-400/10 text-rose-100",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-100",
  warning: "border-amber-300/25 bg-amber-300/10 text-amber-100",
};

export function FeedbackBanner({
  children,
  onDismiss,
  tone,
}: FeedbackBannerProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-2xl border p-4 text-sm ${toneClasses[tone]}`}
    >
      <Icon
        name={tone === "success" ? "check" : "tools"}
        className="mt-0.5 size-4 shrink-0"
      />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg px-2 py-1 text-xs font-bold hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Tutup
        </button>
      ) : null}
    </div>
  );
}
