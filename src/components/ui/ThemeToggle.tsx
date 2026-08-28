"use client";

import { Icon, type IconName } from "@/components/ui/Icon";
import { type AppTheme, useTheme } from "@/lib/context/ThemeContext";

interface ThemeToggleProps {
  variant?: "segmented" | "dropdown" | "compact";
  className?: string;
}

const THEME_OPTIONS: { value: AppTheme; label: string; icon: IconName }[] = [
  { value: "light", label: "Terang", icon: "sun" },
  { value: "dark", label: "Gelap", icon: "moon" },
  { value: "system", label: "Sistem", icon: "monitor" },
];

export function ThemeToggle({
  variant = "segmented",
  className = "",
}: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();

  if (variant === "compact") {
    const currentIcon =
      theme === "system"
        ? "monitor"
        : resolvedTheme === "light"
          ? "sun"
          : "moon";

    return (
      <div className={`relative inline-flex items-center ${className}`}>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as AppTheme)}
          aria-label="Pilih tema aplikasi"
          className="peer absolute inset-0 cursor-pointer opacity-0"
        >
          {THEME_OPTIONS.map((opt) => (
            <option
              key={opt.value}
              value={opt.value}
              className="bg-slate-900 text-slate-100 dark:bg-slate-900 dark:text-slate-100"
            >
              Tema: {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 sm:size-11"
        >
          <Icon name={currentIcon} className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center rounded-2xl border border-white/10 bg-slate-950/60 p-1 backdrop-blur-md ${className}`}
    >
      {THEME_OPTIONS.map((opt) => {
        const isSelected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isSelected}
            onClick={() => setTheme(opt.value)}
            className={`group flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
              isSelected
                ? "bg-sky-500 text-white shadow-md shadow-sky-950/40"
                : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <Icon
              name={opt.icon}
              className={`size-3.5 transition ${isSelected ? "text-white" : "text-slate-300 group-hover:text-white"}`}
            />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
