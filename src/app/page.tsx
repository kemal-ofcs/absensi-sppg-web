"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { useCallback, useState } from "react";
import { HeaderBar } from "@/components/HeaderBar";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { runAttendanceEngineTest } from "@/lib/test-attendance";
import { runDatabaseTest } from "@/lib/test-db";
import { runTahap3Test } from "@/lib/test-tahap3";
import { runTahap4Test } from "@/lib/test-tahap4";
import { runTahap5Test } from "@/lib/test-tahap5";
import { runTahap6Test } from "@/lib/test-tahap6";

interface TestResult {
  sukses: boolean;
  pesan: string;
  total_tabel: number;
  daftar_tabel: string[];
  ringkasan_seeder: {
    total_shift: number;
    shift_list: Record<string, unknown>[];
    operator_list: Record<string, unknown>[];
    settings_list: Record<string, unknown>[];
    total_karyawan: number;
    total_id_card: number;
  };
}

interface DiagnosticMessage {
  type: "success" | "error";
  text: string;
}

export default function Home() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [tahap6TestResult, setTahap6TestResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingAttendance, setLoadingAttendance] = useState(false);
  const [loadingTahap3, setLoadingTahap3] = useState(false);
  const [loadingTahap4, setLoadingTahap4] = useState(false);
  const [loadingTahap5, setLoadingTahap5] = useState(false);
  const [loadingTahap6, setLoadingTahap6] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticMessage, setDiagnosticMessage] =
    useState<DiagnosticMessage | null>(null);

  const runDbTest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runDatabaseTest();
      if (data.sukses && "total_tabel" in data) {
        setTestResult(data as TestResult);
      } else {
        setError(data.pesan);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Gagal menguji database.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const runAttendanceTest = async () => {
    setLoadingAttendance(true);
    setDiagnosticMessage(null);
    try {
      await runAttendanceEngineTest();
      setDiagnosticMessage({
        type: "success",
        text: "Pengujian Tahap 2 berhasil.",
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Gagal menguji mesin absensi.";
      setDiagnosticMessage({ type: "error", text: msg });
    } finally {
      setLoadingAttendance(false);
    }
  };

  const runTahap3 = async () => {
    setLoadingTahap3(true);
    setDiagnosticMessage(null);
    try {
      await runTahap3Test();
      setDiagnosticMessage({
        type: "success",
        text: "Pengujian Tahap 3 berhasil.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menguji Tahap 3.";
      setDiagnosticMessage({ type: "error", text: msg });
    } finally {
      setLoadingTahap3(false);
    }
  };

  const runTahap4 = async () => {
    setLoadingTahap4(true);
    setDiagnosticMessage(null);
    try {
      await runTahap4Test();
      setDiagnosticMessage({
        type: "success",
        text: "Pengujian Tahap 4 berhasil.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menguji Tahap 4.";
      setDiagnosticMessage({ type: "error", text: msg });
    } finally {
      setLoadingTahap4(false);
    }
  };

  const runTahap5 = async () => {
    setLoadingTahap5(true);
    setDiagnosticMessage(null);
    try {
      await runTahap5Test();
      setDiagnosticMessage({
        type: "success",
        text: "Pengujian Tahap 5 berhasil.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menguji Tahap 5.";
      setDiagnosticMessage({ type: "error", text: msg });
    } finally {
      setLoadingTahap5(false);
    }
  };

  const runTahap6 = async () => {
    setLoadingTahap6(true);
    setDiagnosticMessage(null);
    try {
      const res = await runTahap6Test();
      setTahap6TestResult(res as Record<string, unknown>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menguji Tahap 6.";
      setDiagnosticMessage({ type: "error", text: msg });
    } finally {
      setLoadingTahap6(false);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memverifikasi Sesi Operator...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <HeaderBar />

      <main className="flex-1 p-4 sm:p-6 md:p-8 flex flex-col items-center justify-center">
        <div className="max-w-5xl w-full bg-slate-900/80 border border-slate-800 backdrop-blur-xl rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
          {/* Welcome Banner */}
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between border-b border-slate-800 pb-6 gap-4">
            <div>
              <span className="text-xs uppercase tracking-widest text-emerald-400 font-semibold">
                Sistem Utama Absensi SPPG
              </span>
              <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
                Selamat Datang, {user?.nama_operator} ({user?.role})
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Operator ID:{" "}
                <span className="font-mono text-emerald-400">
                  {user?.kode_operator}
                </span>{" "}
                • Login sejak:{" "}
                {user?.loginAt
                  ? new Date(user.loginAt).toLocaleTimeString("id-ID")
                  : "-"}
              </p>
            </div>

            {/* Test Drawer Quick Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runDbTest}
                disabled={loading}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 disabled:opacity-50"
              >
                Uji DB (T1)
              </button>
              <button
                type="button"
                onClick={runAttendanceTest}
                disabled={loadingAttendance}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 disabled:opacity-50"
              >
                Uji Engine (T2)
              </button>
              <button
                type="button"
                onClick={runTahap3}
                disabled={loadingTahap3}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 disabled:opacity-50"
              >
                T3
              </button>
              <button
                type="button"
                onClick={runTahap4}
                disabled={loadingTahap4}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 disabled:opacity-50"
              >
                T4
              </button>
              <button
                type="button"
                onClick={runTahap5}
                disabled={loadingTahap5}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 disabled:opacity-50"
              >
                T5
              </button>
              <button
                type="button"
                onClick={runTahap6}
                disabled={loadingTahap6}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-xs transition shadow-lg shadow-emerald-950/50 disabled:opacity-50"
              >
                {loadingTahap6 ? "Analytics..." : "Uji Analytics (T6)"}
              </button>
            </div>
          </div>

          {diagnosticMessage && (
            <div
              role={diagnosticMessage.type === "error" ? "alert" : "status"}
              className={`rounded-xl border p-4 text-sm ${
                diagnosticMessage.type === "success"
                  ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-200"
                  : "border-rose-800 bg-rose-950/50 text-rose-200"
              }`}
            >
              {diagnosticMessage.text}
            </div>
          )}

          {/* Quick Navigation Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              href="/scanner"
              className="p-5 bg-gradient-to-r from-emerald-950/80 to-slate-900 border border-emerald-500/50 hover:border-emerald-400 rounded-2xl transition group space-y-2 shadow-xl"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-bold tracking-wider text-emerald-400">
                  Terminal Absensi
                </span>
                <span className="text-emerald-400 group-hover:translate-x-1 transition font-bold text-sm">
                  →
                </span>
              </div>
              <h3 className="text-lg font-bold text-white">
                Terminal Scanner Mode (Hardware & Audio)
              </h3>
              <p className="text-xs text-slate-400">
                Scan barcode/QR code karyawan real-time dengan audio feedback
                synthesizer dan lokasi GPS.
              </p>
            </Link>

            <Link
              href="/dashboard"
              className="p-5 bg-gradient-to-r from-sky-950/80 to-slate-900 border border-sky-500/50 hover:border-sky-400 rounded-2xl transition group space-y-2 shadow-xl"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-bold tracking-wider text-sky-400">
                  Laporan & Analytics
                </span>
                <span className="text-sky-400 group-hover:translate-x-1 transition font-bold text-sm">
                  →
                </span>
              </div>
              <h3 className="text-lg font-bold text-white">
                Dashboard Executive Analytics & Export CSV
              </h3>
              <p className="text-xs text-slate-400">
                Visualisasi rekapitulasi absensi harian, bulanan, leaderboard
                karyawan rajin, dan ekspor laporan CSV.
              </p>
            </Link>
          </div>

          {/* Loading State */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-slate-400 text-sm animate-pulse">
                Memeriksa status koneksi database...
              </p>
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="p-4 bg-rose-950/50 border border-rose-800 rounded-xl text-rose-300 text-sm">
              <p className="font-semibold mb-1">Terjadi Kesalahan:</p>
              <p className="font-mono text-xs">{error}</p>
            </div>
          )}

          {/* Success State Tahap 1 */}
          {testResult && !loading && (
            <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-emerald-400 rounded-full animate-ping"></div>
                <div>
                  <h3 className="font-semibold text-emerald-300 text-sm">
                    {testResult.pesan}
                  </h3>
                  <p className="text-xs text-slate-400">
                    Total {testResult.total_tabel} Tabel SQLite Berhasil
                    Terinisialisasi
                  </p>
                </div>
              </div>
              <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full text-xs font-mono font-semibold">
                SISTEM: AKTIF
              </span>
            </div>
          )}

          {/* Success State Tahap 6 */}
          {tahap6TestResult && (
            <div className="p-4 bg-slate-900 border border-emerald-500/40 rounded-xl space-y-3 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  Hasil Uji Dashboard Analytics & Generator Laporan (Tahap 6)
                </h3>
                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-full text-[10px] font-mono">
                  TAHAP 6: OK
                </span>
              </div>

              <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg space-y-1 text-xs">
                <p className="font-semibold text-slate-300">
                  {String(tahap6TestResult.pesan)}
                </p>
                <p className="text-emerald-400 font-mono text-[11px]">
                  Executive Dashboard & Export CSV Service 100% Ready!
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
