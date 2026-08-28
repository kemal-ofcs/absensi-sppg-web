"use client";

import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { TiltCard } from "@/components/visual/TiltCard";

interface LeaderboardPodium3DProps {
  topKaryawanList: Record<string, unknown>[];
}

export function LeaderboardPodium3D({
  topKaryawanList,
}: LeaderboardPodium3DProps) {
  const [filterMode, setFilterMode] = useState<"disiplin" | "jamKerja">(
    "disiplin",
  );

  const sortedList = useMemo(() => {
    const list = [...topKaryawanList];
    if (filterMode === "jamKerja") {
      return list.sort(
        (a, b) =>
          Number(b.total_jam_kerja || 0) - Number(a.total_jam_kerja || 0),
      );
    }
    // Default: paling disiplin (kehadiran tinggi, telat rendah)
    return list.sort((a, b) => {
      const hadirDiff =
        Number(b.total_kehadiran || 0) - Number(a.total_kehadiran || 0);
      if (hadirDiff !== 0) return hadirDiff;
      return Number(a.total_telat || 0) - Number(b.total_telat || 0);
    });
  }, [topKaryawanList, filterMode]);

  const top1 = sortedList[0] || null;
  const top2 = sortedList[1] || null;
  const top3 = sortedList[2] || null;
  const rest = sortedList.slice(3);

  if (sortedList.length === 0) {
    return (
      <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-12 text-center text-slate-400">
        <Icon name="users" className="mx-auto size-10 text-slate-600 mb-2" />
        <p className="font-bold text-white text-base">
          Belum Ada Data Leaderboard
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Data kedisiplinan akan muncul otomatis setelah karyawan melakukan
          absensi.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mode Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-white/5 pb-4">
        <div>
          <h3 className="text-base font-black text-white">
            Papan Peringkat Kedisiplinan Karyawan
          </h3>
          <p className="text-xs text-slate-400">
            Apresiasi karyawan dengan performa kehadiran terbaik dan jam kerja
            produktif.
          </p>
        </div>

        <div className="inline-flex rounded-xl border border-white/10 bg-slate-950 p-1 text-xs">
          <button
            type="button"
            onClick={() => setFilterMode("disiplin")}
            className={`rounded-lg px-3 py-1.5 font-bold transition ${
              filterMode === "disiplin"
                ? "bg-amber-400 text-slate-950 shadow-md shadow-amber-950/40"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Paling Disiplin
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("jamKerja")}
            className={`rounded-lg px-3 py-1.5 font-bold transition ${
              filterMode === "jamKerja"
                ? "bg-sky-400 text-slate-950 shadow-md shadow-sky-950/40"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Total Jam Kerja
          </button>
        </div>
      </div>

      {/* 3D Visual Podium Top 3 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end pt-4 pb-2">
        {/* PODIUM #2 (SILVER - LEFT) */}
        {top2 ? (
          <div className="order-2 md:order-1 flex flex-col items-center">
            <TiltCard maxTilt={8} className="w-full">
              <div className="relative rounded-3xl border border-slate-400/30 bg-gradient-to-b from-slate-800/90 via-slate-900 to-slate-950 p-5 text-center shadow-xl">
                {/* 3D Medal Badge */}
                <div className="mx-auto -mt-10 mb-3 flex size-14 items-center justify-center rounded-2xl border-2 border-slate-300 bg-gradient-to-br from-slate-200 to-slate-400 text-slate-950 font-black shadow-lg shadow-slate-500/20 text-xl font-mono">
                  🥈 2
                </div>

                <h4 className="text-base font-black text-white truncate">
                  {String(top2.nama)}
                </h4>
                <p className="text-xs font-semibold text-slate-300">
                  {String(top2.divisi || "-")}
                </p>
                <p className="text-[10px] font-mono text-slate-500">
                  NIK: {String(top2.id_karyawan)}
                </p>

                {/* Metrics */}
                <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-white/5 bg-slate-950/60 p-2.5 text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-slate-400">Kehadiran</div>
                    <div className="font-bold text-sky-300">
                      {Number(top2.total_kehadiran || 0)} Hari
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      Total Telat
                    </div>
                    <div
                      className={`font-bold ${Number(top2.total_telat) > 0 ? "text-amber-400" : "text-emerald-400"}`}
                    >
                      {Number(top2.total_telat || 0)} mnt
                    </div>
                  </div>
                </div>

                {/* Step Block Base */}
                <div className="mt-4 rounded-xl bg-slate-800/80 py-2 font-mono text-xs font-bold text-slate-300 border border-slate-700/50">
                  PODIUM #2 • PERAK
                </div>
              </div>
            </TiltCard>
          </div>
        ) : (
          <div className="order-2 md:order-1 hidden md:block" />
        )}

        {/* PODIUM #1 (GOLD - CENTER - TALLEST) */}
        {top1 ? (
          <div className="order-1 md:order-2 flex flex-col items-center -mt-4 md:-mt-6">
            <TiltCard maxTilt={10} className="w-full">
              <div className="relative rounded-3xl border-2 border-amber-400/60 bg-gradient-to-b from-amber-950/40 via-slate-900 to-slate-950 p-6 text-center shadow-2xl shadow-amber-950/50">
                {/* 3D Gold Medal Crown */}
                <div className="mx-auto -mt-12 mb-3 flex size-16 items-center justify-center rounded-2xl border-2 border-amber-300 bg-gradient-to-br from-amber-300 via-amber-400 to-yellow-600 text-slate-950 font-black shadow-xl shadow-amber-500/40 text-2xl font-mono animate-bounce duration-1000">
                  🥇 1
                </div>

                <span className="inline-block rounded-full bg-amber-400/20 px-3 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-300 border border-amber-400/40 mb-1">
                  Karyawan Terbaik
                </span>

                <h4 className="text-lg font-black text-white truncate mt-1">
                  {String(top1.nama)}
                </h4>
                <p className="text-xs font-semibold text-amber-300">
                  {String(top1.divisi || "-")}
                </p>
                <p className="text-[10px] font-mono text-slate-400">
                  NIK: {String(top1.id_karyawan)}
                </p>

                {/* Metrics */}
                <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-amber-400/20 bg-slate-950/80 p-3 text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-slate-400">Kehadiran</div>
                    <div className="text-base font-black text-amber-300">
                      {Number(top1.total_kehadiran || 0)} Hari
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      Total Telat
                    </div>
                    <div
                      className={`text-base font-black ${Number(top1.total_telat) > 0 ? "text-amber-400" : "text-emerald-400"}`}
                    >
                      {Number(top1.total_telat || 0)} mnt
                    </div>
                  </div>
                </div>

                {/* Step Block Base */}
                <div className="mt-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 py-2.5 font-mono text-xs font-black text-slate-950 shadow-md">
                  JUARA 1 • GOLD DISCIPLINE
                </div>
              </div>
            </TiltCard>
          </div>
        ) : null}

        {/* PODIUM #3 (BRONZE - RIGHT) */}
        {top3 ? (
          <div className="order-3 flex flex-col items-center">
            <TiltCard maxTilt={8} className="w-full">
              <div className="relative rounded-3xl border border-amber-700/40 bg-gradient-to-b from-stone-900/90 via-slate-900 to-slate-950 p-5 text-center shadow-xl">
                {/* 3D Bronze Medal */}
                <div className="mx-auto -mt-10 mb-3 flex size-14 items-center justify-center rounded-2xl border-2 border-amber-700 bg-gradient-to-br from-amber-700 via-amber-800 to-stone-800 text-amber-200 font-black shadow-lg shadow-amber-900/30 text-xl font-mono">
                  🥉 3
                </div>

                <h4 className="text-base font-black text-white truncate">
                  {String(top3.nama)}
                </h4>
                <p className="text-xs font-semibold text-amber-400/80">
                  {String(top3.divisi || "-")}
                </p>
                <p className="text-[10px] font-mono text-slate-500">
                  NIK: {String(top3.id_karyawan)}
                </p>

                {/* Metrics */}
                <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-white/5 bg-slate-950/60 p-2.5 text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-slate-400">Kehadiran</div>
                    <div className="font-bold text-sky-300">
                      {Number(top3.total_kehadiran || 0)} Hari
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">
                      Total Telat
                    </div>
                    <div
                      className={`font-bold ${Number(top3.total_telat) > 0 ? "text-amber-400" : "text-emerald-400"}`}
                    >
                      {Number(top3.total_telat || 0)} mnt
                    </div>
                  </div>
                </div>

                {/* Step Block Base */}
                <div className="mt-4 rounded-xl bg-stone-800/80 py-2 font-mono text-xs font-bold text-amber-300 border border-stone-700/50">
                  PODIUM #3 • PERUNGGU
                </div>
              </div>
            </TiltCard>
          </div>
        ) : (
          <div className="order-3 hidden md:block" />
        )}
      </div>

      {/* Rankings 4 and Beyond */}
      {rest.length > 0 ? (
        <div className="space-y-3 pt-4 border-t border-white/5">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Peringkat Ke-4 dan Seterusnya
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {rest.map((item, idx) => (
              <motion.div
                key={String(item.id_karyawan || idx)}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/60 p-3.5 hover:border-white/20 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-300 font-bold font-mono text-xs border border-slate-700">
                    #{idx + 4}
                  </div>
                  <div className="min-w-0">
                    <h5 className="text-sm font-bold text-white truncate">
                      {String(item.nama)}
                    </h5>
                    <p className="text-xs text-slate-400 font-mono">
                      {String(item.divisi || "-")} • NIK:{" "}
                      {String(item.id_karyawan)}
                    </p>
                  </div>
                </div>
                <div className="text-right font-mono shrink-0 pl-2">
                  <div className="text-xs font-bold text-sky-400">
                    {Number(item.total_kehadiran || 0)} Hari Hadir
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Telat: {Number(item.total_telat || 0)} mnt
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
