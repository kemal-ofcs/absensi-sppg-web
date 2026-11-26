"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";

export interface QuickActionTileProps {
  href: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  badge?: number | string;
  badgeColor?: "rose" | "amber" | "emerald" | "sky";
}

/* Satu nada navy + emas untuk semua menu; warna hanya di badge status.
   Gaya di kelas `.aksi-cepat*` pada globals.css. */
const BADGE_BG = {
  rose: "bg-rose-700",
  amber: "bg-amber-700",
  emerald: "bg-emerald-700",
  sky: "bg-sky-700",
};

export function QuickActionTile({
  href,
  icon,
  title,
  subtitle,
  badge,
  badgeColor = "rose",
}: QuickActionTileProps) {
  return (
    <Link
      href={href}
      className="aksi-cepat group relative flex flex-col items-center justify-center rounded-2xl p-3.5 text-center shadow-sm active:scale-95 sm:p-4"
    >
      {badge !== undefined && badge !== null && (
        <span
          className={`text-on-accent absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-bold font-mono text-[10px] shadow-sm ${BADGE_BG[badgeColor]}`}
        >
          {badge}
        </span>
      )}

      <div className="aksi-cepat-ikon flex size-12 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105 sm:size-13">
        <Icon name={icon} className="size-6 stroke-[2.2]" />
      </div>

      <span className="mt-2 flex min-h-[2.25rem] items-center justify-center font-bold text-xs tracking-tight sm:text-sm">
        {title}
      </span>
      {subtitle ? (
        <span className="aksi-cepat-sub text-[11px] leading-tight">
          {subtitle}
        </span>
      ) : null}
    </Link>
  );
}
