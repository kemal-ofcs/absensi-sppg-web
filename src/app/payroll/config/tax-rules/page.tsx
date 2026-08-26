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
  deleteTaxRule,
  getTaxRules,
  saveTaxRule,
  type TaxRuleRow,
} from "@/lib/gateways/payroll";
import { syncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function TaxRulesPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [rules, setRules] = useState<TaxRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "PASAL_17" | "TER_A" | "TER_B" | "TER_C"
  >("PASAL_17");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Partial<TaxRuleRow> | null>(
    null,
  );

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTaxRules();
      setRules(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal memuat aturan pajak PPh 21.",
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

  const handleOpenAdd = (
    category: "PASAL_17" | "TER_A" | "TER_B" | "TER_C",
  ) => {
    const existing = rules.filter((r) => r.category === category);
    const lastBracket = existing[existing.length - 1];
    const minVal = lastBracket?.bracket_max ? lastBracket.bracket_max + 1 : 0;

    setEditingRule({
      id: "",
      category,
      bracket_min: minVal,
      bracket_max: null,
      rate_percentage: 5.0,
      effective_date: new Date().toISOString().slice(0, 10),
    });
    setModalOpen(true);
  };

  const handleOpenEdit = (rule: TaxRuleRow) => {
    setEditingRule({ ...rule });
    setModalOpen(true);
  };

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Hapus lapisan tarif pajak "${label}"?`)) return;
    setSaving(true);
    setFeedback(null);
    try {
      await deleteTaxRule(id);
      setFeedback({
        type: "success",
        message: `Lapisan tarif pajak "${label}" berhasil dihapus.`,
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus lapisan pajak.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRule) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveTaxRule(editingRule);
      setModalOpen(false);
      setEditingRule(null);
      setFeedback({
        type: "success",
        message: "Lapisan tarif pajak berhasil disimpan.",
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menyimpan tarif pajak.",
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

  const currentCategoryRules = rules.filter((r) => r.category === activeTab);

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Konfigurasi Pajak"
          title="Aturan Pajak PPh 21 (PMK 168/2023 & UU HPP)"
          description="Konfigurasi bracket tarif Pasal 17 dan kategori Tarif Efektif Rata-Rata (TER) A, B, C secara dinamis."
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

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab("PASAL_17")}
            className={`p-4 rounded-xl text-left border transition ${
              activeTab === "PASAL_17"
                ? "bg-slate-900 border-amber-500 shadow-md shadow-amber-500/10"
                : "bg-slate-900/60 border-slate-800 hover:bg-slate-900"
            }`}
          >
            <span className="text-xs font-bold text-amber-400 uppercase">
              Pasal 17 UU HPP
            </span>
            <p className="text-xs text-slate-300 font-medium mt-1">
              Tarif Progresif Tahunan
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Rekonsiliasi Masa Desember
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("TER_A")}
            className={`p-4 rounded-xl text-left border transition ${
              activeTab === "TER_A"
                ? "bg-slate-900 border-sky-500 shadow-md shadow-sky-500/10"
                : "bg-slate-900/60 border-slate-800 hover:bg-slate-900"
            }`}
          >
            <span className="text-xs font-bold text-sky-400 uppercase">
              Kategori TER A
            </span>
            <p className="text-xs text-slate-300 font-medium mt-1">
              TK/0, TK/1, K/0
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Masa Bulanan Jan–Nov
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("TER_B")}
            className={`p-4 rounded-xl text-left border transition ${
              activeTab === "TER_B"
                ? "bg-slate-900 border-indigo-500 shadow-md shadow-indigo-500/10"
                : "bg-slate-900/60 border-slate-800 hover:bg-slate-900"
            }`}
          >
            <span className="text-xs font-bold text-indigo-400 uppercase">
              Kategori TER B
            </span>
            <p className="text-xs text-slate-300 font-medium mt-1">
              TK/2, TK/3, K/1, K/2
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Masa Bulanan Jan–Nov
            </p>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("TER_C")}
            className={`p-4 rounded-xl text-left border transition ${
              activeTab === "TER_C"
                ? "bg-slate-900 border-emerald-500 shadow-md shadow-emerald-500/10"
                : "bg-slate-900/60 border-slate-800 hover:bg-slate-900"
            }`}
          >
            <span className="text-xs font-bold text-emerald-400 uppercase">
              Kategori TER C
            </span>
            <p className="text-xs text-slate-300 font-medium mt-1">
              K/3 (PTKP Tertinggi)
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Masa Bulanan Jan–Nov
            </p>
          </button>
        </div>

        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-200">
                Daftar Lapisan Tarif:{" "}
                <span className="text-sky-400 font-mono">{activeTab}</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Penghasilan bruto bulanan dipetakan ke lapisan tarif yang
                sesuai.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleOpenAdd(activeTab)}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition flex items-center gap-1.5 shadow-sm"
            >
              <Icon name="plus" className="w-3.5 h-3.5" />
              Tambah Lapisan {activeTab}
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
                <tr>
                  <th className="py-3 px-4">Rentang Bruto Minimum</th>
                  <th className="py-3 px-4">Rentang Bruto Maksimum</th>
                  <th className="py-3 px-4 text-center">Tarif Pajak (%)</th>
                  <th className="py-3 px-4">Tgl Berlaku</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-950/40 font-mono">
                {loading ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-8 text-center text-xs text-slate-500 font-sans"
                    >
                      Memuat aturan lapisan tarif pajak...
                    </td>
                  </tr>
                ) : currentCategoryRules.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-8 text-center text-xs text-slate-500 font-sans"
                    >
                      Belum ada lapisan tarif untuk kategori ini.
                    </td>
                  </tr>
                ) : (
                  currentCategoryRules.map((r, idx) => (
                    <tr key={r.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-3 px-4 text-slate-200 font-medium">
                        {IDR.format(r.bracket_min)}
                      </td>
                      <td className="py-3 px-4 text-slate-200 font-medium">
                        {r.bracket_max !== null && r.bracket_max !== undefined
                          ? IDR.format(r.bracket_max)
                          : "Diatas / Tanpa Batas"}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="px-2.5 py-1 text-xs rounded bg-sky-950/80 text-sky-400 font-bold border border-sky-800/50">
                          {r.rate_percentage}%
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-400 font-sans">
                        {r.effective_date}
                      </td>
                      <td className="py-3 px-4 text-right font-sans">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenEdit(r)}
                            className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleDelete(
                                r.id,
                                `${r.category} Lapis ${idx + 1} (${r.rate_percentage}%)`,
                              )
                            }
                            className="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-800/40 transition"
                          >
                            Hapus
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {modalOpen && editingRule ? (
          <Modal
            title={
              editingRule.id ? "Edit Lapisan Pajak" : "Tambah Lapisan Pajak"
            }
            titleId="modal-tax-rule"
            onClose={() => {
              setModalOpen(false);
              setEditingRule(null);
            }}
          >
            <form
              onSubmit={handleSaveModal}
              className="space-y-4 text-sm text-slate-200"
            >
              <div>
                <label
                  htmlFor="tax-category"
                  className="block text-xs text-slate-400 mb-1"
                >
                  Kategori Pajak
                </label>
                <select
                  id="tax-category"
                  value={editingRule.category}
                  onChange={(e) =>
                    setEditingRule((p) =>
                      p
                        ? {
                            ...p,
                            category: e.target.value as
                              | "PASAL_17"
                              | "TER_A"
                              | "TER_B"
                              | "TER_C",
                          }
                        : null,
                    )
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
                >
                  <option value="PASAL_17">Pasal 17 UU HPP (Tahunan)</option>
                  <option value="TER_A">TER Kategori A (Bulanan)</option>
                  <option value="TER_B">TER Kategori B (Bulanan)</option>
                  <option value="TER_C">TER Kategori C (Bulanan)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="tax-bracket-min"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Penghasilan Bruto Min (Rp)
                  </label>
                  <input
                    id="tax-bracket-min"
                    type="number"
                    min="0"
                    required
                    value={editingRule.bracket_min ?? 0}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p
                          ? { ...p, bracket_min: Number(e.target.value) }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor="tax-bracket-max"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Penghasilan Bruto Max (Rp)
                  </label>
                  <input
                    id="tax-bracket-max"
                    type="number"
                    min="0"
                    placeholder="Tanpa batas (+)"
                    value={editingRule.bracket_max ?? ""}
                    onChange={(e) =>
                      setEditingRule((p) =>
                        p
                          ? {
                              ...p,
                              bracket_max:
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

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="tax-rate-percentage"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Tarif Pajak (%)
                  </label>
                  <input
                    id="tax-rate-percentage"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    required
                    value={editingRule.rate_percentage ?? 0}
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
                    htmlFor="tax-effective-date"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Tanggal Berlaku
                  </label>
                  <input
                    id="tax-effective-date"
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
                  {saving ? "Menyimpan..." : "Simpan Lapisan"}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
