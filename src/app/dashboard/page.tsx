"use client";

import { redirect } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type DashboardMetrics,
  getDashboardMetrics,
  getRekapBulanan,
  getRekapHarian,
  getTopKaryawanTerajin,
  type RekapBulananItem,
} from "@/lib/gateways/report";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function DashboardPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [activeTab, setActiveTab] = useState<
    "harian" | "bulanan" | "leaderboard"
  >("harian");
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toISOString().split("T")[0],
  );
  const [rekapHarianList, setRekapHarianList] = useState<
    Record<string, unknown>[]
  >([]);
  const [rekapBulananList, setRekapBulananList] = useState<RekapBulananItem[]>(
    [],
  );
  const [topKaryawanList, setTopKaryawanList] = useState<
    Record<string, unknown>[]
  >([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Overview data: metrics, bulanan, leaderboard ─────────────────────────
  // Only fetched once after authentication. Does NOT depend on selectedDate.
  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;

    let isCancelled = false;
    setLoading(true);
    setLoadError(null);

    async function loadOverviewData() {
      try {
        const [metricsData, bulananData, topData] = await Promise.all([
          getDashboardMetrics(),
          getRekapBulanan(),
          getTopKaryawanTerajin(5),
        ]);
        if (isCancelled) return;
        setMetrics(metricsData);
        setRekapBulananList(bulananData);
        setTopKaryawanList(topData);
      } catch (error: unknown) {
        if (isCancelled) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Data dashboard tidak dapat dimuat.",
        );
      } finally {
        if (!isCancelled) setLoading(false);
      }
    }

    loadOverviewData();
    return () => {
      isCancelled = true;
    };
  }, [isHydrated, isAuthenticated]);

  // ── Harian data: rekap per-tanggal ────────────────────────────────────────
  // Re-fetched whenever selectedDate changes (fast, isolated query).
  const [harianLoading, setHarianLoading] = useState(false);
  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;

    let isCancelled = false;
    setHarianLoading(true);

    async function loadHarianData() {
      try {
        const harianData = await getRekapHarian({ tanggal: selectedDate });
        if (isCancelled) return;
        setRekapHarianList(harianData);
      } catch {
        // Silently ignore harian load errors – overview error is already shown.
      } finally {
        if (!isCancelled) setHarianLoading(false);
      }
    }

    loadHarianData();
    return () => {
      isCancelled = true;
    };
  }, [isHydrated, isAuthenticated, selectedDate]);

  // Combined loading state for skeleton rendering
  const isLoading = useMemo(
    () => loading || harianLoading,
    [loading, harianLoading],
  );

  // Export CSV Data
  const exportToCSV = () => {
    if (!hasPermission(user, "dashboard.export")) return;
    if (activeTab === "harian") {
      let csvContent =
        "data:text/csv;charset=utf-8,ID,Nama,Divisi,Jam Masuk,Jam Pulang,Status Kehadiran,Menit Terlambat,Keterangan\n";
      for (const row of rekapHarianList) {
        csvContent += `"${row.id_karyawan}","${row.nama}","${row.kelas_divisi}","${row.jam_masuk}","${row.jam_pulang}","${row.status_kehadiran}","${row.menit_terlambat}","${row.keterangan}"\n`;
      }
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Rekap_Harian_${selectedDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else if (activeTab === "bulanan") {
      let csvContent =
        "data:text/csv;charset=utf-8,ID,Nama,Divisi,Total Hadir,Total Telat (Menit),Frekuensi Telat,Total Sakit,Total Izin,Total Alfa,Total Jam Kerja,Total Lembur\n";
      for (const row of rekapBulananList) {
        csvContent += `"${row.idKaryawan}","${row.nama}","${row.divisi}","${row.totalHadir}","${row.totalTerlambat}","${row.frekuensiTelat}","${row.totalSakit}","${row.totalIzin}","${row.totalAlfa}","${row.totalJamKerja}","${row.totalLembur}"\n`;
      }
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", "Rekap_Bulanan_Absensi.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Dashboard Analytics...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "dashboard")) redirect("/forbidden");

  return (
    <AppShell contentClassName="px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      <div className="mx-auto w-full max-w-7xl space-y-8">
        {/* Top Header Navigation */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <span className="text-xs uppercase tracking-widest text-amber-400 font-semibold font-mono">
              Executive Analytics & Reports
            </span>
            <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
              Dashboard Rekapitulasi Absensi SPPG
            </h1>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white outline-none focus:border-sky-500 sm:w-auto"
            />

            {hasPermission(user, "dashboard.export") ? (
              <button
                type="button"
                onClick={exportToCSV}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-600 to-blue-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-sky-950/60 transition hover:from-sky-500 hover:to-blue-500 active:scale-95 sm:w-auto"
              >
                Export CSV Report
              </button>
            ) : null}
          </div>
        </div>

        {loadError && (
          <div
            role="alert"
            className="rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm text-rose-100"
          >
            <p className="font-bold">Dashboard gagal dimuat</p>
            <p className="mt-1 text-xs text-rose-200">{loadError}</p>
          </div>
        )}

        {/* 4 Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
            <span className="text-slate-400 text-xs font-medium uppercase tracking-wider">
              Total Karyawan Aktif
            </span>
            <div className="text-2xl font-bold text-white">
              {metrics?.totalKaryawan || 0} Orang
            </div>
            <p className="text-[11px] text-slate-500 font-mono">
              Terdaftar di Master Data
            </p>
          </div>

          <div className="bg-slate-900/80 border border-sky-500/40 rounded-2xl p-5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sky-400 text-xs font-medium uppercase tracking-wider">
                Hadir Hari Ini
              </span>
              <span className="px-2 py-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 rounded-full text-[10px] font-mono font-bold">
                {metrics?.persentaseKehadiran || 0}% Rate
              </span>
            </div>
            <div className="text-2xl font-bold text-sky-300">
              {metrics?.hadirHariIni || 0} Orang
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              Status Hadir Berhasil
            </p>
          </div>

          <div className="bg-slate-900/80 border border-amber-500/40 rounded-2xl p-5 space-y-2">
            <span className="text-amber-400 text-xs font-medium uppercase tracking-wider">
              Terlambat Hari Ini
            </span>
            <div className="text-2xl font-bold text-amber-300">
              {metrics?.terlambatHariIni || 0} Orang
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              Datang melebihi toleransi
            </p>
          </div>

          <div className="bg-slate-900/80 border border-rose-500/40 rounded-2xl p-5 space-y-2">
            <span className="text-rose-400 text-xs font-medium uppercase tracking-wider">
              Alfa / Tidak Hadir
            </span>
            <div className="text-2xl font-bold text-rose-300">
              {metrics?.alfaHariIni || 0} Orang
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              Sakit/Izin: {metrics?.sakitIzinHariIni || 0} Orang
            </p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="bg-slate-900/60 p-1.5 border border-slate-800 rounded-xl flex items-center gap-2 max-w-md">
          <button
            type="button"
            onClick={() => setActiveTab("harian")}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === "harian"
                ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Rekap Harian ({selectedDate})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("bulanan")}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === "bulanan"
                ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Rekap Bulanan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("leaderboard")}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === "leaderboard"
                ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Leaderboard
          </button>
        </div>

        {/* Table Data Container */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center space-y-3">
              <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs text-slate-400 font-mono">
                Memuat laporan data...
              </p>
            </div>
          ) : activeTab === "harian" ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono">
                    <th className="p-4">ID / NIK</th>
                    <th className="p-4">Nama Karyawan</th>
                    <th className="p-4">Divisi</th>
                    <th className="p-4">Jam Masuk</th>
                    <th className="p-4">Jam Pulang</th>
                    <th className="p-4">Status Kehadiran</th>
                    <th className="p-4">Menit Telat</th>
                    <th className="p-4">Keterangan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {rekapHarianList.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="p-12 text-center text-slate-500"
                      >
                        Belum ada data absensi harian pada tanggal ini.
                      </td>
                    </tr>
                  ) : (
                    rekapHarianList.map((row) => (
                      <tr
                        key={String(
                          row.id_absensi ??
                            `${row.id_karyawan}-${selectedDate}`,
                        )}
                        className="hover:bg-slate-800/40 transition"
                      >
                        <td className="p-4 text-sky-400 font-bold">
                          {String(row.id_karyawan)}
                        </td>
                        <td className="p-4 text-white font-semibold">
                          {String(row.nama)}
                        </td>
                        <td className="p-4 text-slate-300">
                          {String(row.kelas_divisi)}
                        </td>
                        <td className="p-4 text-slate-300">
                          {String(row.jam_masuk || "-")}
                        </td>
                        <td className="p-4 text-slate-300">
                          {String(row.jam_pulang || "-")}
                        </td>
                        <td className="p-4">
                          <span
                            className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                              row.status_kehadiran === "Hadir"
                                ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                                : row.status_kehadiran === "Alfa"
                                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                  : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                            }`}
                          >
                            {String(row.status_kehadiran)}
                          </span>
                        </td>
                        <td className="p-4 text-amber-300">
                          {Number(row.menit_terlambat) > 0
                            ? `${row.menit_terlambat} mnt`
                            : "-"}
                        </td>
                        <td className="p-4 text-slate-400">
                          {String(row.keterangan || "-")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : activeTab === "bulanan" ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono">
                    <th className="p-4">ID</th>
                    <th className="p-4">Nama</th>
                    <th className="p-4">Divisi</th>
                    <th className="p-4">Hadir</th>
                    <th className="p-4">Total Telat</th>
                    <th className="p-4">Frekuensi Telat</th>
                    <th className="p-4">Sakit</th>
                    <th className="p-4">Izin</th>
                    <th className="p-4">Alfa</th>
                    <th className="p-4">Jam Kerja</th>
                    <th className="p-4">Lembur</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {rekapBulananList.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="p-12 text-center text-slate-500"
                      >
                        Belum ada data akumulasi bulanan.
                      </td>
                    </tr>
                  ) : (
                    rekapBulananList.map((row) => (
                      <tr
                        key={row.idKaryawan}
                        className="hover:bg-slate-800/40 transition"
                      >
                        <td className="p-4 text-sky-400 font-bold">
                          {row.idKaryawan}
                        </td>
                        <td className="p-4 text-white font-semibold">
                          {row.nama}
                        </td>
                        <td className="p-4 text-slate-300">{row.divisi}</td>
                        <td className="p-4 text-sky-300 font-bold">
                          {row.totalHadir} Hari
                        </td>
                        <td className="p-4 text-amber-300">
                          {row.totalTerlambat} Mnt
                        </td>
                        <td className="p-4 text-slate-300">
                          {row.frekuensiTelat}x
                        </td>
                        <td className="p-4 text-sky-300">{row.totalSakit}</td>
                        <td className="p-4 text-purple-300">{row.totalIzin}</td>
                        <td className="p-4 text-rose-400 font-bold">
                          {row.totalAlfa}
                        </td>
                        <td className="p-4 text-slate-300">
                          {row.totalJamKerja} Jam
                        </td>
                        <td className="p-4 text-amber-400 font-bold">
                          {row.totalLembur} Jam
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              {topKaryawanList.map((item, idx) => (
                <div
                  key={String(item.id_karyawan || idx)}
                  className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-amber-500/20 text-amber-400 border border-amber-500/40 rounded-full flex items-center justify-center font-bold text-sm">
                      #{idx + 1}
                    </div>
                    <div>
                      <h4 className="font-bold text-white text-sm">
                        {String(item.nama)}
                      </h4>
                      <p className="text-xs text-slate-400 font-mono">
                        {String(item.divisi)} ({String(item.id_karyawan)})
                      </p>
                    </div>
                  </div>
                  <div className="text-right font-mono">
                    <span className="text-xs text-sky-400 font-bold block">
                      {Number(item.total_kehadiran)} Hari Hadir
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Total Telat: {Number(item.total_telat)} mnt
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
