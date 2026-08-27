"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/ui/Icon";
import { AnimatedCounter } from "@/components/visual/AnimatedCounter";
import { FadeIn } from "@/components/visual/FadeIn";
import { Skeleton } from "@/components/visual/Skeleton";
import { SpotlightCard } from "@/components/visual/SpotlightCard";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { exportToCsv, exportToExcel } from "@/lib/client/excel-export";
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
  const [filterMode, setFilterMode] = useState<"single" | "range">("single");
  const [startDate, setStartDate] = useState<string>(
    new Date().toLocaleDateString("en-CA"),
  );
  const [endDate, setEndDate] = useState<string>(
    new Date().toLocaleDateString("en-CA"),
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
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  // ── Overview data: metrics, bulanan, leaderboard ─────────────────────────
  // Only fetched once after authentication.
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

  // ── Harian data: rekap per-tanggal / rentang ───────────────────────────────
  const [harianLoading, setHarianLoading] = useState(false);
  const loadHarianData = useCallback(async () => {
    if (!isHydrated || !isAuthenticated) return;
    setHarianLoading(true);
    try {
      const filter =
        filterMode === "range"
          ? { tanggal_mulai: startDate, tanggal_selesai: endDate }
          : { tanggal: startDate };
      const harianData = await getRekapHarian(filter);
      setRekapHarianList(harianData);
    } catch {
      // Silently ignore harian load errors
    } finally {
      setHarianLoading(false);
    }
  }, [isHydrated, isAuthenticated, filterMode, startDate, endDate]);

  useEffect(() => {
    void loadHarianData();
  }, [loadHarianData]);

  // Re-fetch dashboard data automatically when auto-sync pulls new scans from Cloud
  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;

    const onSyncCompleted = () => {
      Promise.all([
        getDashboardMetrics(),
        getRekapBulanan(),
        getTopKaryawanTerajin(5),
        getRekapHarian(
          filterMode === "range"
            ? { tanggal_mulai: startDate, tanggal_selesai: endDate }
            : { tanggal: startDate },
        ),
      ])
        .then(([metricsData, bulananData, topData, harianData]) => {
          setMetrics(metricsData);
          setRekapBulananList(bulananData);
          setTopKaryawanList(topData);
          setRekapHarianList(harianData);
        })
        .catch(() => undefined);
    };

    window.addEventListener("sppg:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("sppg:sync-completed", onSyncCompleted);
    };
  }, [isHydrated, isAuthenticated, filterMode, startDate, endDate]);

  // Combined loading state for skeleton rendering
  const isLoading = useMemo(
    () => loading || harianLoading,
    [loading, harianLoading],
  );

  // Metrik belum pernah tiba: tampilkan penanda tempat, bukan angka 0 yang
  // terbaca seperti hasil sebenarnya.
  const metricsPending = loading && metrics === null;

  // ── Export Handlers (CSV & Excel) with file save picker ───────────────────
  const handleExportCSV = async () => {
    if (!hasPermission(user, "dashboard.export")) return;
    setExportMessage(null);
    try {
      if (activeTab === "harian") {
        const filename =
          filterMode === "range" && startDate !== endDate
            ? `Rekap_Harian_${startDate}_sd_${endDate}.csv`
            : `Rekap_Harian_${startDate}.csv`;
        const headers = [
          "ID / NIK",
          "Nama Karyawan",
          "Divisi",
          "Tanggal",
          "Jam Masuk",
          "Jam Pulang",
          "Status Kehadiran",
          "Menit Terlambat",
          "Keterangan",
        ];
        const rows = rekapHarianList.map((row) => [
          String(row.id_karyawan ?? ""),
          String(row.nama ?? ""),
          String(row.kelas_divisi ?? row.divisi ?? ""),
          String(row.tanggal ?? startDate),
          String(row.jam_masuk ?? "-"),
          String(row.jam_pulang ?? "-"),
          String(row.status_kehadiran ?? ""),
          Number(row.menit_terlambat ?? 0),
          String(row.keterangan ?? "-"),
        ]);
        const res = await exportToCsv(filename, headers, rows);
        if (res.sukses) {
          setExportMessage(
            `Berkas CSV berhasil disimpan: ${res.filename || filename}`,
          );
        }
      } else if (activeTab === "bulanan") {
        const filename = `Rekap_Bulanan_Absensi_${new Date().toLocaleDateString("en-CA")}.csv`;
        const headers = [
          "ID Karyawan",
          "Nama",
          "Divisi",
          "Total Hadir",
          "Total Telat (Menit)",
          "Frekuensi Telat",
          "Total Sakit",
          "Total Izin",
          "Total Alfa",
          "Total Jam Kerja",
          "Total Lembur",
        ];
        const rows = rekapBulananList.map((row) => [
          row.idKaryawan,
          row.nama,
          row.divisi,
          row.totalHadir,
          row.totalTerlambat,
          row.frekuensiTelat,
          row.totalSakit,
          row.totalIzin,
          row.totalAlfa,
          row.totalJamKerja,
          row.totalLembur,
        ]);
        const res = await exportToCsv(filename, headers, rows);
        if (res.sukses) {
          setExportMessage(
            `Berkas CSV berhasil disimpan: ${res.filename || filename}`,
          );
        }
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Gagal mengekspor data CSV.",
      );
    }
  };

  const handleExportExcel = async () => {
    if (!hasPermission(user, "dashboard.export")) return;
    setExportMessage(null);
    try {
      if (activeTab === "harian") {
        const filename =
          filterMode === "range" && startDate !== endDate
            ? `Rekap_Harian_${startDate}_sd_${endDate}.xlsx`
            : `Rekap_Harian_${startDate}.xlsx`;
        const headers = [
          "ID / NIK",
          "Nama Karyawan",
          "Divisi",
          "Tanggal",
          "Jam Masuk",
          "Jam Pulang",
          "Status Kehadiran",
          "Menit Terlambat",
          "Keterangan",
        ];
        const rows = rekapHarianList.map((row) => [
          String(row.id_karyawan ?? ""),
          String(row.nama ?? ""),
          String(row.kelas_divisi ?? row.divisi ?? ""),
          String(row.tanggal ?? startDate),
          String(row.jam_masuk ?? "-"),
          String(row.jam_pulang ?? "-"),
          String(row.status_kehadiran ?? ""),
          Number(row.menit_terlambat ?? 0),
          String(row.keterangan ?? "-"),
        ]);
        const res = await exportToExcel(
          filename,
          "Rekap Harian",
          headers,
          rows,
        );
        if (res.sukses) {
          setExportMessage(
            `Berkas Excel berhasil disimpan: ${res.filename || filename}`,
          );
        }
      } else if (activeTab === "bulanan") {
        const filename = `Rekap_Bulanan_Absensi_${new Date().toLocaleDateString("en-CA")}.xlsx`;
        const headers = [
          "ID Karyawan",
          "Nama",
          "Divisi",
          "Total Hadir",
          "Total Telat (Menit)",
          "Frekuensi Telat",
          "Total Sakit",
          "Total Izin",
          "Total Alfa",
          "Total Jam Kerja",
          "Total Lembur",
        ];
        const rows = rekapBulananList.map((row) => [
          row.idKaryawan,
          row.nama,
          row.divisi,
          row.totalHadir,
          row.totalTerlambat,
          row.frekuensiTelat,
          row.totalSakit,
          row.totalIzin,
          row.totalAlfa,
          row.totalJamKerja,
          row.totalLembur,
        ]);
        const res = await exportToExcel(
          filename,
          "Rekap Bulanan",
          headers,
          rows,
        );
        if (res.sukses) {
          setExportMessage(
            `Berkas Excel berhasil disimpan: ${res.filename || filename}`,
          );
        }
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Gagal mengekspor data Excel.",
      );
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
        {/* Top Header Navigation with Action Buttons */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <span className="text-xs uppercase tracking-widest text-amber-400 font-semibold font-mono">
              Executive Analytics & Reports
            </span>
            <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
              Dashboard Rekapitulasi Absensi SPPG
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasPermission(user, "dashboard.export") ? (
              <>
                <button
                  type="button"
                  onClick={handleExportCSV}
                  disabled={
                    isLoading ||
                    (activeTab === "harian"
                      ? rekapHarianList.length === 0
                      : rekapBulananList.length === 0)
                  }
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-bold text-sky-200 shadow-md transition hover:bg-slate-700 disabled:opacity-50"
                >
                  <Icon name="download" className="size-3.5" />
                  <span>Ekspor CSV</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportExcel}
                  disabled={
                    isLoading ||
                    (activeTab === "harian"
                      ? rekapHarianList.length === 0
                      : rekapBulananList.length === 0)
                  }
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg shadow-emerald-950/60 transition hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50"
                >
                  <Icon name="document" className="size-3.5" />
                  <span>Ekspor Excel (.xlsx)</span>
                </button>
              </>
            ) : null}
          </div>
        </div>

        {exportMessage ? (
          <output className="rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-100 flex items-center justify-between">
            <p className="font-bold">{exportMessage}</p>
            <button
              type="button"
              onClick={() => setExportMessage(null)}
              className="text-xs text-emerald-300 hover:text-white"
            >
              &times;
            </button>
          </output>
        ) : null}

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
          <FadeIn className="h-full" delaySeconds={0}>
            <SpotlightCard>
              <div className="h-full bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-2">
                <span className="text-slate-400 text-xs font-medium uppercase tracking-wider">
                  Total Karyawan Aktif
                </span>
                <div className="text-2xl font-bold text-white">
                  {metricsPending ? (
                    <Skeleton className="h-7 w-28" />
                  ) : (
                    <AnimatedCounter
                      suffix=" Orang"
                      value={metrics?.totalKaryawan ?? 0}
                    />
                  )}
                </div>
                <p className="text-[11px] text-slate-500 font-mono">
                  Terdaftar di Master Data
                </p>
              </div>
            </SpotlightCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.06}>
            <SpotlightCard>
              <div className="h-full bg-slate-900/80 border border-sky-500/40 rounded-2xl p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sky-400 text-xs font-medium uppercase tracking-wider">
                    Hadir Hari Ini
                  </span>
                  <span className="px-2 py-0.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 rounded-full text-[10px] font-mono font-bold">
                    {metrics?.persentaseKehadiran || 0}% Rate
                  </span>
                </div>
                <div className="text-2xl font-bold text-sky-300">
                  {metricsPending ? (
                    <Skeleton className="h-7 w-28" />
                  ) : (
                    <AnimatedCounter
                      suffix=" Orang"
                      value={metrics?.hadirHariIni ?? 0}
                    />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 font-mono">
                  Status Hadir Berhasil
                </p>
              </div>
            </SpotlightCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.12}>
            <SpotlightCard>
              <div className="h-full bg-slate-900/80 border border-amber-500/40 rounded-2xl p-5 space-y-2">
                <span className="text-amber-400 text-xs font-medium uppercase tracking-wider">
                  Terlambat Hari Ini
                </span>
                <div className="text-2xl font-bold text-amber-300">
                  {metricsPending ? (
                    <Skeleton className="h-7 w-28" />
                  ) : (
                    <AnimatedCounter
                      suffix=" Orang"
                      value={metrics?.terlambatHariIni ?? 0}
                    />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 font-mono">
                  Datang melebihi toleransi
                </p>
              </div>
            </SpotlightCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.18}>
            <SpotlightCard>
              <div className="h-full bg-slate-900/80 border border-rose-500/40 rounded-2xl p-5 space-y-2">
                <span className="text-rose-400 text-xs font-medium uppercase tracking-wider">
                  Alfa / Tidak Hadir
                </span>
                <div className="text-2xl font-bold text-rose-300">
                  {metricsPending ? (
                    <Skeleton className="h-7 w-28" />
                  ) : (
                    <AnimatedCounter
                      suffix=" Orang"
                      value={metrics?.alfaHariIni ?? 0}
                    />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 font-mono">
                  Sakit/Izin: {metrics?.sakitIzinHariIni || 0} Orang
                </p>
              </div>
            </SpotlightCard>
          </FadeIn>
        </div>

        {/* Tab Navigation & Dynamic Filter Controls Bar */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="bg-slate-900/60 p-1.5 border border-slate-800 rounded-xl flex items-center gap-1.5 w-full xl:w-auto overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab("harian")}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
                activeTab === "harian"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {filterMode === "single" || startDate === endDate
                ? `Rekap Harian (${startDate})`
                : `Rekap (${startDate} s/d ${endDate})`}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("bulanan")}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
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
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
                activeTab === "leaderboard"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Leaderboard
            </button>
          </div>

          {/* Date Filter Controls Bar (Right side of Tab Bar) */}
          {activeTab === "harian" ? (
            <div className="flex flex-wrap items-center gap-2 bg-slate-900/60 border border-slate-800 p-1.5 rounded-xl">
              <div className="inline-flex rounded-lg border border-white/10 bg-slate-950/60 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setFilterMode("single")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition ${
                    filterMode === "single"
                      ? "bg-sky-500 text-white shadow-sm"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  1 Tanggal
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode("range")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition ${
                    filterMode === "range"
                      ? "bg-sky-500 text-white shadow-sm"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Rentang
                </button>
              </div>

              {filterMode === "single" ? (
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setEndDate(e.target.value);
                  }}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 font-mono text-xs text-white outline-none focus:border-sky-500"
                />
              ) : (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-white outline-none focus:border-sky-500"
                  />
                  <span className="text-slate-400 text-xs font-sans">s/d</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-white outline-none focus:border-sky-500"
                  />
                </div>
              )}

              {/* Quick Presets */}
              <div className="hidden sm:flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const today = new Date().toLocaleDateString("en-CA");
                    setStartDate(today);
                    setEndDate(today);
                    setFilterMode("single");
                  }}
                  className="px-2 py-1 text-[10px] font-semibold rounded-md border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
                >
                  Hari Ini
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date();
                    const past = new Date(
                      now.getTime() - 6 * 24 * 60 * 60 * 1000,
                    );
                    setStartDate(past.toLocaleDateString("en-CA"));
                    setEndDate(now.toLocaleDateString("en-CA"));
                    setFilterMode("range");
                  }}
                  className="px-2 py-1 text-[10px] font-semibold rounded-md border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
                >
                  7 Hari
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date();
                    const firstDay = new Date(
                      now.getFullYear(),
                      now.getMonth(),
                      1,
                    ).toLocaleDateString("en-CA");
                    setStartDate(firstDay);
                    setEndDate(now.toLocaleDateString("en-CA"));
                    setFilterMode("range");
                  }}
                  className="px-2 py-1 text-[10px] font-semibold rounded-md border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
                >
                  Bulan Ini
                </button>
              </div>
            </div>
          ) : null}
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
                            `${row.id_karyawan}-${row.tanggal || startDate}`,
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
                          {String(row.kelas_divisi || row.divisi || "-")}
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
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                : row.status_kehadiran === "Terlambat"
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                                  : row.status_kehadiran === "Alfa"
                                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                    : "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                            }`}
                          >
                            {String(row.status_kehadiran || "-")}
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
