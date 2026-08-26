"use client";

interface RunStatusBadgeProps {
  status: string;
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const normalized = (status || "").toUpperCase();

  let badgeColor = "bg-slate-700 text-slate-200 border-slate-600";
  let label = normalized;

  switch (normalized) {
    case "DRAFT":
      badgeColor = "bg-amber-500/10 text-amber-400 border-amber-500/30";
      label = "Draft";
      break;
    case "SUBMITTED":
      badgeColor = "bg-sky-500/10 text-sky-400 border-sky-500/30";
      label = "Diajukan";
      break;
    case "REVIEWED":
      badgeColor = "bg-indigo-500/10 text-indigo-400 border-indigo-500/30";
      label = "Direview";
      break;
    case "APPROVED":
      badgeColor = "bg-teal-500/10 text-teal-400 border-teal-500/30";
      label = "Disetujui";
      break;
    case "PAID":
      badgeColor = "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
      label = "Dibayar (Terkunci)";
      break;
    case "REJECTED":
      badgeColor = "bg-rose-500/10 text-rose-400 border-rose-500/30";
      label = "Ditolak";
      break;
  }

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeColor}`}
    >
      {label}
    </span>
  );
}
