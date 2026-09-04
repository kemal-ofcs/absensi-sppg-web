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
  deleteOvertimeRule,
  getOvertimeRules,
  type OvertimeTierRuleRow,
  saveOvertimeRule,
} from "@/lib/gateways/payroll";
import { syncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function OvertimeRulesPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [rules, setRules] = useState<OvertimeTierRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTier, setEditingTier] =
    useState<Partial<OvertimeTierRuleRow> | null>(null);

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOvertimeRules();
      setRules(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal memuat aturan lembur.",
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

  const handleOpenAdd = (ruleType: "HARI_KERJA" | "HARI_LIBUR") => {
    const existing = rules.filter((r) => r.rule_type === ruleType);
    const nextOrder =
      existing.length > 0
        ? Math.max(...existing.map((e) => e.tier_order)) + 1
        : 1;
    const lastTier = existing.find((e) => e.tier_order === nextOrder - 1);
    const startHour =
      lastTier?.hour_end ??
      (existing.length > 0 ? (lastTier?.hour_start ?? 0) + 1 : 0);

    setEditingTier({
      id: "",
      rule_type: ruleType,
      tier_order: nextOrder,
      hour_start: startHour,
      hour_end: null,
      multiplier: ruleType === "HARI_KERJA" ? 2.0 : 3.0,
      is_active: 1,
    });
    setModalOpen(true);
  };

  const handleOpenEdit = (rule: OvertimeTierRuleRow) => {
    setEditingTier({ ...rule });
    setModalOpen(true);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Hapus jenjang lembur "${name}"?`)) return;
    setSaving(true);
    setFeedback(null);
    try {
      await deleteOvertimeRule(id);
      setFeedback({
        type: "success",
        message: `Jenjang lembur "${name}" berhasil dihapus.`,
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal menghapus jenjang lembur.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTier) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveOvertimeRule(editingTier);
      setModalOpen(false);
      setEditingTier(null);
      setFeedback({
        type: "success",
        message: "Jenjang lembur berhasil disimpan.",
      });
      await loadRules();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal menyimpan jenjang lembur.",
      });
    } finally {
      setSaving(false);
    }
  };

  const workDayRules = rules.filter((r) => r.rule_type === "HARI_KERJA");
  const holidayRules = rules.filter((r) => r.rule_type === "HARI_LIBUR");

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
          eyebrow="Konfigurasi Lembur"
          title="Aturan Jenjang Lembur (PP 35/2021)"
          description="Konfigurasi perkalian indeks upah lembur per jam untuk Hari Kerja biasa dan Hari Libur resmi secara dinamis."
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Hari Kerja Biasa */}
          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-sky-400"></span>
                  Hari Kerja Biasa
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Lembur pada hari kerja setelah jam kerja shift normal.
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleOpenAdd("HARI_KERJA")}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition flex items-center gap-1.5 shadow-sm"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
                Tambah Tier
              </button>
            </div>

            <div className="space-y-3">
              {loading ? (
                <div className="overtime-empty-state p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-lg border border-slate-800/80">
                  Memuat aturan tier lembur...
                </div>
              ) : workDayRules.length === 0 ? (
                <div className="overtime-empty-state p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-lg border border-slate-800/80">
                  Belum ada tier lembur hari kerja.
                </div>
              ) : (
                workDayRules.map((r) => (
                  <div
                    key={r.id}
                    className="overtime-tier-row p-3.5 bg-slate-800/60 border border-slate-700/60 rounded-xl flex items-center justify-between gap-4 transition"
                  >
                    <div>
                      <div className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                        <span>Tier {r.tier_order}</span>
                        <span className="overtime-multiplier-badge-sky text-xs px-2 py-0.5 rounded bg-sky-950/80 text-sky-400 font-mono font-bold border border-sky-800/50">
                          {r.multiplier}x Upah
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        Jam ke-{r.hour_start + 1}
                        {r.hour_end
                          ? ` s.d. Jam ke-${r.hour_end}`
                          : " dan seterusnya"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(r)}
                        className="overtime-btn-edit px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleDelete(r.id, `Tier ${r.tier_order} Hari Kerja`)
                        }
                        className="overtime-btn-delete px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-800/40 transition"
                      >
                        Hapus
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Hari Libur Resmi */}
          <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  Hari Libur & Istirahat Mingguan
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Lembur saat tanggal merah / libur nasional.
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleOpenAdd("HARI_LIBUR")}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition flex items-center gap-1.5 shadow-sm"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
                Tambah Tier
              </button>
            </div>

            <div className="space-y-3">
              {loading ? (
                <div className="overtime-empty-state p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-lg border border-slate-800/80">
                  Memuat aturan tier lembur...
                </div>
              ) : holidayRules.length === 0 ? (
                <div className="overtime-empty-state p-6 text-center text-xs text-slate-500 bg-slate-950/40 rounded-lg border border-slate-800/80">
                  Belum ada tier lembur hari libur.
                </div>
              ) : (
                holidayRules.map((r) => (
                  <div
                    key={r.id}
                    className="overtime-tier-row p-3.5 bg-slate-800/60 border border-slate-700/60 rounded-xl flex items-center justify-between gap-4 transition"
                  >
                    <div>
                      <div className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                        <span>Tier {r.tier_order}</span>
                        <span className="overtime-multiplier-badge-amber text-xs px-2 py-0.5 rounded bg-amber-950/80 text-amber-400 font-mono font-bold border border-amber-800/50">
                          {r.multiplier}x Upah
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        Jam ke-{r.hour_start + 1}
                        {r.hour_end
                          ? ` s.d. Jam ke-${r.hour_end}`
                          : " dan seterusnya"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(r)}
                        className="overtime-btn-edit px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleDelete(r.id, `Tier ${r.tier_order} Hari Libur`)
                        }
                        className="overtime-btn-delete px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-lg border border-rose-800/40 transition"
                      >
                        Hapus
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Modal Form Tambah/Edit Tier */}
        {modalOpen && editingTier ? (
          <Modal
            title={
              editingTier.id ? "Edit Jenjang Lembur" : "Tambah Jenjang Lembur"
            }
            titleId="modal-overtime-tier"
            onClose={() => {
              setModalOpen(false);
              setEditingTier(null);
            }}
          >
            <form
              onSubmit={handleSaveModal}
              className="space-y-4 text-sm text-slate-200"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="overtime-rule-type"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Jenis Hari
                  </label>
                  <select
                    id="overtime-rule-type"
                    value={editingTier.rule_type}
                    onChange={(e) =>
                      setEditingTier((p) =>
                        p
                          ? {
                              ...p,
                              rule_type: e.target.value as
                                | "HARI_KERJA"
                                | "HARI_LIBUR",
                            }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
                  >
                    <option value="HARI_KERJA">Hari Kerja Biasa</option>
                    <option value="HARI_LIBUR">
                      Hari Libur / Tanggal Merah
                    </option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="overtime-tier-order"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Nomor Urut Tier
                  </label>
                  <input
                    id="overtime-tier-order"
                    type="number"
                    min="1"
                    required
                    value={editingTier.tier_order ?? 1}
                    onChange={(e) =>
                      setEditingTier((p) =>
                        p ? { ...p, tier_order: Number(e.target.value) } : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="overtime-hour-start"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Mulai Jam Ke-
                  </label>
                  <input
                    id="overtime-hour-start"
                    type="number"
                    step="0.5"
                    min="0"
                    required
                    value={(editingTier.hour_start ?? 0) + 1}
                    onChange={(e) =>
                      setEditingTier((p) =>
                        p
                          ? {
                              ...p,
                              hour_start: Math.max(
                                0,
                                Number(e.target.value) - 1,
                              ),
                            }
                          : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor="overtime-hour-end"
                    className="block text-xs text-slate-400 mb-1"
                  >
                    Sampai Jam Ke- (Opsional)
                  </label>
                  <input
                    id="overtime-hour-end"
                    type="number"
                    step="0.5"
                    placeholder="Tanpa batas (+)"
                    value={editingTier.hour_end ?? ""}
                    onChange={(e) =>
                      setEditingTier((p) =>
                        p
                          ? {
                              ...p,
                              hour_end:
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
                  htmlFor="overtime-multiplier"
                  className="block text-xs text-slate-400 mb-1"
                >
                  Pengali Indeks (Multiplier)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="overtime-multiplier"
                    type="number"
                    step="0.1"
                    min="1.0"
                    required
                    value={editingTier.multiplier ?? 1.5}
                    onChange={(e) =>
                      setEditingTier((p) =>
                        p ? { ...p, multiplier: Number(e.target.value) } : null,
                      )
                    }
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sky-400 font-mono font-bold focus:outline-none focus:border-sky-500"
                  />
                  <span className="text-sm font-bold text-slate-400">
                    x Upah/Jam
                  </span>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    setEditingTier(null);
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
                  {saving ? "Menyimpan..." : "Simpan Jenjang"}
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
