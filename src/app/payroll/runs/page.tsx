"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RunStatusBadge } from "@/components/payroll/RunStatusBadge";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/lib/context/AuthContext";
import { listPayrollRuns, type PayrollRunRow } from "@/lib/gateways/payroll";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function PayrollRunsListPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [runs, setRuns] = useState<PayrollRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const data = await listPayrollRuns(statusFilter || undefined);
      setRuns(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal memuat daftar batch payroll.",
      });
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (!isHydrated || authLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    void loadRuns();
  }, [isHydrated, authLoading, isAuthenticated, loadRuns, router]);

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
          title="Daftar Batch Payroll"
          description="Riwayat eksekusi penggajian, alur approval bertingkat, dan arsip slip gaji resmi."
          actions={
            <div className="flex gap-2">
              <Link
                href="/payroll"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
              >
                <Icon name="arrow-left" className="w-4 h-4" />
                Kembali ke Rekap
              </Link>
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

        <div className="flex flex-wrap gap-2 items-center justify-between">
          <div className="flex flex-wrap gap-1.5">
            {[
              "",
              "DRAFT",
              "SUBMITTED",
              "REVIEWED",
              "APPROVED",
              "PAID",
              "REJECTED",
            ].map((st) => (
              <button
                type="button"
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
                  statusFilter === st
                    ? "bg-sky-600 border-sky-500 text-white"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                }`}
              >
                {st === "" ? "Semua Status" : st}
              </button>
            ))}
          </div>
          <div className="text-xs text-slate-500 font-medium">
            Total {runs.length} batch tercatat
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
              <tr>
                <th className="py-3 px-4">ID Batch Run</th>
                <th className="py-3 px-4">Periode</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Karyawan</th>
                <th className="py-3 px-4 text-right">Total Gross</th>
                <th className="py-3 px-4 text-right">Total Net Payout</th>
                <th className="py-3 px-4">Dibuat Oleh</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    Memuat daftar batch payroll...
                  </td>
                </tr>
              ) : runs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    Belum ada batch payroll yang dibuat.
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr
                    key={run.id}
                    className="hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-200">
                      {run.id}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium text-slate-300">
                      {run.period_start} s.d. {run.period_end}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="py-3 px-4 text-center font-semibold text-slate-200">
                      {run.total_employees} org
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-400">
                      {IDR.format(run.total_gross_payout)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400">
                      {IDR.format(run.total_net_payout)}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400">
                      <div>{run.created_by}</div>
                      <div className="text-[10px] text-slate-500">
                        {new Date(run.created_at).toLocaleDateString("id-ID")}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        href={`/payroll/runs/detail?id=${encodeURIComponent(run.id)}`}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-sky-400 hover:text-sky-300 rounded border border-slate-700 text-xs font-semibold transition inline-flex items-center gap-1"
                      >
                        Detail & Slip
                        <Icon name="arrow-right" className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
