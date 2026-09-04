"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { AuditTrailTimeline } from "@/components/payroll/AuditTrailTimeline";
import { RunStatusBadge } from "@/components/payroll/RunStatusBadge";
import { SlipGajiPrintView } from "@/components/payroll/SlipGajiPrintView";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getPayrollRunDetail,
  type PayrollItemRow,
  type PayrollRunDetail,
  transitionPayrollStatus,
} from "@/lib/gateways/payroll";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function RunDetailClient() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const searchParams = useSearchParams();
  const runId = searchParams.get("id") || "";
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [detail, setDetail] = useState<PayrollRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"items" | "audit">("items");
  const [selectedSlip, setSelectedSlip] = useState<PayrollItemRow | null>(null);

  const [transitionModalOpen, setTransitionModalOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<string>("");
  const [statusNotes, setStatusNotes] = useState<string>("");
  const [transitioning, setTransitioning] = useState(false);

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadDetail = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setFeedback(null);
    try {
      const data = await getPayrollRunDetail(runId);
      setDetail(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal memuat detail batch payroll.",
      });
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (!isHydrated || authLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    void loadDetail();
  }, [isHydrated, authLoading, isAuthenticated, loadDetail, router]);

  const handleOpenTransition = (status: string) => {
    setTargetStatus(status);
    setStatusNotes("");
    setTransitionModalOpen(true);
  };

  const handleExecuteTransition = async () => {
    if (!targetStatus) return;
    setTransitioning(true);
    setFeedback(null);
    try {
      await transitionPayrollStatus(runId, targetStatus, statusNotes);
      setTransitionModalOpen(false);
      setFeedback({
        type: "success",
        message: `Status batch berhasil diubah menjadi ${targetStatus}.`,
      });
      await loadDetail();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal mengubah status batch.",
      });
    } finally {
      setTransitioning(false);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-400">
        Memuat otorisasi...
      </div>
    );
  }

  const run = detail?.run;
  const items = detail?.items || [];
  const auditLogs = detail?.audit_logs || [];

  const currentStatus = run?.status || "DRAFT";

  const canSubmit =
    hasPermission(user, "payroll.run.create") && currentStatus === "DRAFT";
  const canReview =
    hasPermission(user, "payroll.run.review") && currentStatus === "SUBMITTED";
  const canApprove =
    hasPermission(user, "payroll.run.approve") && currentStatus === "REVIEWED";
  const canDisburse =
    hasPermission(user, "payroll.run.disburse") && currentStatus === "APPROVED";
  const canReject =
    (hasPermission(user, "payroll.run.review") ||
      hasPermission(user, "payroll.run.approve")) &&
    (currentStatus === "SUBMITTED" || currentStatus === "REVIEWED");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Batch Payroll"
          title={`Batch Payroll: ${runId}`}
          description={
            loading
              ? "Memuat detail..."
              : run
                ? `Periode ${run.period_start} s.d. ${run.period_end} (${run.total_employees} karyawan)`
                : "Batch tidak ditemukan."
          }
          actions={
            <div className="flex flex-wrap gap-2">
              <Link
                href="/payroll/runs"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
              >
                <Icon name="arrow-left" className="w-4 h-4" />
                Kembali ke Daftar
              </Link>
              {canSubmit && (
                <button
                  type="button"
                  onClick={() => handleOpenTransition("SUBMITTED")}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition flex items-center gap-2 shadow"
                >
                  <Icon name="arrow-right" className="w-4 h-4" />
                  Ajukan untuk Review
                </button>
              )}
              {canReview && (
                <button
                  type="button"
                  onClick={() => handleOpenTransition("REVIEWED")}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition flex items-center gap-2 shadow"
                >
                  <Icon name="check" className="w-4 h-4" />
                  Tandai Sudah Direview
                </button>
              )}
              {canApprove && (
                <button
                  type="button"
                  onClick={() => handleOpenTransition("APPROVED")}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition flex items-center gap-2 shadow"
                >
                  <Icon name="check" className="w-4 h-4" />
                  Setujui (Approve)
                </button>
              )}
              {canDisburse && (
                <button
                  type="button"
                  onClick={() => handleOpenTransition("PAID")}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition flex items-center gap-2 shadow"
                >
                  <Icon name="check" className="w-4 h-4" />
                  Tandai Dibayar & Kunci Slip
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  onClick={() => handleOpenTransition("REJECTED")}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition flex items-center gap-2 shadow"
                >
                  <Icon name="x" className="w-4 h-4" />
                  Tolak Batch
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

        {/* Ringkasan Metadata Batch */}
        {run && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-5 bg-slate-900 border border-slate-800 rounded-xl">
            <div>
              <div className="text-xs text-slate-500 uppercase font-semibold">
                Status Persetujuan
              </div>
              <div className="mt-2">
                <RunStatusBadge status={run.status} />
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-semibold">
                Total Pengeluaran Kotor
              </div>
              <div className="text-xl font-bold font-mono text-slate-200 mt-1">
                {IDR.format(run.total_gross_payout)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-semibold">
                Total Bersih Ditransfer
              </div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {IDR.format(run.total_net_payout)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase font-semibold">
                Pembuat Batch
              </div>
              <div className="text-sm font-semibold text-slate-300 mt-1">
                {run.created_by}
              </div>
              <div className="text-xs text-slate-500">
                {new Date(run.created_at).toLocaleString("id-ID")}
              </div>
            </div>
          </div>
        )}

        {/* Tabs Navigasi */}
        <div className="flex border-b border-slate-800 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab("items")}
            className={`pb-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "items"
                ? "border-sky-500 text-sky-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Rincian Slip Karyawan ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("audit")}
            className={`pb-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "audit"
                ? "border-sky-500 text-sky-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Audit Trail ({auditLogs.length})
          </button>
        </div>

        {/* Tab Content: Items */}
        {activeTab === "items" && (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
                <tr>
                  <th className="py-3 px-4">Karyawan</th>
                  <th className="py-3 px-4">Divisi / PTKP</th>
                  <th className="py-3 px-4 text-right">Jam Reguler</th>
                  <th className="py-3 px-4 text-right">Lembur</th>
                  <th className="py-3 px-4 text-right">Jam Hari Libur</th>
                  <th className="py-3 px-4 text-right">Gaji Pokok</th>
                  <th className="py-3 px-4 text-right">Upah Lembur</th>
                  <th className="py-3 px-4 text-right">Potongan</th>
                  <th className="py-3 px-4 text-right">PPh 21</th>
                  <th className="py-3 px-4 text-right">Take Home Pay</th>
                  <th className="py-3 px-4 text-center">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      className="py-8 text-center text-slate-500"
                    >
                      Tidak ada rincian karyawan dalam batch ini.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => (
                    <tr
                      key={it.id}
                      className="hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3 px-4 font-medium text-slate-200">
                        <div>{it.nama_karyawan}</div>
                        <div className="text-xs text-slate-500">
                          {it.id_karyawan}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div>{it.divisi}</div>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {it.ptkp_status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-300">
                        {Number(it.total_regular_hours.toFixed(2))}j
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-amber-400">
                        {Number(it.total_overtime_hours.toFixed(2))}j
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-rose-400">
                        {Number(it.total_holiday_hours.toFixed(2))}j
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-300">
                        {IDR.format(it.basic_salary)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-amber-400">
                        {IDR.format(it.overtime_salary)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-rose-400">
                        {IDR.format(
                          it.total_deductions + it.bpjs_employee_total,
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-rose-400">
                        {IDR.format(it.pph21_amount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400">
                        {IDR.format(it.net_salary)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => setSelectedSlip(it)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-400 hover:text-sky-300 rounded border border-slate-700 text-xs font-semibold transition inline-flex items-center gap-1"
                        >
                          <Icon name="eye" className="w-3.5 h-3.5" />
                          Slip
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab Content: Audit Logs */}
        {activeTab === "audit" && (
          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-lg">
            <AuditTrailTimeline logs={auditLogs} />
          </div>
        )}

        {/* Modal Status Transition */}
        {transitionModalOpen ? (
          <Modal
            title={`Ubah Status Menjadi ${targetStatus}`}
            titleId="modal-status-transition"
            onClose={() => setTransitionModalOpen(false)}
          >
            <div className="space-y-4 text-slate-300 text-sm">
              <p>
                Apakah Anda yakin ingin memindahkan status batch{" "}
                <strong>{runId}</strong> ke status{" "}
                <strong className="text-sky-400">{targetStatus}</strong>?
              </p>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                  <span>Catatan / Justifikasi (Opsional):</span>
                  <textarea
                    value={statusNotes}
                    onChange={(e) => setStatusNotes(e.target.value)}
                    placeholder="Tambahkan catatan persetujuan atau alasan penolakan..."
                    rows={3}
                    className="w-full mt-1 px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                  />
                </label>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setTransitionModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleExecuteTransition}
                  disabled={transitioning}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold disabled:opacity-50"
                >
                  {transitioning ? "Menyimpan..." : "Konfirmasi Ubah Status"}
                </button>
              </div>
            </div>
          </Modal>
        ) : null}

        {/* Modal Slip Gaji Preview & Print */}
        {selectedSlip && run ? (
          <Modal
            title={`Slip Gaji: ${selectedSlip.nama_karyawan}`}
            titleId="modal-slip-preview"
            onClose={() => setSelectedSlip(null)}
          >
            <div className="space-y-4">
              <div className="flex justify-end gap-2 pb-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded flex items-center gap-1.5 shadow"
                >
                  <Icon name="download" className="w-3.5 h-3.5" />
                  Cetak Dokumen
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto p-2 bg-slate-950/40 rounded-lg border border-slate-800">
                <SlipGajiPrintView run={run} item={selectedSlip} />
              </div>
            </div>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
