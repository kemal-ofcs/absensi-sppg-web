"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BpjsRuleRow,
  deleteBpjsRule,
  getBpjsRules,
  saveBpjsRule,
} from "@/lib/gateways/payroll";
import { syncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function BpjsRulesPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [rules, setRules] = useState<BpjsRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Partial<BpjsRuleRow> | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getBpjsRules();
      setRules(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal memuat aturan BPJS.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated || authLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    if (!hasPermission(user, "payroll.config.manage")) {
      router.push("/payroll");
      return;
    }
    void loadRules();
  }, [isHydrated, authLoading, isAuthenticated, user, router, loadRules]);

  useEffect(() => {
    const handleSync = () => {
      void loadRules();
    };
    window.addEventListener("sppg:sync-completed", handleSync);
    return () => window.removeEventListener("sppg:sync-completed", handleSync);
  }, [loadRules]);

  const [isSyncing, setIsSyncing] = useState(false);

  const handleReload = async () => {
    setIsSyncing(true);
    try {
      await syncNow();
    } catch {
      // Ignore
    } finally {
      await loadRules();
      setIsSyncing(false);
    }
  };

  const handleOpenAdd = () => {
    setEditingRule({
      id: "",
      component_code: "",
      component_name: "",
      rate_percentage: 1.0,
      wage_cap: null,
      effective_date: new Date().toISOString().slice(0, 10),
    });
    setModalOpen(true);
  };

  const handleOpenEdit = (rule: BpjsRuleRow) => {
    setEditingRule({ ...rule });
    setModalOpen(true);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Hapus aturan program BPJS "${name}"?`)) return;
    setSaving(true);
    setFeedback(null);
    try {
      await deleteBpjsRule(id);
      setFeedback({
        type: "success",
        message: `Program BPJS "${name}" berhasil dihapus.`,
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus aturan BPJS.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRule || !editingRule.component_code) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveBpjsRule(editingRule);
      setModalOpen(false);
      setEditingRule(null);
      setFeedback({
        type: "success",
        message: "Program BPJS berhasil disimpan.",
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menyimpan aturan BPJS.",
      });
    } finally {
      setSaving(false);
    }
  };

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
          eyebrow="Konfigurasi BPJS"
          title="Aturan BPJS Ketenagakerjaan & Kesehatan"
          description="Konfigurasi tarif iuran pekerja, iuran perusahaan, dan batas plafon upah maksimal (Wage Cap) secara dinamis."
          actions={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleReload()}
                disabled={isSyncing || loading}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700 disabled:opacity-50"
              >
                <Icon
                  name="refresh"
                  className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                />
                {isSyncing ? "Menyinkronkan..." : "Muat Ulang"}
              </button>
              <Link
                href="/payroll/config"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
              >
                <Icon name="arrow-left" className="w-4 h-4" />
                Kembali
              </Link>
              <button
                type="button"
                onClick={handleOpenAdd}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition flex items-center gap-2 shadow-md shadow-sky-600/20"
              >
                <Icon name="plus" className="w-4 h-4" />
                Tambah Program BPJS
              </button>
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

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
              <tr>
                <th className="py-3 px-4">Kode</th>
                <th className="py-3 px-4">Nama Program BPJS</th>
                <th className="py-3 px-4 text-center">Ditanggung Oleh</th>
                <th className="py-3 px-4 text-center">Tarif Iuran (%)</th>
                <th className="py-3 px-4 text-right">
                  Plafon Maksimal (Wage Cap)
                </th>
                <th className="py-3 px-4">Tgl Berlaku</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center text-xs text-slate-500"
                  >
                    Memuat aturan program BPJS...
                  </td>
                </tr>
              ) : rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center text-xs text-slate-500"
                  >
                    Belum ada aturan program BPJS.
                  </td>
                </tr>
              ) : (
                rules.map((rule) => {
                  const isEmployee =
                    rule.component_code.endsWith("_EMP") ||
                    rule.component_code.includes("PEKERJA");
                  return (
                    <tr
                      key={rule.id || rule.component_code}
                      className="hover:bg-slate-800/40 transition"
                    >
                      <td className="py-3 px-4 font-mono text-xs text-sky-400 font-bold">
                        {rule.component_code}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-100">
                        {rule.component_name}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`px-2 py-0.5 text-xs rounded-full font-semibold border ${
                            isEmployee
                              ? "bg-amber-950/60 text-amber-300 border-amber-800/60"
                              : "bg-indigo-950/60 text-indigo-300 border-indigo-800/60"
                          }`}
                        >
                          {isEmployee
                            ? "Pekerja (Potongan Gaji)"
                            : "Perusahaan (Tunjangan)"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono font-bold text-slate-100">
                        <span className="px-2.5 py-1 text-xs rounded bg-slate-800 border border-slate-700 text-sky-400">
                          {rule.rate_percentage}%
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs text-slate-300">
                        {rule.wage_cap !== null && rule.wage_cap !== undefined
                          ? IDR.format(rule.wage_cap)
                          : "Tanpa Plafon (Penuh)"}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-400">
                        {rule.effective_date}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenEdit(rule)}
                            className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleDelete(
                                rule.id || rule.component_code,
                                `${rule.component_name} (${rule.component_code})`,
                              )
                            }
                            className="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-800/40 transition"
                          >
                            Hapus
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Modal Tambah/Edit Program BPJS */}
        {modalOpen && editingRule ? (
          <Modal
            title={editingRule.id ? "Edit Program BPJS" : "Tambah Program BPJS"}
            titleId="modal-bpjs-rule"
            onClose={() => {
              setModalOpen(false);
              setEditingRule(null);
            }}
          >
            <form
              onSubmit={handleSaveModal}
              className="space-y-4 text-sm text-slate-200"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="bpjs-code"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Kode Komponen (Unik)
                  </label>
                  <input
                    id="bpjs-code"
                    type="text"
                    required
                    placeholder="misal: JHT_EMP, BPJS_KES_CO"
                    value={editingRule.component_code ?? ""}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p
                          ? {
                              ...p,
                              component_code: e.target.value
                                .toUpperCase()
                                .replace(/\s+/g, "_"),
                            }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 font-mono text-xs uppercase focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="bpjs-name"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Nama Program
                  </label>
                  <input
                    id="bpjs-name"
                    type="text"
                    required
                    placeholder="misal: JHT Pekerja 2%"
                    value={editingRule.component_name ?? ""}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p ? { ...p, component_name: e.target.value } : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="bpjs-rate"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Tarif Iuran (%)
                  </label>
                  <input
                    id="bpjs-rate"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    required
                    value={editingRule.rate_percentage ?? 1.0}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p
                          ? { ...p, rate_percentage: Number(e.target.value) }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sky-400 font-mono font-bold focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="bpjs-wage-cap"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Plafon Upah / Wage Cap (Rp)
                  </label>
                  <input
                    id="bpjs-wage-cap"
                    type="number"
                    min="0"
                    placeholder="Tanpa batas (Penuh)"
                    value={editingRule.wage_cap ?? ""}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p
                          ? {
                              ...p,
                              wage_cap:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="bpjs-effective-date"
                  className="block text-xs text-slate-400 mb-1"
                >
                  Tanggal Berlaku
                </label>
                <input
                  id="bpjs-effective-date"
                  type="date"
                  required
                  value={
                    editingRule.effective_date ??
                    new Date().toISOString().slice(0, 10)
                  }
                  onChange={(e) =>
                    setEditingRule((p) =>
                      p ? { ...p, effective_date: e.target.value } : null,
                    )
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    setEditingRule(null);
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold disabled:opacity-50 shadow-md shadow-sky-600/30"
                >
                  {saving ? "Menyimpan..." : "Simpan Program"}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
