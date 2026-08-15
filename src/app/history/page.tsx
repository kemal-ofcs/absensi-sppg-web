"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { getRekapHarian, getRiwayatScan } from "@/lib/gateways/report";
import { useHydrated } from "@/lib/hooks/useHydrated";

const SCAN_PAGE_SIZE = 100;

function today() {
  return new Date().toLocaleDateString("en-CA");
}

function getRelativeDate(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA");
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
  const [tanggal, setTanggal] = useState(today);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedDivisi, setSelectedDivisi] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data =
        tab === "scan"
          ? await getRiwayatScan({
              tanggal,
              search: appliedSearch,
              limit: SCAN_PAGE_SIZE,
              offset: page * SCAN_PAGE_SIZE,
            })
          : await getRekapHarian({
              tanggal,
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
  }, [appliedSearch, page, tab, tanggal, selectedDivisi]);

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

  // Client-side filtering for status or quick filter
  const filteredRows = useMemo(() => {
    if (tab === "scan") {
      if (selectedStatus === "all" && selectedDivisi === "all") return rows;
      return rows.filter((r) => {
        const matchDiv =
          selectedDivisi === "all" || String(r.divisi || "") === selectedDivisi;
        const matchStatus =
          selectedStatus === "all" ||
          String(r.status_proses || "") === selectedStatus ||
          String(r.jenis_scan || "") === selectedStatus;
        return matchDiv && matchStatus;
      });
    }

    // Daily attendance tab
    return rows.filter((r) => {
      const matchDiv =
        selectedDivisi === "all" ||
        String(r.kelas_divisi || r.divisi || "") === selectedDivisi;
      const matchStatus =
        selectedStatus === "all" ||
        String(r.status_kehadiran || "") === selectedStatus ||
        String(r.status_absen || "") === selectedStatus ||
        (selectedStatus === "Terlambat" &&
          Number(r.menit_terlambat || 0) > 0) ||
        (selectedStatus === "JamKurang" && Number(r.jam_kerja_kurang || 0) > 0);
      return matchDiv && matchStatus;
    });
  }, [rows, tab, selectedDivisi, selectedStatus]);

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

  const handleExportCSV = () => {
    if (filteredRows.length === 0) return;

    let csvContent = "";
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
      csvContent += `${headers.join(",")}\n`;
      for (const r of filteredRows) {
        const row = [
          `"${formatDisplayDateTime(r.timestamp_scan)}"`,
          `"${formatDisplayDate(r.tanggal_kerja)}"`,
          `"${String(r.jam_scan || "")}"`,
          `"${String(r.id_karyawan || "")}"`,
          `"${String(r.nama || "")}"`,
          `"${String(r.divisi || "")}"`,
          `"${String(r.jenis_scan || "")}"`,
          `"${String(r.status_proses || "")}"`,
          `"${String(r.sumber_data || "")}"`,
          `"${String(r.catatan_sistem || "").replace(/"/g, '""')}"`,
          `"${String(r.keterangan || "").replace(/"/g, '""')}"`,
          Number(r.menit_terlambat || 0),
          Number(r.menit_datang_awal || 0),
          `"${String(r.id_referensi || "")}"`,
          `"${String(r.kode_operator || "")}"`,
        ];
        csvContent += `${row.join(",")}\n`;
      }
    } else {
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
      csvContent += `${headers.join(",")}\n`;
      for (const r of filteredRows) {
        const row = [
          `"${formatDisplayDate(r.tanggal)}"`,
          `"${String(r.id_karyawan || "")}"`,
          `"${String(r.nama || "")}"`,
          `"${String(r.kelas_divisi || r.divisi || "")}"`,
          `"${String(r.jam_masuk || "")}"`,
          `"${String(r.jam_pulang || "")}"`,
          `"${String(r.status_kehadiran || "")}"`,
          `"${String(r.status_absen || "")}"`,
          `"${String(r.keterangan || "").replace(/"/g, '""')}"`,
          `"${String(r.sumber || "")}"`,
          `"${formatDisplayDateTime(r.update_terakhir)}"`,
          Number(r.menit_terlambat || 0),
          Number(r.menit_datang_awal || 0),
          Number(r.jam_kerja || 0),
          Number(r.lembur || 0),
          `"${String(r.nama_shift || r.kode_shift || r.id_shift || "")}"`,
          `"${String(r.bulan || "")}"`,
          Number(r.tahun || 0),
          Number(r.jam_kerja_kurang || 0),
          `"${String(r.id_sesi || "")}"`,
          `"${String(r.mode_tugas || "NORMAL")}"`,
          `"${String(r.id_backup || "")}"`,
          `"${String(r.id_karyawan_asal || "")}"`,
          `"${formatDisplayDate(r.tanggal_tugas)}"`,
        ];
        csvContent += `${row.join(",")}\n`;
      }
    }

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `Riwayat_${tab === "scan" ? "Log_Scan" : "Absensi_Harian"}_${tanggal}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

        <button
          type="button"
          onClick={handleExportCSV}
          disabled={loading || filteredRows.length === 0}
          className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-sky-300 font-mono font-bold text-xs rounded-xl transition border border-slate-700 shadow-md flex items-center gap-2 disabled:opacity-50"
        >
          <span>📥</span> Ekspor Data CSV
        </button>
      </div>

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
                Terlambat Masuk
              </span>
              <span className="text-lg font-bold text-amber-300">
                {metrics.terlambat}
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
              <span>🔍</span> Log Scan Terminal ({metrics.total})
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
              <span>📋</span> Absensi Harian (
              {tab === "daily" ? metrics.total : rows.length})
            </button>
          </div>

          {/* Quick Date Presets */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <button
              type="button"
              onClick={() => {
                setTanggal(today());
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg border transition ${
                tanggal === today()
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800"
              }`}
            >
              Hari Ini
            </button>
            <button
              type="button"
              onClick={() => {
                setTanggal(getRelativeDate(-1));
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg border transition ${
                tanggal === getRelativeDate(-1)
                  ? "bg-sky-500/20 text-sky-300 border-sky-500/50"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800"
              }`}
            >
              Kemarin
            </button>
            <input
              type="date"
              value={tanggal}
              onChange={(e) => {
                setTanggal(e.target.value);
                setPage(0);
              }}
              className="min-h-9 rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-white outline-none focus:border-sky-400"
            />
          </div>
        </div>

        {/* Filters & Search Row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-4 gap-3 pt-3 border-t border-slate-800 text-xs font-mono">
          {/* Search Input */}
          <div className="sm:col-span-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedSearch(search.trim());
                setPage(0);
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nama, ID unik, divisi, operator, atau sesi..."
                className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 text-white placeholder:text-slate-600 outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                className="px-4 min-h-10 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded-xl font-bold border border-slate-700 transition"
              >
                Cari
              </button>
            </form>
          </div>

          {/* Divisi Filter */}
          <div>
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
          <div>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-slate-300 outline-none focus:border-sky-500"
            >
              <option value="all">Semua Status</option>
              {tab === "scan" ? (
                <>
                  <option value="Berhasil">Status: Berhasil</option>
                  <option value="Ditolak">Status: Ditolak</option>
                  <option value="Masuk">Scan: Masuk</option>
                  <option value="Pulang">Scan: Pulang</option>
                </>
              ) : (
                <>
                  <option value="Hadir">Kehadiran: Hadir</option>
                  <option value="Lengkap">Absen: Lengkap</option>
                  <option value="Terlambat">Terlambat Masuk</option>
                  <option value="JamKurang">
                    Pulang Lebih Awal / Jam Kurang
                  </option>
                  <option value="Alfa">Kehadiran: Alfa</option>
                  <option value="Izin">Kehadiran: Izin</option>
                  <option value="Sakit">Kehadiran: Sakit</option>
                </>
              )}
            </select>
          </div>
        </div>
      </div>

      {/* Main Table Container */}
      <div className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3 text-xs font-mono text-slate-400 bg-slate-950/40">
          <span>
            {loading
              ? "Memuat data tabel..."
              : `Menampilkan ${filteredRows.length} baris data pada tanggal ${formatDisplayDate(tanggal)}`}
          </span>
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
                  <th className="p-3.5">Kode Operator</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {!loading && filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={15}
                      className="p-16 text-center text-slate-500 font-sans"
                    >
                      Tidak ada rekaman log scan pada tanggal{" "}
                      {formatDisplayDate(tanggal)}.
                    </td>
                  </tr>
                ) : null}
                {filteredRows.map((row, index) => {
                  const late = Number(row.menit_terlambat || 0);
                  const early = Number(row.menit_datang_awal || 0);
                  const isRejected =
                    row.status_proses === "Ditolak" ||
                    row.jenis_scan === "Ditolak";

                  return (
                    <tr
                      key={String(
                        row.id_log ||
                          `${row.timestamp_scan}-${row.id_karyawan}-${index}`,
                      )}
                      className={`hover:bg-slate-800/60 transition ${
                        isRejected ? "bg-rose-950/20" : ""
                      }`}
                    >
                      <td className="p-3.5 text-sky-300 font-semibold whitespace-nowrap">
                        {formatDisplayDateTime(row.timestamp_scan)}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        {formatDisplayDate(row.tanggal_kerja)}
                      </td>
                      <td className="p-3.5 text-amber-400 font-bold whitespace-nowrap">
                        {String(row.jam_scan || "-")}
                      </td>
                      <td className="p-3.5 text-slate-300 font-bold whitespace-nowrap">
                        {String(row.id_karyawan || "-")}
                      </td>
                      <td className="p-3.5 font-bold text-white font-sans whitespace-nowrap">
                        {String(row.nama || "-")}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-slate-800 text-slate-300 rounded-md text-[11px]">
                          {String(row.divisi || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                            row.jenis_scan === "Masuk"
                              ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                              : row.jenis_scan === "Pulang"
                                ? "bg-sky-500/20 text-sky-300 border-sky-500/40"
                                : "bg-rose-500/20 text-rose-300 border-rose-500/40"
                          }`}
                        >
                          {String(row.jenis_scan || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold ${
                            row.status_proses === "Berhasil"
                              ? "text-emerald-400 bg-emerald-950/60 border border-emerald-800"
                              : "text-rose-400 bg-rose-950/60 border border-rose-800"
                          }`}
                        >
                          {String(row.status_proses || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 whitespace-nowrap text-slate-400">
                        {String(row.sumber_data || "Scanner")}
                      </td>
                      <td
                        className="p-3.5 text-slate-300 max-w-xs truncate"
                        title={String(row.catatan_sistem || "")}
                      >
                        {String(row.catatan_sistem || "-")}
                      </td>
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.keterangan || "-")}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold">
                        {late > 0 ? (
                          <span className="text-rose-400">+{late} mnt</span>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold">
                        {early > 0 ? (
                          <span className="text-emerald-400">+{early} mnt</span>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
                      </td>
                      <td className="p-3.5 text-slate-400 text-[11px] whitespace-nowrap">
                        {String(row.id_referensi || "-")}
                      </td>
                      <td className="p-3.5 text-slate-400 text-[11px] whitespace-nowrap">
                        {String(row.kode_operator || "-")}
                      </td>
                    </tr>
                  );
                })}
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
                  <th className="p-3.5">Keterangan Admin</th>
                  <th className="p-3.5">Sumber Data</th>
                  <th className="p-3.5">Update Terakhir</th>
                  <th className="p-3.5 text-right">Menit Terlambat</th>
                  <th className="p-3.5 text-right">Datang Awal</th>
                  <th className="p-3.5 text-right">Jam Kerja</th>
                  <th className="p-3.5 text-right">Lembur</th>
                  <th className="p-3.5 text-right">Jam Kerja Kurang</th>
                  <th className="p-3.5">Shift</th>
                  <th className="p-3.5">Bulan / Tahun</th>
                  <th className="p-3.5">ID Sesi</th>
                  <th className="p-3.5">Mode Tugas</th>
                  <th className="p-3.5">Info Backup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {!loading && filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={21}
                      className="p-16 text-center text-slate-500 font-sans"
                    >
                      Tidak ada rekaman absensi harian pada tanggal{" "}
                      {formatDisplayDate(tanggal)}.
                    </td>
                  </tr>
                ) : null}
                {filteredRows.map((row, index) => {
                  const late = Number(row.menit_terlambat || 0);
                  const early = Number(row.menit_datang_awal || 0);
                  const workMin = Number(row.jam_kerja || 0);
                  const otMin = Number(row.lembur || 0);
                  const shortMin = Number(row.jam_kerja_kurang || 0);
                  const isBackup = row.mode_tugas === "BACKUP";

                  return (
                    <tr
                      key={String(
                        row.id_sesi ||
                          row.id_absensi ||
                          `${row.tanggal}-${row.id_karyawan}-${index}`,
                      )}
                      className={`hover:bg-slate-800/60 transition ${
                        isBackup ? "bg-indigo-950/20" : ""
                      }`}
                    >
                      <td className="p-3.5 text-sky-300 font-semibold whitespace-nowrap">
                        {formatDisplayDate(row.tanggal)}
                      </td>
                      <td className="p-3.5 text-slate-300 font-bold whitespace-nowrap">
                        {String(row.id_karyawan || "-")}
                      </td>
                      <td className="p-3.5 font-bold text-white font-sans whitespace-nowrap">
                        {String(row.nama || "-")}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-slate-800 text-slate-300 rounded-md text-[11px]">
                          {String(row.kelas_divisi || row.divisi || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 text-emerald-400 font-bold whitespace-nowrap">
                        {String(row.jam_masuk || "-")}
                      </td>
                      <td className="p-3.5 text-amber-400 font-bold whitespace-nowrap">
                        {String(row.jam_pulang || "-")}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                            row.status_kehadiran === "Hadir"
                              ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                              : row.status_kehadiran === "Alfa"
                                ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                                : "bg-amber-500/20 text-amber-300 border-amber-500/40"
                          }`}
                        >
                          {String(row.status_kehadiran || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold ${
                            row.status_absen === "Lengkap"
                              ? "text-emerald-400 bg-emerald-950/60 border border-emerald-800"
                              : row.status_absen === "Belum Lengkap"
                                ? "text-amber-400 bg-amber-950/60 border border-amber-800"
                                : "text-slate-400 bg-slate-900 border border-slate-700"
                          }`}
                        >
                          {String(row.status_absen || "-")}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.keterangan || "-")}
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.sumber || "Scanner")}
                      </td>
                      <td className="p-3.5 text-slate-400 text-[11px] whitespace-nowrap">
                        {formatDisplayDateTime(row.update_terakhir)}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold">
                        {late > 0 ? (
                          <span className="text-rose-400">+{late} mnt</span>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap font-bold">
                        {early > 0 ? (
                          <span className="text-emerald-400">+{early} mnt</span>
                        ) : (
                          <span className="text-slate-500">0</span>
                        )}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap text-sky-300 font-bold">
                        {formatMinutesToHours(workMin)}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap text-amber-300 font-bold">
                        {otMin > 0 ? formatMinutesToHours(otMin) : "-"}
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap text-rose-300 font-bold">
                        {shortMin > 0 ? formatMinutesToHours(shortMin) : "-"}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded-md text-[10px]">
                          {String(
                            row.nama_shift ||
                              `Shift ${row.kode_shift || row.id_shift || "-"}`,
                          )}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.bulan || "")} {String(row.tahun || "")}
                      </td>
                      <td
                        className="p-3.5 text-slate-500 text-[10px] max-w-[120px] truncate"
                        title={String(row.id_sesi || "")}
                      >
                        {String(row.id_sesi || "-")}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isBackup
                              ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40"
                              : "bg-slate-800 text-slate-400"
                          }`}
                        >
                          {String(row.mode_tugas || "NORMAL")}
                        </span>
                      </td>
                      <td className="p-3.5 text-[11px] text-slate-400 whitespace-nowrap">
                        {isBackup
                          ? `Backup: ${String(row.id_karyawan_asal || "-")}`
                          : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Bar */}
        {tab === "scan" ? (
          <div className="flex items-center justify-between border-t border-slate-800 px-5 py-3 text-xs font-mono text-slate-400 bg-slate-950/40">
            <span>Halaman {page + 1}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page === 0 || loading}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-1.5 font-bold text-white transition hover:bg-slate-700 disabled:opacity-40"
              >
                ← Sebelumnya
              </button>
              <button
                type="button"
                disabled={rows.length < SCAN_PAGE_SIZE || loading}
                onClick={() => setPage((value) => value + 1)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-1.5 font-bold text-white transition hover:bg-slate-700 disabled:opacity-40"
              >
                Berikutnya →
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
