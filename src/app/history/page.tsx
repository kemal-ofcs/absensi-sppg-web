"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { canAccessArea } from "@/lib/auth/access";
import { exportToCsv, exportToExcel } from "@/lib/client/excel-export";
import { useAuth } from "@/lib/context/AuthContext";
import { getRekapHarian, getRiwayatScan } from "@/lib/gateways/report";
import { useHydrated } from "@/lib/hooks/useHydrated";

const SCAN_PAGE_SIZE = 500;

function today() {
  return new Date().toLocaleDateString("en-CA");
}

function getRelativeDate(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA");
}

function getFirstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatDisplayDate(dateStr: unknown): string {
  if (!dateStr || typeof dateStr !== "string") return "-";
  if (/^\d{2}\/\d{2}\/\d{4}/.test(dateStr)) return dateStr;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return dateStr;
}

function formatDisplayDateTime(dtStr: unknown): string {
  if (!dtStr || typeof dtStr !== "string") return "-";
  if (/^\d{2}\/\d{2}\/\d{4}/.test(dtStr)) return dtStr;
  const d = new Date(dtStr);
  if (Number.isNaN(d.getTime())) return dtStr;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimeOnly(timeStr: unknown): string {
  if (!timeStr || typeof timeStr !== "string") return "-";
  const s = timeStr.trim();
  if (!s) return "-";
  if (s.includes(" ")) {
    const parts = s.split(" ");
    return parts[1] || s;
  }
  if (s.includes("T")) {
    const timePart = s.split("T")[1]?.split(".")[0]?.split("Z")[0];
    return timePart || s;
  }
  return s;
}

function formatMinutesToHours(min: unknown): string {
  const num = Number(min || 0);
  if (num <= 0) return "0 mnt";
  const hours = (num / 60).toFixed(1).replace(/\.0$/, "");
  return `${num} mnt (${hours} jam)`;
}

export default function HistoryPage() {
  const hydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [tab, setTab] = useState<"scan" | "daily">("scan");
  const [tanggalMulai, setTanggalMulai] = useState(today);
  const [tanggalSelesai, setTanggalSelesai] = useState(today);
  const [search, setSearch] = useState("");
  const [selectedDivisi, setSelectedDivisi] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [sortOption, setSortOption] = useState<
    "time_desc" | "time_asc" | "name_asc" | "name_desc" | "division_asc"
  >("time_desc");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data =
        tab === "scan"
          ? await getRiwayatScan({
              tanggal_mulai: tanggalMulai,
              tanggal_selesai: tanggalSelesai,
              limit: SCAN_PAGE_SIZE,
              offset: page * SCAN_PAGE_SIZE,
            })
          : await getRekapHarian({
              tanggal_mulai: tanggalMulai,
              tanggal_selesai: tanggalSelesai,
              divisi: selectedDivisi !== "all" ? selectedDivisi : undefined,
            });
      setRows(data);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Riwayat gagal dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }, [page, tab, tanggalMulai, tanggalSelesai, selectedDivisi]);

  useEffect(() => {
    if (hydrated && isAuthenticated) void load();
  }, [hydrated, isAuthenticated, load]);

  // Extract unique divisions from loaded data for local filtering
  const availableDivisions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const div = String(r.divisi || r.kelas_divisi || "").trim();
      if (div && div !== "-") set.add(div);
    }
    return Array.from(set).sort();
  }, [rows]);

  // Client-side filtering & sorting
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matchesSearch = (r: Record<string, unknown>) => {
      if (!term) return true;
      const combined = [
        r.nama,
        r.id_karyawan,
        r.divisi,
        r.kelas_divisi,
        r.keterangan,
        r.catatan_sistem,
        r.sumber,
        r.sumber_data,
        r.id_sesi,
        r.id_referensi,
        r.kode_operator,
        r.jenis_scan,
        r.status_proses,
        r.status_kehadiran,
        r.status_absen,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return combined.includes(term);
    };

    let result = rows.filter((r) => {
      if (!matchesSearch(r)) return false;

      if (tab === "scan") {
        const matchDiv =
          selectedDivisi === "all" || String(r.divisi || "") === selectedDivisi;
        const matchStatus =
          selectedStatus === "all" ||
          String(r.status_proses || "") === selectedStatus ||
          String(r.jenis_scan || "") === selectedStatus ||
          String(r.keterangan || "") === selectedStatus ||
          (selectedStatus === "Perlu Verifikasi" &&
            (String(r.status_proses || "") === "Perlu Verifikasi" ||
              String(r.keterangan || "").includes("Perlu Verifikasi") ||
              String(r.catatan_sistem || "").includes("Perlu Verifikasi")));
        return matchDiv && matchStatus;
      }

      // Daily attendance tab
      const matchDiv =
        selectedDivisi === "all" ||
        String(r.kelas_divisi || r.divisi || "") === selectedDivisi;
      const matchStatus =
        selectedStatus === "all" ||
        String(r.status_kehadiran || "") === selectedStatus ||
        String(r.status_absen || "") === selectedStatus ||
        (selectedStatus === "Perlu Verifikasi" &&
          (String(r.status_absen || "") === "Perlu Verifikasi" ||
            String(r.status_kehadiran || "") === "Perlu Verifikasi")) ||
        (selectedStatus === "Terlambat" &&
          Number(r.menit_terlambat || 0) > 0) ||
        (selectedStatus === "JamKurang" && Number(r.jam_kerja_kurang || 0) > 0);
      return matchDiv && matchStatus;
    });

    // Sorting
    result = result.slice().sort((a, b) => {
      if (sortOption === "name_asc") {
        return String(a.nama || "").localeCompare(String(b.nama || ""));
      }
      if (sortOption === "name_desc") {
        return String(b.nama || "").localeCompare(String(a.nama || ""));
      }
      if (sortOption === "division_asc") {
        return String(a.divisi || a.kelas_divisi || "").localeCompare(
          String(b.divisi || b.kelas_divisi || ""),
        );
      }

      if (tab === "scan") {
        const timeA = String(a.timestamp_scan || a.tanggal_kerja || "");
        const timeB = String(b.timestamp_scan || b.tanggal_kerja || "");
        const idA = Number(a.id_log || 0);
        const idB = Number(b.id_log || 0);
        if (sortOption === "time_asc") {
          const cmp = timeA.localeCompare(timeB);
          return cmp !== 0 ? cmp : idA - idB;
        }
        // default time_desc
        const cmp = timeB.localeCompare(timeA);
        return cmp !== 0 ? cmp : idB - idA;
      }

      // Tab daily
      const dateA = String(a.tanggal || "");
      const dateB = String(b.tanggal || "");
      const updatedA = String(a.update_terakhir || dateA);
      const updatedB = String(b.update_terakhir || dateB);
      const idA = Number(a.id_absensi || 0);
      const idB = Number(b.id_absensi || 0);

      if (sortOption === "time_asc") {
        const dateCmp = dateA.localeCompare(dateB);
        if (dateCmp !== 0) return dateCmp;
        const timeCmp = String(a.jam_masuk || "").localeCompare(
          String(b.jam_masuk || ""),
        );
        return timeCmp !== 0 ? timeCmp : idA - idB;
      }

      // default time_desc (Latest updated / created comes first)
      const updatedCmp = updatedB.localeCompare(updatedA);
      if (updatedCmp !== 0) return updatedCmp;
      const dateCmp = dateB.localeCompare(dateA);
      return dateCmp !== 0 ? dateCmp : idB - idA;
    });

    return result;
  }, [rows, tab, selectedDivisi, selectedStatus, search, sortOption]);

  // Metric summaries
  const metrics = useMemo(() => {
    if (tab === "scan") {
      const total = rows.length;
      const masuk = rows.filter((r) => r.jenis_scan === "Masuk").length;
      const pulang = rows.filter((r) => r.jenis_scan === "Pulang").length;
      const ditolak = rows.filter(
        (r) => r.status_proses === "Ditolak" || r.jenis_scan === "Ditolak",
      ).length;
      return { total, masuk, pulang, ditolak };
    }
    const total = rows.length;
    const hadir = rows.filter((r) => r.status_kehadiran === "Hadir").length;
    const lengkap = rows.filter((r) => r.status_absen === "Lengkap").length;
    const terlambat = rows.filter(
      (r) => Number(r.menit_terlambat || 0) > 0,
    ).length;
    const jamKurang = rows.filter(
      (r) => Number(r.jam_kerja_kurang || 0) > 0,
    ).length;
    const alfa = rows.filter((r) => r.status_kehadiran === "Alfa").length;
    const izinSakit = rows.filter(
      (r) =>
        r.status_kehadiran === "Izin" ||
        r.status_kehadiran === "Sakit" ||
        r.status_kehadiran === "Dispen",
    ).length;
    return { total, hadir, lengkap, terlambat, jamKurang, alfa, izinSakit };
  }, [rows, tab]);

  const getExportData = useCallback(() => {
    if (tab === "scan") {
      const headers = [
        "Timestamp_Scan",
        "Tanggal",
        "Jam",
        "ID_Unik",
        "Nama",
        "Divisi",
        "Jenis_Scan",
        "Status_Proses",
        "Sumber_Data",
        "Catatan_Sistem",
        "Keterangan",
        "Waktu_Telat",
        "Menit_Datang_Awal",
        "ID_Referensi",
        "Kode_Operator",
      ];
      const dataRows = filteredRows.map((r) => [
        formatDisplayDateTime(r.timestamp_scan),
        formatDisplayDate(r.tanggal_kerja),
        formatTimeOnly(r.jam_scan),
        String(r.id_karyawan || ""),
        String(r.nama || ""),
        String(r.divisi || ""),
        String(r.jenis_scan || ""),
        String(r.status_proses || ""),
        String(r.sumber_data || ""),
        String(r.catatan_sistem || ""),
        String(r.keterangan || ""),
        Number(r.menit_terlambat || 0),
        Number(r.menit_datang_awal || 0),
        String(r.id_referensi || ""),
        String(r.kode_operator || ""),
      ]);
      return {
        filename: `Riwayat_Log_Scan_${tanggalMulai}_sd_${tanggalSelesai}`,
        sheetName: "Log Scan",
        headers,
        rows: dataRows,
      };
    }

    const headers = [
      "Tanggal",
      "ID_Unik",
      "Nama",
      "Divisi",
      "Jam_Masuk",
      "Jam_Pulang",
      "Status_Kehadiran",
      "Status_Absen",
      "Keterangan_Admin",
      "Sumber_Data",
      "Update_Terakhir",
      "Menit_Terlambat",
      "Menit_Datang_Awal",
      "Jam_Kerja",
      "Lembur",
      "Shift",
      "Bulan",
      "Tahun",
      "Jam_Kerja_Kurang",
      "ID_sesi",
      "Mode_Tugas",
      "ID_Backup",
      "ID_Karyawan_Asal",
      "Tanggal_Tugas",
    ];
    const dataRows = filteredRows.map((r) => [
      formatDisplayDate(r.tanggal),
      String(r.id_karyawan || ""),
      String(r.nama || ""),
      String(r.kelas_divisi || r.divisi || ""),
      formatTimeOnly(r.jam_masuk),
      formatTimeOnly(r.jam_pulang),
      String(r.status_kehadiran || ""),
      String(r.status_absen || ""),
      String(r.keterangan || ""),
      String(r.sumber || ""),
      formatDisplayDateTime(r.update_terakhir),
      Number(r.menit_terlambat || 0),
      Number(r.menit_datang_awal || 0),
      Number(r.jam_kerja || 0),
      Number(r.lembur || 0),
      String(r.nama_shift || r.kode_shift || r.id_shift || ""),
      String(r.bulan || ""),
      Number(r.tahun || 0),
      Number(r.jam_kerja_kurang || 0),
      String(r.id_sesi || ""),
      String(r.mode_tugas || "NORMAL"),
      String(r.id_backup || ""),
      String(r.id_karyawan_asal || ""),
      formatDisplayDate(r.tanggal_tugas),
    ]);
    return {
      filename: `Riwayat_Absensi_Harian_${tanggalMulai}_sd_${tanggalSelesai}`,
      sheetName: "Absensi Harian",
      headers,
      rows: dataRows,
    };
  }, [filteredRows, tab, tanggalMulai, tanggalSelesai]);

  const handleExportCSV = async () => {
    if (filteredRows.length === 0) return;
    setExporting(true);
    try {
      const { filename, headers, rows: exportRows } = getExportData();
      const res = await exportToCsv(filename, headers, exportRows);
      if (res.cancelled) return;
      if (res.path) {
        setSuccessMsg(`File CSV berhasil disimpan di: ${res.path}`);
      } else {
        setSuccessMsg("File CSV berhasil diekspor.");
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Gagal mengekspor data CSV.",
      );
    } finally {
      setExporting(false);
    }
  };

  const handleExportExcel = async () => {
    if (filteredRows.length === 0) return;
    setExporting(true);
    try {
      const {
        filename,
        sheetName,
        headers,
        rows: exportRows,
      } = getExportData();
      const res = await exportToExcel(filename, sheetName, headers, exportRows);
      if (res.cancelled) return;
      if (res.path) {
        setSuccessMsg(`File Excel berhasil disimpan di: ${res.path}`);
      } else {
        setSuccessMsg("File Excel berhasil diekspor.");
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Gagal mengekspor data Excel.",
      );
    } finally {
      setExporting(false);
    }
  };

  if (!hydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Riwayat Database...
          </p>
        </div>
      </div>
    );
  }
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "history")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="text-xs uppercase tracking-widest text-sky-400 font-semibold font-mono">
            Audited Database Records
          </span>
          <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
            📜 Riwayat Log Scan & Absensi Harian
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Tinjau seluruh rekaman log scan terminal dan mutasi absensi harian
            tersimpan dengan parameter lengkap.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportCSV}
            disabled={loading || exporting || filteredRows.length === 0}
            className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-sky-300 font-mono font-bold text-xs rounded-xl transition border border-slate-700 shadow-md flex items-center gap-2 disabled:opacity-50"
          >
            <span>📥</span> Ekspor CSV
          </button>
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={loading || exporting || filteredRows.length === 0}
            className="px-4 py-2.5 bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 font-mono font-bold text-xs rounded-xl transition border border-emerald-700/60 shadow-md flex items-center gap-2 disabled:opacity-50"
          >
            <span>📊</span> Ekspor Excel (.xlsx)
          </button>
        </div>
      </div>

      {successMsg ? (
        <FeedbackBanner tone="success" onDismiss={() => setSuccessMsg(null)}>
          {successMsg}
        </FeedbackBanner>
      ) : null}

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError(null)}>
          {error}
        </FeedbackBanner>
      ) : null}

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
        {tab === "scan" ? (
          <>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-slate-400 block uppercase">
                Total Log Scan
              </span>
              <span className="text-lg font-bold text-white">
                {metrics.total}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-emerald-400 block uppercase">
                Scan Masuk
              </span>
              <span className="text-lg font-bold text-emerald-300">
                {metrics.masuk}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-sky-400 block uppercase">
                Scan Pulang
              </span>
              <span className="text-lg font-bold text-sky-300">
                {metrics.pulang}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-rose-400 block uppercase">
                Scan Ditolak
              </span>
              <span className="text-lg font-bold text-rose-300">
                {metrics.ditolak}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-slate-400 block uppercase">
                Total Absensi
              </span>
              <span className="text-lg font-bold text-white">
                {metrics.total}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-emerald-400 block uppercase">
                Hadir Lengkap
              </span>
              <span className="text-lg font-bold text-emerald-300">
                {metrics.lengkap}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-amber-400 block uppercase">
                Terlambat / Jam Kurang
              </span>
              <span className="text-lg font-bold text-amber-300">
                {(metrics.terlambat || 0) + (metrics.jamKurang || 0)}
              </span>
            </div>
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <span className="text-[10px] text-rose-400 block uppercase">
                Alfa / Izin / Sakit
              </span>
              <span className="text-lg font-bold text-rose-300">
                {(metrics.alfa || 0) + (metrics.izinSakit || 0)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Tab Switcher & Filter Toolbar */}
      <div className="space-y-4 rounded-3xl border border-slate-800 bg-slate-900/80 p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
          {/* Main Tabs */}
          <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-2xl border border-slate-800 self-start">
            <button
              type="button"
              onClick={() => {
                setTab("scan");
                setPage(0);
                setSelectedStatus("all");
              }}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition flex items-center gap-2 ${
                tab === "scan"
                  ? "bg-sky-500 text-slate-950 shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>🔍</span> Log Scan
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("daily");
                setPage(0);
                setSelectedStatus("all");
              }}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition flex items-center gap-2 ${
                tab === "daily"
                  ? "bg-sky-500 text-slate-950 shadow-md shadow-sky-950"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>📋</span> Absensi Harian
            </button>
          </div>

          {/* Quick Date Presets */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <button
              type="button"
              onClick={() => {
                setTanggalMulai(today());
                setTanggalSelesai(today());
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg border transition ${
                tanggalMulai === today() && tanggalSelesai === today()
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800"
              }`}
            >
              Hari Ini
            </button>
            <button
              type="button"
              onClick={() => {
                setTanggalMulai(getRelativeDate(-6));
                setTanggalSelesai(today());
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg border transition ${
                tanggalMulai === getRelativeDate(-6) &&
                tanggalSelesai === today()
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800"
              }`}
            >
              7 Hari Terakhir
            </button>
            <button
              type="button"
              onClick={() => {
                setTanggalMulai(getFirstDayOfMonth());
                setTanggalSelesai(today());
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg border transition ${
                tanggalMulai === getFirstDayOfMonth() &&
                tanggalSelesai === today()
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800"
              }`}
            >
              Bulan Ini
            </button>
          </div>
        </div>

        {/* Date Range & Secondary Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 text-xs font-mono pt-2 border-t border-slate-800/80">
          {/* Tanggal Mulai */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-semibold">
              Tanggal Mulai
            </span>
            <input
              type="date"
              value={tanggalMulai}
              onChange={(e) => {
                setTanggalMulai(e.target.value);
                setPage(0);
              }}
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-slate-200 outline-none focus:border-sky-500"
            />
          </div>

          {/* Tanggal Selesai */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-semibold">
              Tanggal Selesai
            </span>
            <input
              type="date"
              value={tanggalSelesai}
              onChange={(e) => {
                setTanggalSelesai(e.target.value);
                setPage(0);
              }}
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-slate-200 outline-none focus:border-sky-500"
            />
          </div>

          {/* Search Box - Live Instant Search */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-semibold">
              Pencarian Cepat
            </span>
            <div className="relative flex items-center">
              <input
                type="text"
                placeholder="ID, Nama, Divisi, Ket..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 pr-8 text-slate-200 outline-none focus:border-sky-500 placeholder:text-slate-600"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 text-slate-400 hover:text-white text-xs px-1"
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>

          {/* Divisi Filter */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-semibold">
              Divisi
            </span>
            <select
              value={selectedDivisi}
              onChange={(e) => {
                setSelectedDivisi(e.target.value);
                setPage(0);
              }}
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-slate-300 outline-none focus:border-sky-500"
            >
              <option value="all">Semua Divisi</option>
              {availableDivisions.map((div) => (
                <option key={div} value={div}>
                  {div}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400 font-semibold">
              Status
            </span>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-slate-300 outline-none focus:border-sky-500"
            >
              <option value="all">Semua Status</option>
              {tab === "scan" ? (
                <>
                  <option value="Berhasil">Status: Berhasil</option>
                  <option value="Perlu Verifikasi">
                    ⚠️ Status: Perlu Verifikasi
                  </option>
                  <option value="Ditolak">Status: Ditolak</option>
                  <option value="Masuk">Scan: Masuk</option>
                  <option value="Pulang">Scan: Pulang</option>
                </>
              ) : (
                <>
                  <option value="Hadir">Kehadiran: Hadir</option>
                  <option value="Lengkap">Absen: Lengkap</option>
                  <option value="Belum Pulang">Absen: Belum Pulang</option>
                  <option value="Perlu Verifikasi">
                    ⚠️ Absen: Perlu Verifikasi
                  </option>
                  <option value="Terlambat">Terlambat Masuk</option>
                  <option value="JamKurang">
                    Pulang Lebih Awal / Jam Kurang
                  </option>
                  <option value="Alfa">Kehadiran: Alfa</option>
                  <option value="Izin">Kehadiran: Izin</option>
                  <option value="Sakit">Kehadiran: Sakit</option>
                  <option value="Dispen">Kehadiran: Dispen</option>
                </>
              )}
            </select>
          </div>

          {/* Sorting Filter: ASC / DESC / Name */}
          <div className="flex flex-col gap-1 sm:col-span-2 md:col-span-3 lg:col-span-5 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-2">
              <span className="text-[11px] text-slate-400 font-semibold flex items-center gap-1.5">
                <span>🔄</span> Urutan Data (Sort Order):
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={sortOption}
                  onChange={(e) =>
                    setSortOption(
                      e.target.value as
                        | "time_desc"
                        | "time_asc"
                        | "name_asc"
                        | "name_desc"
                        | "division_asc",
                    )
                  }
                  className="min-h-9 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs font-mono text-sky-300 font-bold outline-none focus:border-sky-500 shadow-sm"
                >
                  <option value="time_desc">⬇️ Terbaru (DESC)</option>
                  <option value="time_asc">⬆️ Terlama (ASC)</option>
                  <option value="name_asc">🔤 Nama (A - Z)</option>
                  <option value="name_desc">🔤 Nama (Z - A)</option>
                  <option value="division_asc">🏢 Divisi (A - Z)</option>
                </select>

                <button
                  type="button"
                  onClick={() => load()}
                  disabled={loading}
                  className="min-h-9 px-3.5 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded-xl font-bold border border-slate-700 transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <span>🔄</span> Muat Ulang
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Table Container */}
      <div className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3 text-xs font-mono text-slate-400 bg-slate-950/40">
          <span>
            {loading
              ? "Memuat data tabel..."
              : `Menampilkan ${filteredRows.length} baris data (${formatDisplayDate(tanggalMulai)} s/d ${formatDisplayDate(tanggalSelesai)})`}
          </span>
          {search ? (
            <span className="text-sky-400">
              Filter pencarian: &quot;{search}&quot;
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto max-h-[65vh]">
          {tab === "scan" ? (
            /* TAB 1: LOG SCAN TERMINAL */
            <table className="w-full min-w-[1400px] text-left text-xs font-mono">
              <thead className="bg-slate-950 text-slate-400 sticky top-0 z-10 border-b border-slate-800 shadow-md">
                <tr>
                  <th className="p-3.5">Timestamp Scan</th>
                  <th className="p-3.5">Tanggal</th>
                  <th className="p-3.5">Jam</th>
                  <th className="p-3.5">ID Unik</th>
                  <th className="p-3.5">Nama Karyawan</th>
                  <th className="p-3.5">Divisi</th>
                  <th className="p-3.5">Jenis Scan</th>
                  <th className="p-3.5">Status Proses</th>
                  <th className="p-3.5">Sumber Data</th>
                  <th className="p-3.5">Catatan Sistem</th>
                  <th className="p-3.5">Keterangan</th>
                  <th className="p-3.5 text-right">Waktu Telat</th>
                  <th className="p-3.5 text-right">Datang Awal</th>
                  <th className="p-3.5">ID Referensi</th>
                  <th className="p-3.5">Operator</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={15}
                      className="p-8 text-center text-slate-500 font-mono"
                    >
                      {loading
                        ? "Sedang memuat data log scan..."
                        : "Tidak ada data log scan pada filter ini."}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, idx) => (
                    <tr
                      key={String(row.id_log || idx)}
                      className="hover:bg-slate-800/40 transition"
                    >
                      <td className="p-3.5 font-bold text-sky-300 whitespace-nowrap">
                        {formatDisplayDateTime(row.timestamp_scan)}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        {formatDisplayDate(row.tanggal_kerja)}
                      </td>
                      <td className="p-3.5 font-bold text-white whitespace-nowrap">
                        {formatTimeOnly(row.jam_scan)}
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.id_karyawan || "-")}
                      </td>
                      <td className="p-3.5 font-bold text-white whitespace-nowrap">
                        {String(row.nama || "-")}
                      </td>
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.divisi || "-")}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${
                            row.jenis_scan === "Masuk"
                              ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                              : row.jenis_scan === "Pulang"
                                ? "bg-sky-950 text-sky-300 border border-sky-800"
                                : "bg-rose-950 text-rose-300 border border-rose-800"
                          }`}
                        >
                          {String(row.jenis_scan || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                            row.status_proses === "Berhasil"
                              ? "text-emerald-400"
                              : row.status_proses === "Perlu Verifikasi"
                                ? "text-amber-400"
                                : "text-rose-400"
                          }`}
                        >
                          {String(row.status_proses || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.sumber_data || "-")}
                      </td>
                      <td
                        className="p-3.5 text-slate-400 max-w-[200px] truncate"
                        title={String(row.catatan_sistem || "")}
                      >
                        {String(row.catatan_sistem || "-")}
                      </td>
                      <td
                        className="p-3.5 text-slate-300 max-w-[150px] truncate"
                        title={String(row.keterangan || "")}
                      >
                        {String(row.keterangan || "-")}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold text-amber-400">
                        {formatMinutesToHours(row.menit_terlambat)}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold text-emerald-400">
                        {formatMinutesToHours(row.menit_datang_awal)}
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.id_referensi || "-")}
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.kode_operator || "-")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            /* TAB 2: ABSENSI HARIAN */
            <table className="w-full min-w-[2000px] text-left text-xs font-mono">
              <thead className="bg-slate-950 text-slate-400 sticky top-0 z-10 border-b border-slate-800 shadow-md">
                <tr>
                  <th className="p-3.5">Tanggal</th>
                  <th className="p-3.5">ID Unik</th>
                  <th className="p-3.5">Nama Karyawan</th>
                  <th className="p-3.5">Divisi</th>
                  <th className="p-3.5">Jam Masuk</th>
                  <th className="p-3.5">Jam Pulang</th>
                  <th className="p-3.5">Status Kehadiran</th>
                  <th className="p-3.5">Status Absen</th>
                  <th className="p-3.5">Keterangan</th>
                  <th className="p-3.5">Sumber Data</th>
                  <th className="p-3.5">Update Terakhir</th>
                  <th className="p-3.5 text-right">Terlambat</th>
                  <th className="p-3.5 text-right">Datang Awal</th>
                  <th className="p-3.5 text-right">Jam Kerja</th>
                  <th className="p-3.5 text-right">Lembur</th>
                  <th className="p-3.5 text-right">Jam Kurang</th>
                  <th className="p-3.5">Shift</th>
                  <th className="p-3.5">Periode</th>
                  <th className="p-3.5">ID Sesi</th>
                  <th className="p-3.5">Mode</th>
                  <th className="p-3.5">ID Backup</th>
                  <th className="p-3.5">Karyawan Asal</th>
                  <th className="p-3.5">Tanggal Tugas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={23}
                      className="p-8 text-center text-slate-500 font-mono"
                    >
                      {loading
                        ? "Sedang memuat data absensi harian..."
                        : "Tidak ada data absensi harian pada filter ini."}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, idx) => {
                    const lateMin = Number(row.menit_terlambat || 0);
                    const earlyMin = Number(row.menit_datang_awal || 0);
                    const workMin = Number(row.jam_kerja || 0);
                    const otMin = Number(row.lembur || 0);
                    const shortMin = Number(row.jam_kerja_kurang || 0);

                    return (
                      <tr
                        key={String(row.id_absensi || row.id_sesi || idx)}
                        className="hover:bg-slate-800/40 transition"
                      >
                        <td className="p-3.5 font-bold text-sky-300 whitespace-nowrap">
                          {formatDisplayDate(row.tanggal)}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.id_karyawan || "-")}
                        </td>
                        <td className="p-3.5 font-bold text-white whitespace-nowrap">
                          {String(row.nama || "-")}
                        </td>
                        <td className="p-3.5 text-slate-300 whitespace-nowrap">
                          {String(row.kelas_divisi || row.divisi || "-")}
                        </td>
                        <td className="p-3.5 font-bold text-emerald-400 whitespace-nowrap">
                          {formatTimeOnly(row.jam_masuk)}
                        </td>
                        <td className="p-3.5 font-bold text-sky-400 whitespace-nowrap">
                          {formatTimeOnly(row.jam_pulang)}
                        </td>
                        <td className="p-3.5 whitespace-nowrap">
                          <span
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${
                              row.status_kehadiran === "Hadir"
                                ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                                : row.status_kehadiran === "Alfa"
                                  ? "bg-rose-950 text-rose-300 border border-rose-800"
                                  : "bg-amber-950 text-amber-300 border border-amber-800"
                            }`}
                          >
                            {String(row.status_kehadiran || "-")}
                          </span>
                        </td>
                        <td className="p-3.5 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                              row.status_absen === "Lengkap"
                                ? "text-emerald-400"
                                : row.status_absen === "Belum Pulang"
                                  ? "text-sky-400"
                                  : row.status_absen === "Perlu Verifikasi"
                                    ? "text-amber-400"
                                    : "text-rose-400"
                            }`}
                          >
                            {String(row.status_absen || "-")}
                          </span>
                        </td>
                        <td
                          className="p-3.5 text-slate-300 max-w-[160px] truncate"
                          title={String(row.keterangan || "")}
                        >
                          {String(row.keterangan || "-")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.sumber || "-")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap text-[11px]">
                          {formatDisplayDateTime(row.update_terakhir)}
                        </td>
                        <td className="p-3.5 text-right whitespace-nowrap font-bold text-rose-400">
                          {lateMin > 0 ? formatMinutesToHours(lateMin) : "0"}
                        </td>
                        <td className="p-3.5 text-right whitespace-nowrap font-bold text-emerald-400">
                          {earlyMin > 0 ? formatMinutesToHours(earlyMin) : "0"}
                        </td>
                        <td className="p-3.5 text-right whitespace-nowrap font-bold text-white">
                          {workMin > 0 ? formatMinutesToHours(workMin) : "0"}
                        </td>
                        <td className="p-3.5 text-right whitespace-nowrap font-bold text-sky-400">
                          {otMin > 0 ? `+${formatMinutesToHours(otMin)}` : "0"}
                        </td>
                        <td className="p-3.5 text-right whitespace-nowrap font-bold text-amber-400">
                          {shortMin > 0 ? formatMinutesToHours(shortMin) : "0"}
                        </td>
                        <td className="p-3.5 text-slate-300 whitespace-nowrap">
                          {String(
                            row.nama_shift ||
                              row.kode_shift ||
                              row.id_shift ||
                              "-",
                          )}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.bulan || "-")}/{String(row.tahun || "-")}
                        </td>
                        <td
                          className="p-3.5 text-slate-500 text-[11px] max-w-[120px] truncate"
                          title={String(row.id_sesi || "")}
                        >
                          {String(row.id_sesi || "-")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.mode_tugas || "NORMAL")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.id_backup || "-")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {String(row.id_karyawan_asal || "-")}
                        </td>
                        <td className="p-3.5 text-slate-400 whitespace-nowrap">
                          {formatDisplayDate(row.tanggal_tugas)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}
