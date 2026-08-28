"use client";

import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";

interface AttendanceWeeklyTrendProps {
  rekapHarian: Record<string, unknown>[];
  totalKaryawan: number;
}

interface DayStat {
  dateStr: string;
  dayLabel: string;
  hadir: number;
  terlambat: number;
  sakitIzin: number;
  alfa: number;
  totalPresent: number;
  rate: number;
}

const INDO_DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function AttendanceWeeklyTrend({
  rekapHarian,
  totalKaryawan,
}: AttendanceWeeklyTrendProps) {
  const [hoveredDay, setHoveredDay] = useState<DayStat | null>(null);

  // Generate 7 days back from today or from data
  const weeklyStats: DayStat[] = useMemo(() => {
    const daysMap = new Map<
      string,
      { hadir: number; terlambat: number; sakitIzin: number; alfa: number }
    >();

    // Seed past 7 days
    const today = new Date();
    const resultDays: string[] = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateKey = d.toLocaleDateString("en-CA");
      resultDays.push(dateKey);
      daysMap.set(dateKey, { hadir: 0, terlambat: 0, sakitIzin: 0, alfa: 0 });
    }

    // Populate from rekapHarian
    for (const row of rekapHarian) {
      const tgl = String(row.tanggal || "");
      if (!tgl || !daysMap.has(tgl)) continue;

      const stat = daysMap.get(tgl)!;
      const status = String(row.status_kehadiran || "");
      const telat = Number(row.menit_terlambat || 0);

      if (status === "Hadir" || status === "Terlambat") {
        if (telat > 0) {
          stat.terlambat++;
        } else {
          stat.hadir++;
        }
      } else if (
        status === "Sakit" ||
        status === "Izin" ||
        status === "Dispen"
      ) {
        stat.sakitIzin++;
      } else if (status === "Alfa") {
        stat.alfa++;
      }
    }

    const totalSafe = Math.max(totalKaryawan, 1);

    return resultDays.map((dateKey) => {
      const stat = daysMap.get(dateKey) || {
        hadir: 0,
        terlambat: 0,
        sakitIzin: 0,
        alfa: 0,
      };
      const d = new Date(dateKey);
      const dayName = INDO_DAYS[d.getDay()] || "Hari";
      const shortDate = `${d.getDate()}/${d.getMonth() + 1}`;
      const totalPresent = stat.hadir + stat.terlambat;
      const rate = Math.min(100, Math.round((totalPresent / totalSafe) * 100));

      return {
        dateStr: dateKey,
        dayLabel: `${dayName} (${shortDate})`,
        hadir: stat.hadir,
        terlambat: stat.terlambat,
        sakitIzin: stat.sakitIzin,
        alfa: stat.alfa,
        totalPresent,
        rate,
      };
    });
  }, [rekapHarian, totalKaryawan]);

  const avgRate = useMemo(() => {
    if (weeklyStats.length === 0) return 0;
    const sum = weeklyStats.reduce((acc, curr) => acc + curr.rate, 0);
    return Math.round(sum / weeklyStats.length);
  }, [weeklyStats]);

  return (
    <div className="flex flex-col justify-between rounded-3xl border border-white/10 bg-slate-900/80 p-5 sm:p-6 shadow-xl">
      {/* Header Info */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-xl bg-sky-400/20 text-sky-400">
              <Icon name="clock" className="size-4" />
            </span>
            <h3 className="text-base font-black text-white">
              Tren Kehadiran 7 Hari Terakhir
            </h3>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Aktivitas presensi kantor harian, keterlambatan, dan ketidakhadiran.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-right">
            <div className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
              Rata-rata 7 Hari
            </div>
            <div className="font-mono text-base font-black text-sky-200">
              {avgRate}%
            </div>
          </div>
        </div>
      </div>

      {/* Bar Chart Container */}
      <div className="my-5 grid grid-cols-7 gap-2 sm:gap-3">
        {weeklyStats.map((item, idx) => {
          const totalSafe = Math.max(totalKaryawan, 1);
          const hadirPct = (item.hadir / totalSafe) * 100;
          const telatPct = (item.terlambat / totalSafe) * 100;
          const alfaPct = (item.alfa / totalSafe) * 100;

          return (
            <button
              type="button"
              key={item.dateStr}
              className="group relative flex flex-col items-center gap-2 cursor-pointer bg-transparent border-0 p-0 text-left outline-none"
              onMouseEnter={() => setHoveredDay(item)}
              onMouseLeave={() => setHoveredDay(null)}
              onFocus={() => setHoveredDay(item)}
              onBlur={() => setHoveredDay(null)}
              aria-label={`${item.dayLabel}: ${item.hadir} hadir tepat waktu, ${item.terlambat} terlambat, ${item.alfa} alfa`}
            >
              {/* Stacked Vertical Bar */}
              <div className="relative flex h-36 w-full max-w-[36px] flex-col justify-end overflow-hidden rounded-xl border border-white/10 bg-slate-950/80 p-0.5">
                {/* Alfa Segment (Top) */}
                {alfaPct > 0 ? (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: `${alfaPct}%` }}
                    transition={{ duration: 0.5, delay: idx * 0.05 }}
                    className="w-full rounded-t-md bg-rose-500/80 shadow-sm"
                    title={`Alfa: ${item.alfa}`}
                  />
                ) : null}

                {/* Terlambat Segment (Middle) */}
                {telatPct > 0 ? (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: `${telatPct}%` }}
                    transition={{ duration: 0.5, delay: idx * 0.05 + 0.1 }}
                    className="w-full bg-amber-400/90 shadow-sm"
                    title={`Terlambat: ${item.terlambat}`}
                  />
                ) : null}

                {/* Hadir Segment (Bottom) */}
                {hadirPct > 0 ? (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: `${hadirPct}%` }}
                    transition={{ duration: 0.5, delay: idx * 0.05 + 0.2 }}
                    className="w-full rounded-b-md bg-gradient-to-t from-sky-600 to-sky-400 shadow-sm"
                    title={`Tepat Waktu: ${item.hadir}`}
                  />
                ) : null}

                {/* Empty State line if 0 activity */}
                {item.totalPresent === 0 && item.alfa === 0 ? (
                  <div className="h-1 w-full rounded bg-slate-800" />
                ) : null}
              </div>

              {/* Day Label */}
              <span className="text-[10px] font-mono font-bold text-slate-400 group-hover:text-sky-300 transition text-center truncate max-w-full">
                {item.dayLabel.split(" ")[0]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Dynamic Tooltip / Detail Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-slate-950/60 p-3 text-xs">
        {hoveredDay ? (
          <div className="flex flex-wrap items-center gap-3 animate-in fade-in">
            <span className="font-bold text-white">{hoveredDay.dayLabel}:</span>
            <span className="font-mono text-sky-400 font-bold">
              {hoveredDay.hadir} Tepat Waktu
            </span>
            <span className="font-mono text-amber-400 font-bold">
              {hoveredDay.terlambat} Telat
            </span>
            <span className="font-mono text-rose-400 font-bold">
              {hoveredDay.alfa} Alfa
            </span>
            <span className="font-mono text-purple-400 font-bold">
              {hoveredDay.sakitIzin} Izin
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4 text-slate-400">
            <div className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-sky-400" />
              <span>Tepat Waktu</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-amber-400" />
              <span>Terlambat</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-rose-500" />
              <span>Alfa</span>
            </div>
            <span className="text-[11px] text-slate-500 hidden sm:inline">
              Arahkan kursor pada balok untuk melihat rincian per tanggal.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
