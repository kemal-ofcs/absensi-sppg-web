"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { VirtualPayrollTable } from "@/components/payroll/VirtualPayrollTable";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  createPayrollRun,
  getPayrollRecap,
  type PayrollRecapRow,
} from "@/lib/gateways/payroll";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function PayrollDashboardPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const [periodStart, setPeriodStart] = useState(firstDay);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [data, setData] = useState<PayrollRecapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [modalRunOpen, setModalRunOpen] = useState(false);

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const rows = await getPayrollRecap(periodStart, periodEnd);
      setData(rows);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal memuat data rekap payroll.",
      });
    } finally {
      setLoading(false);
    }
  }, [periodStart, periodEnd]);

  useEffect(() => {
    if (!isHydrated || authLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    void loadData();
  }, [isHydrated, authLoading, isAuthenticated, loadData, router]);

  const handleCreateRun = async () => {
    setCreating(true);
    setFeedback(null);
    try {
      const idempotencyKey = `PR-RUN-${periodStart}-${periodEnd}-${Date.now()}`;
      const run = await createPayrollRun(
        idempotencyKey,
        periodStart,
        periodEnd,
      );
      setModalRunOpen(false);
      setFeedback({
        type: "success",
        message: `Batch payroll ${run.id} berhasil dibuat sebagai DRAFT.`,
      });
      router.push(`/payroll/runs/detail?id=${encodeURIComponent(run.id)}`);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal membuat batch payroll.",
      });
    } finally {
      setCreating(false);
    }
  };

  const setPresetRange = (
    preset: "today" | "week" | "thisMonth" | "lastMonth" | "last30",
  ) => {
    const d = new Date();
    const todayStr = d.toISOString().slice(0, 10);

    if (preset === "today") {
      setPeriodStart(todayStr);
      setPeriodEnd(todayStr);
    } else if (preset === "week") {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d.setDate(diff)).toISOString().slice(0, 10);
      setPeriodStart(monday);
      setPeriodEnd(todayStr);
    } else if (preset === "thisMonth") {
      const first = new Date(d.getFullYear(), d.getMonth(), 1)
        .toISOString()
        .slice(0, 10);
      setPeriodStart(first);
      setPeriodEnd(todayStr);
    } else if (preset === "lastMonth") {
      const firstLastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1)
        .toISOString()
        .slice(0, 10);
      const lastDayLastMonth = new Date(d.getFullYear(), d.getMonth(), 0)
        .toISOString()
        .slice(0, 10);
      setPeriodStart(firstLastMonth);
      setPeriodEnd(lastDayLastMonth);
    } else if (preset === "last30") {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      setPeriodStart(thirtyDaysAgo);
      setPeriodEnd(todayStr);
    }
  };

  const totalTakeHome = data.reduce(
    (acc, curr) => acc + curr.est_net_salary,
    0,
  );
  const totalLembur = data.reduce(
    (acc, curr) => acc + curr.total_overtime_hours,
    0,
  );
  const totalRegular = data.reduce(
    (acc, curr) => acc + curr.total_regular_hours,
    0,
  );

  const canCreateRun = hasPermission(user, "payroll.run.create");
  const canManageConfig = hasPermission(user, "payroll.config.manage");

  if (!isHydrated || authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        Memuat otorisasi...
      </div>
    );
  }

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Penggajian"
          title="Penggajian & Estimasi Upah"
          description="Rekapitulasi jam kerja, perhitungan upah lembur berjenjang (PP 35/2021), potongan PPh 21 & BPJS."
          actions={
            <div className="flex flex-wrap gap-2">
              <Link
                href="/payroll/runs"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
              >
                <Icon name="history" className="w-4 h-4" />
                Daftar Batch Runs
              </Link>
              {canManageConfig && (
                <Link
                  href="/payroll/config"
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
                >
                  <Icon name="settings" className="w-4 h-4" />
                  Konfigurasi Gaji
                </Link>
              )}
              {canCreateRun && (
                <button
                  type="button"
                  onClick={() => setModalRunOpen(true)}
                  disabled={loading || data.length === 0}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition flex items-center gap-2 disabled:opacity-50 shadow-md shadow-sky-600/20"
                >
                  <Icon name="plus" className="w-4 h-4" />
                  Buat Batch Payroll
                </button>
              )}
            </div>
          }
        />

        {feedback ? (
          <FeedbackBanner
            tone={feedback.type}
            onDismiss={() => setFeedback(null)}
          >
            {feedback.message}
          </FeedbackBanner>
        ) : null}

        {/* Filter Rentang Tanggal & Preset */}
        <div className="p-4 bg-slate-900/80 border border-slate-800 rounded-xl flex flex-wrap gap-4 items-center justify-between shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Periode Rekap:
            </span>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
            />
            <span className="text-slate-500 text-sm">s.d.</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={loadData}
              disabled={loading}
              className="px-3.5 py-1.5 text-sm bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Memuat...
                </>
              ) : (
                "Terapkan Filter"
              )}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setPresetRange("today")}
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
            >
              Hari Ini
            </button>
            <button
              type="button"
              onClick={() => setPresetRange("week")}
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
            >
              Minggu Ini
            </button>
            <button
              type="button"
              onClick={() => setPresetRange("thisMonth")}
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition font-medium text-sky-400"
            >
              Bulan Ini
            </button>
            <button
              type="button"
              onClick={() => setPresetRange("lastMonth")}
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
            >
              Bulan Lalu
            </button>
            <button
              type="button"
              onClick={() => setPresetRange("last30")}
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
            >
              30 Hari Terakhir
            </button>
          </div>
        </div>

        {/* Ringkasan Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-xs font-semibold uppercase text-slate-400">
              Total Karyawan Aktif
            </div>
            <div className="text-2xl font-bold text-slate-100 mt-1">
              {data.length} Personil
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Terjadwal dalam database
            </div>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-xs font-semibold uppercase text-slate-400">
              Total Jam Reguler
            </div>
            <div className="text-2xl font-bold text-sky-400 mt-1">
              {totalRegular.toFixed(1)} Jam
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Akumulasi jam kerja efektif
            </div>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <div className="text-xs font-semibold uppercase text-slate-400">
              Total Jam Lembur
            </div>
            <div className="text-2xl font-bold text-amber-400 mt-1">
              {totalLembur.toFixed(1)} Jam
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Mengikuti perkalian PP 35/2021
            </div>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl border-emerald-900/40 bg-emerald-950/10">
            <div className="text-xs font-semibold uppercase text-emerald-400">
              Estimasi Total Payout
            </div>
            <div className="text-2xl font-bold text-emerald-400 mt-1">
              {IDR.format(totalTakeHome)}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Sebelum pemotongan batch resmi
            </div>
          </div>
        </div>

        {/* Tabel Rekap Karyawan */}
        <VirtualPayrollTable
          data={data}
          isLoading={loading}
          periodStart={periodStart}
          periodEnd={periodEnd}
        />

        {/* Modal Konfirmasi Buat Run */}
        {modalRunOpen ? (
          <Modal
            title="Konfirmasi Buat Batch Payroll"
            titleId="modal-confirm-payroll-run"
            onClose={() => setModalRunOpen(false)}
          >
            <div className="space-y-4 text-slate-300 text-sm">
              <p>
                Anda akan membuat batch eksekusi payroll resmi untuk periode:
              </p>
              <div className="p-3 bg-slate-800 rounded-lg border border-slate-700 font-mono text-center">
                <strong>{periodStart}</strong> s.d. <strong>{periodEnd}</strong>
              </div>
              <p>
                Batch ini akan mengunci snapshot jam kerja, tarif lembur, pajak
                PPh 21, dan potongan BPJS untuk{" "}
                <strong>{data.length} karyawan</strong> dengan total estimasi{" "}
                <strong className="text-emerald-400">
                  {IDR.format(totalTakeHome)}
                </strong>
                .
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setModalRunOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleCreateRun}
                  disabled={creating}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold disabled:opacity-50 shadow-md shadow-sky-600/30"
                >
                  {creating ? "Memproses..." : "Ya, Buat Batch DRAFT"}
                </button>
              </div>
            </div>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
