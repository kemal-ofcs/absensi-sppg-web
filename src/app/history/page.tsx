"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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

export default function HistoryPage() {
  const hydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [tab, setTab] = useState<"scan" | "daily">("scan");
  const [tanggal, setTanggal] = useState(today);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
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
          : await getRekapHarian({ tanggal });
      setRows(data);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Riwayat gagal dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, page, tab, tanggal]);

  useEffect(() => {
    if (hydrated && isAuthenticated) void load();
  }, [hydrated, isAuthenticated, load]);

  if (!hydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 p-10 text-slate-300">
        Memuat riwayat...
      </div>
    );
  }
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "history")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-sky-400">
          Data tersimpan
        </p>
        <h1 className="mt-1 text-2xl font-bold text-white">Riwayat Absensi</h1>
        <p className="text-xs text-slate-400">
          Log scan dan absensi harian berasal dari database, bukan hanya sesi
          layar scanner.
        </p>
      </div>

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError(null)}>
          {error}
        </FeedbackBanner>
      ) : null}

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-3">
        <button
          type="button"
          onClick={() => {
            setTab("scan");
            setPage(0);
          }}
          className={`rounded-xl px-4 py-2 text-xs font-bold ${tab === "scan" ? "bg-sky-400 text-slate-950" : "bg-slate-800 text-slate-300"}`}
        >
          Log Scan
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("daily");
            setPage(0);
          }}
          className={`rounded-xl px-4 py-2 text-xs font-bold ${tab === "daily" ? "bg-sky-400 text-slate-950" : "bg-slate-800 text-slate-300"}`}
        >
          Absensi Harian
        </button>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          Tanggal
          <input
            type="date"
            value={tanggal}
            onChange={(event) => {
              setTanggal(event.target.value);
              setPage(0);
            }}
            className="min-h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"
          />
        </label>
        {tab === "scan" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(search.trim());
              setPage(0);
            }}
            className="flex gap-2"
          >
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cari nama, ID, divisi..."
              className="min-h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-white"
            />
            <button
              type="submit"
              className="rounded-xl bg-slate-800 px-3 text-xs font-bold text-sky-200"
            >
              Cari
            </button>
          </form>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-4 py-3 text-xs text-slate-400">
          {loading ? "Memuat..." : `${rows.length} data ditemukan`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-xs">
            <thead className="bg-slate-950 text-slate-400">
              <tr>
                <th className="p-3">Waktu</th>
                <th className="p-3">ID / Kode</th>
                <th className="p-3">Nama</th>
                <th className="p-3">Divisi</th>
                <th className="p-3">Masuk</th>
                <th className="p-3">Pulang</th>
                <th className="p-3">Status</th>
                <th className="p-3">Keterangan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-200">
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-slate-500">
                    Belum ada data pada tanggal ini.
                  </td>
                </tr>
              ) : null}
              {rows.map((row, index) => (
                <tr
                  key={String(
                    tab === "scan"
                      ? row.id_log ||
                          row.id_referensi ||
                          `${row.timestamp_scan}-${row.id_karyawan}-${index}`
                      : row.id_sesi ||
                          row.id_absensi ||
                          `${row.tanggal}-${row.id_karyawan}-${index}`,
                  )}
                  className="hover:bg-slate-800/50"
                >
                  <td className="p-3 font-mono text-sky-300">
                    {String(
                      tab === "scan"
                        ? row.jam_scan || row.timestamp_scan
                        : row.tanggal || "-",
                    )}
                  </td>
                  <td className="p-3 font-mono">
                    {String(row.id_karyawan || row.kode_karyawan || "-")}
                  </td>
                  <td className="p-3 font-semibold text-white">
                    {String(row.nama || "-")}
                  </td>
                  <td className="p-3">
                    {String(row.divisi || row.kelas_divisi || "-")}
                  </td>
                  <td className="p-3">
                    {tab === "daily"
                      ? String(row.jam_masuk || "-")
                      : String(row.jenis_scan || "-")}
                  </td>
                  <td className="p-3">
                    {tab === "daily" ? String(row.jam_pulang || "-") : "-"}
                  </td>
                  <td className="p-3">
                    {String(
                      row.status_proses ||
                        row.status_absen ||
                        row.status_kehadiran ||
                        "-",
                    )}
                  </td>
                  <td className="p-3 text-slate-400">
                    {String(row.keterangan || row.catatan_sistem || "-")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {tab === "scan" ? (
        <div className="flex items-center justify-end gap-3 text-xs text-slate-400">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 font-bold text-white disabled:opacity-40"
          >
            Sebelumnya
          </button>
          <span>Halaman {page + 1}</span>
          <button
            type="button"
            disabled={rows.length < SCAN_PAGE_SIZE || loading}
            onClick={() => setPage((value) => value + 1)}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 font-bold text-white disabled:opacity-40"
          >
            Berikutnya
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}
