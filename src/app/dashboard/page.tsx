"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/ui/Icon";
import { AnimatedCounter } from "@/components/visual/AnimatedCounter";
import { AttendanceGaugeGate } from "@/components/visual/AttendanceGaugeGate";
import { AttendanceWeeklyTrend } from "@/components/visual/AttendanceWeeklyTrend";
import { FadeIn } from "@/components/visual/FadeIn";
import { LeaderboardPodium3D } from "@/components/visual/LeaderboardPodium3D";
import { Skeleton } from "@/components/visual/Skeleton";
import { SpotlightCard } from "@/components/visual/SpotlightCard";
import { TiltCard } from "@/components/visual/TiltCard";
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
import { useCompanyName } from "@/lib/hooks/useCompanyName";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function DashboardPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const companyName = useCompanyName();

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

  // ── Data Grid Filters & Pagination ───────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [divisionFilter, setDivisionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<string>("id");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [rowsPerPage, setRowsPerPage] = useState<number>(15);

  // ── Overview data: metrics, bulanan, leaderboard ─────────────────────────
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
          getTopKaryawanTerajin(10),
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
        getTopKaryawanTerajin(10),
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

  const metricsPending = loading && metrics === null;

  // ── Extract Unique Divisions for Filter Dropdown ─────────────────────────
  const availableDivisions = useMemo(() => {
    const set = new Set<string>();
    for (const row of rekapHarianList) {
      const div = String(row.kelas_divisi || row.divisi || "").trim();
      if (div && div !== "-") set.add(div);
    }
    for (const row of rekapBulananList) {
      const div = String(row.divisi || "").trim();
      if (div && div !== "-") set.add(div);
    }
    return Array.from(set).sort();
  }, [rekapHarianList, rekapBulananList]);

  // ── Filtered & Sorted Daily List ─────────────────────────────────────────
  const filteredDailyList = useMemo(() => {
    let list = [...rekapHarianList];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (row) =>
          String(row.nama || "")
            .toLowerCase()
            .includes(q) ||
          String(row.id_karyawan || "")
            .toLowerCase()
            .includes(q) ||
          String(row.kelas_divisi || row.divisi || "")
            .toLowerCase()
            .includes(q),
      );
    }

    if (divisionFilter !== "all") {
      list = list.filter(
        (row) =>
          String(row.kelas_divisi || row.divisi || "").trim() ===
          divisionFilter,
      );
    }

    if (statusFilter !== "all") {
      list = list.filter(
        (row) => String(row.status_kehadiran || "").trim() === statusFilter,
      );
    }

    list.sort((a, b) => {
      let valA: string | number = "";
      let valB: string | number = "";

      if (sortField === "nama") {
        valA = String(a.nama || "").toLowerCase();
        valB = String(b.nama || "").toLowerCase();
      } else if (sortField === "divisi") {
        valA = String(a.kelas_divisi || a.divisi || "").toLowerCase();
        valB = String(b.kelas_divisi || b.divisi || "").toLowerCase();
      } else if (sortField === "jam_masuk") {
        valA = String(a.jam_masuk || "");
        valB = String(b.jam_masuk || "");
      } else if (sortField === "menit_terlambat") {
        valA = Number(a.menit_terlambat || 0);
        valB = Number(b.menit_terlambat || 0);
      } else {
        valA = String(a.id_karyawan || "");
        valB = String(b.id_karyawan || "");
      }

      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [
    rekapHarianList,
    searchQuery,
    divisionFilter,
    statusFilter,
    sortField,
    sortOrder,
  ]);

  // ── Filtered & Sorted Monthly List ───────────────────────────────────────
  const filteredMonthlyList = useMemo(() => {
    let list = [...rekapBulananList];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (row) =>
          row.nama.toLowerCase().includes(q) ||
          row.idKaryawan.toLowerCase().includes(q) ||
          row.divisi.toLowerCase().includes(q),
      );
    }

    if (divisionFilter !== "all") {
      list = list.filter((row) => row.divisi.trim() === divisionFilter);
    }

    list.sort((a, b) => {
      let valA: string | number = "";
      let valB: string | number = "";

      if (sortField === "nama") {
        valA = a.nama.toLowerCase();
        valB = b.nama.toLowerCase();
      } else if (sortField === "divisi") {
        valA = a.divisi.toLowerCase();
        valB = b.divisi.toLowerCase();
      } else if (sortField === "totalHadir") {
        valA = a.totalHadir;
        valB = b.totalHadir;
      } else if (sortField === "totalTerlambat") {
        valA = a.totalTerlambat;
        valB = b.totalTerlambat;
      } else if (sortField === "totalJamKerja") {
        valA = a.totalJamKerja;
        valB = b.totalJamKerja;
      } else {
        valA = a.idKaryawan;
        valB = b.idKaryawan;
      }

      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [rekapBulananList, searchQuery, divisionFilter, sortField, sortOrder]);

  // ── Pagination Calculation ───────────────────────────────────────────────
  const totalItems =
    activeTab === "harian"
      ? filteredDailyList.length
      : filteredMonthlyList.length;
  const effectiveRowsPerPage = rowsPerPage > 0 ? rowsPerPage : totalItems || 1;
  const totalPages = Math.max(1, Math.ceil(totalItems / effectiveRowsPerPage));

  const paginatedDailyList = useMemo(() => {
    if (rowsPerPage <= 0) return filteredDailyList;
    const start = (currentPage - 1) * rowsPerPage;
    return filteredDailyList.slice(start, start + rowsPerPage);
  }, [filteredDailyList, currentPage, rowsPerPage]);

  const paginatedMonthlyList = useMemo(() => {
    if (rowsPerPage <= 0) return filteredMonthlyList;
    const start = (currentPage - 1) * rowsPerPage;
    return filteredMonthlyList.slice(start, start + rowsPerPage);
  }, [filteredMonthlyList, currentPage, rowsPerPage]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  // ── Export Handlers (CSV & Excel) ────────────────────────────────────────
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
        const rows = filteredDailyList.map((row) => [
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
        const rows = filteredMonthlyList.map((row) => [
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
        const rows = filteredDailyList.map((row) => [
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
        const rows = filteredMonthlyList.map((row) => [
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
              Dashboard Rekapitulasi Absensi {companyName}
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
                      ? filteredDailyList.length === 0
                      : filteredMonthlyList.length === 0)
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
                      ? filteredDailyList.length === 0
                      : filteredMonthlyList.length === 0)
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

        {/* 4 Metric Cards with 3D Tilt */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FadeIn className="h-full" delaySeconds={0}>
            <TiltCard maxTilt={8} className="h-full">
              <SpotlightCard>
                <div className="h-full bg-slate-900/80 border border-slate-800 rounded-3xl p-5 space-y-2">
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
                  <p className="text-[11px] text-slate-400 font-mono">
                    Terdaftar di Master Data
                  </p>
                </div>
              </SpotlightCard>
            </TiltCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.06}>
            <TiltCard maxTilt={8} className="h-full">
              <SpotlightCard>
                <div className="h-full bg-slate-900/80 border border-sky-500/40 rounded-3xl p-5 space-y-2">
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
            </TiltCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.12}>
            <TiltCard maxTilt={8} className="h-full">
              <SpotlightCard>
                <div className="h-full bg-slate-900/80 border border-amber-500/40 rounded-3xl p-5 space-y-2">
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
            </TiltCard>
          </FadeIn>

          <FadeIn className="h-full" delaySeconds={0.18}>
            <TiltCard maxTilt={8} className="h-full">
              <SpotlightCard>
                <div className="h-full bg-slate-900/80 border border-rose-500/40 rounded-3xl p-5 space-y-2">
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
            </TiltCard>
          </FadeIn>
        </div>

        {/* Visual Analytics Overview: 3D Gauge & Weekly Trend */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left: 3D Donut Gauge */}
          <div className="lg:col-span-4 flex flex-col justify-between rounded-3xl border border-white/10 bg-slate-900/80 p-5 shadow-xl">
            <div className="border-b border-white/5 pb-3">
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-sky-400">
                Visualisasi Presensi
              </span>
              <h3 className="text-base font-black text-white">
                Proporsi Kehadiran Hari Ini
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Rasio kehadiran tepat waktu, keterlambatan, dan ketidakhadiran.
              </p>
            </div>

            <div className="py-2">
              <AttendanceGaugeGate
                hadir={metrics?.hadirHariIni ?? 0}
                terlambat={metrics?.terlambatHariIni ?? 0}
                sakitIzin={metrics?.sakitIzinHariIni ?? 0}
                alfa={metrics?.alfaHariIni ?? 0}
                total={metrics?.totalKaryawan ?? 1}
                persentase={metrics?.persentaseKehadiran ?? 0}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono border-t border-white/5 pt-3">
              <div className="flex items-center gap-1.5 text-sky-400">
                <span className="size-2 rounded-full bg-sky-400" />
                <span>
                  Tepat Waktu:{" "}
                  {Math.max(
                    0,
                    (metrics?.hadirHariIni ?? 0) -
                      (metrics?.terlambatHariIni ?? 0),
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-amber-400">
                <span className="size-2 rounded-full bg-amber-400" />
                <span>Telat: {metrics?.terlambatHariIni ?? 0}</span>
              </div>
              <div className="flex items-center gap-1.5 text-purple-400">
                <span className="size-2 rounded-full bg-purple-400" />
                <span>Izin: {metrics?.sakitIzinHariIni ?? 0}</span>
              </div>
              <div className="flex items-center gap-1.5 text-rose-400">
                <span className="size-2 rounded-full bg-rose-400" />
                <span>Alfa: {metrics?.alfaHariIni ?? 0}</span>
              </div>
            </div>
          </div>

          {/* Right: Weekly Trend Bars */}
          <div className="lg:col-span-8">
            <AttendanceWeeklyTrend
              rekapHarian={rekapHarianList}
              totalKaryawan={metrics?.totalKaryawan ?? 1}
            />
          </div>
        </div>

        {/* Tab Navigation & Dynamic Filter Controls Bar */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="bg-slate-900/60 p-1.5 border border-slate-800 rounded-2xl flex items-center gap-1.5 w-full xl:w-auto overflow-x-auto">
            <button
              type="button"
              onClick={() => {
                setActiveTab("harian");
                setCurrentPage(1);
              }}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition ${
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
              onClick={() => {
                setActiveTab("bulanan");
                setCurrentPage(1);
              }}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition ${
                activeTab === "bulanan"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Rekap Bulanan
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("leaderboard");
                setCurrentPage(1);
              }}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition ${
                activeTab === "leaderboard"
                  ? "bg-gradient-to-r from-sky-600 to-sky-500 text-white shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Papan Peringkat (Leaderboard)
            </button>
          </div>

          {/* Date Filter Controls Bar */}
          {activeTab === "harian" ? (
            <div className="flex flex-wrap items-center gap-2 bg-slate-900/60 border border-slate-800 p-1.5 rounded-2xl">
              <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/60 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setFilterMode("single")}
                  className={`px-2.5 py-1 rounded-lg font-bold transition ${
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
                  className={`px-2.5 py-1 rounded-lg font-bold transition ${
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
                  className="rounded-xl border border-slate-700 bg-slate-950 px-2.5 py-1 font-mono text-xs text-white outline-none focus:border-sky-500"
                />
              ) : (
                <div className="flex items-center gap-1.5 font-mono text-xs">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-2 py-1 text-white outline-none focus:border-sky-500"
                  />
                  <span className="text-slate-400 text-xs font-sans">s/d</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-2 py-1 text-white outline-none focus:border-sky-500"
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
                  className="px-2 py-1 text-[10px] font-bold rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
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
                  className="px-2 py-1 text-[10px] font-bold rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
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
                  className="px-2 py-1 text-[10px] font-bold rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
                >
                  Bulan Ini
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Search, Filter & Controls Bar for Tables */}
        {activeTab !== "leaderboard" ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-3 shadow-md">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <input
                  type="text"
                  placeholder="Cari nama karyawan, NIK, atau divisi..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 pl-8 text-xs text-white placeholder-slate-500 outline-none focus:border-sky-500 font-sans"
                />
                <span className="absolute left-2.5 top-2 text-slate-500">
                  <svg
                    aria-hidden="true"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="11" cy="11" r="8" strokeWidth="2" />
                    <path
                      d="m21 21-4.35-4.35"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-1.5 text-xs text-slate-400 hover:text-white"
                  >
                    &times;
                  </button>
                ) : null}
              </div>

              {/* Division Filter */}
              {availableDivisions.length > 0 ? (
                <select
                  value={divisionFilter}
                  onChange={(e) => {
                    setDivisionFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-500 font-sans cursor-pointer"
                >
                  <option value="all">Semua Divisi</option>
                  {availableDivisions.map((div) => (
                    <option key={div} value={div}>
                      Divisi: {div}
                    </option>
                  ))}
                </select>
              ) : null}

              {/* Status Filter (Daily only) */}
              {activeTab === "harian" ? (
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-500 font-sans cursor-pointer"
                >
                  <option value="all">Semua Status</option>
                  <option value="Hadir">Hadir</option>
                  <option value="Terlambat">Terlambat</option>
                  <option value="Sakit">Sakit</option>
                  <option value="Izin">Izin</option>
                  <option value="Alfa">Alfa</option>
                </select>
              ) : null}
            </div>

            {/* Rows Per Page Selector */}
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
              <span>Baris:</span>
              <select
                value={rowsPerPage}
                onChange={(e) => {
                  setRowsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="rounded-xl border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500 cursor-pointer"
              >
                <option value={15}>15</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={-1}>Semua ({totalItems})</option>
              </select>
            </div>
          </div>
        ) : null}

        {/* Table Data / Leaderboard Container */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
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
                  <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono select-none">
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("id")}
                    >
                      <div className="flex items-center gap-1">
                        <span>ID / NIK</span>
                        {sortField === "id" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("nama")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Nama Karyawan</span>
                        {sortField === "nama" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("divisi")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Divisi</span>
                        {sortField === "divisi" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("jam_masuk")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Jam Masuk</span>
                        {sortField === "jam_masuk" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th className="p-4">Jam Pulang</th>
                    <th className="p-4">Status Kehadiran</th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("menit_terlambat")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Menit Telat</span>
                        {sortField === "menit_terlambat" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th className="p-4">Keterangan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {paginatedDailyList.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="p-12 text-center text-slate-500 font-sans"
                      >
                        Tidak ada data absensi yang sesuai dengan filter.
                      </td>
                    </tr>
                  ) : (
                    paginatedDailyList.map((row) => (
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
                        <td className="p-4 text-amber-300 font-bold">
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
                  <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono select-none">
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("id")}
                    >
                      <div className="flex items-center gap-1">
                        <span>ID</span>
                        {sortField === "id" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("nama")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Nama</span>
                        {sortField === "nama" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("divisi")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Divisi</span>
                        {sortField === "divisi" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("totalHadir")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Hadir</span>
                        {sortField === "totalHadir" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("totalTerlambat")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Total Telat</span>
                        {sortField === "totalTerlambat" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th className="p-4">Frekuensi Telat</th>
                    <th className="p-4">Sakit</th>
                    <th className="p-4">Izin</th>
                    <th className="p-4">Alfa</th>
                    <th
                      className="p-4 cursor-pointer hover:text-white transition"
                      onClick={() => handleSort("totalJamKerja")}
                    >
                      <div className="flex items-center gap-1">
                        <span>Jam Kerja</span>
                        {sortField === "totalJamKerja" && (
                          <span>{sortOrder === "asc" ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </th>
                    <th className="p-4">Lembur</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {paginatedMonthlyList.length === 0 ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="p-12 text-center text-slate-500 font-sans"
                      >
                        Tidak ada data akumulasi bulanan yang sesuai filter.
                      </td>
                    </tr>
                  ) : (
                    paginatedMonthlyList.map((row) => (
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
                        <td className="p-4 text-amber-300 font-bold">
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
            <div className="p-6">
              <LeaderboardPodium3D topKaryawanList={topKaryawanList} />
            </div>
          )}

          {/* Pagination Footer */}
          {activeTab !== "leaderboard" && totalPages > 1 ? (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/80 p-4 font-mono text-xs text-slate-400">
              <div>
                Menampilkan{" "}
                <span className="font-bold text-white">
                  {(currentPage - 1) * effectiveRowsPerPage + 1}
                </span>{" "}
                -{" "}
                <span className="font-bold text-white">
                  {Math.min(currentPage * effectiveRowsPerPage, totalItems)}
                </span>{" "}
                dari <span className="font-bold text-white">{totalItems}</span>{" "}
                data
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() =>
                    setCurrentPage((prev) => Math.max(1, prev - 1))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                >
                  Sebelumnya
                </button>
                <span className="px-2 font-bold text-sky-400">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() =>
                    setCurrentPage((prev) => Math.min(totalPages, prev + 1))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                >
                  Berikutnya
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
