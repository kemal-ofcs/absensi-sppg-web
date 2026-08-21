"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getDaftarHariLibur,
  type HariLiburInput,
  type HariLiburRecord,
  hapusHariLibur,
  tambahHariLibur,
  updateHariLibur,
} from "@/lib/gateways/holiday";
import { useHydrated } from "@/lib/hooks/useHydrated";

const EMPTY_DRAFT: HariLiburInput = {
  tanggal: "",
  nama_libur: "",
  jenis_libur: "Libur Nasional",
  keterangan: "",
  status_aktif: 1,
};

function formatDisplayDate(dateStr: string) {
  if (!dateStr) return "-";
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  } catch {
    return dateStr;
  }
}

export default function HolidaysPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [holidays, setHolidays] = useState<HariLiburRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterJenis, setFilterJenis] = useState("all");
  const [filterYear, setFilterYear] = useState<string>("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<HariLiburInput>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<HariLiburRecord | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const canManage = hasPermission(user, "holidays.manage");

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getDaftarHariLibur();
      setHolidays(data);
    } catch (err) {
      if (!silent) {
        setFeedback({
          tone: "error",
          message:
            err instanceof Error
              ? err.message
              : "Gagal memuat daftar hari libur.",
        });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;
    loadData();
  }, [isHydrated, isAuthenticated, loadData]);

  useEffect(() => {
    const onSyncCompleted = () => {
      loadData(true);
    };
    window.addEventListener("sppg:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("sppg:sync-completed", onSyncCompleted);
    };
  }, [loadData]);

  if (!isHydrated || authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex items-center gap-3 text-slate-400">
          <Icon name="clock" className="size-6 animate-spin text-sky-400" />
          <span>Memuat data kalender hari libur...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    redirect("/login");
  }

  if (!canAccessArea(user, "holidays")) {
    redirect("/forbidden");
  }

  const availableYears = Array.from(
    new Set(
      holidays
        .map((h) => h.tanggal.split("-")[0])
        .filter(Boolean)
        .sort((a, b) => Number(b) - Number(a)),
    ),
  );

  const filteredHolidays = holidays.filter((h) => {
    const matchSearch =
      h.nama_libur.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (h.keterangan || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      h.tanggal.includes(searchQuery);

    const matchJenis = filterJenis === "all" || h.jenis_libur === filterJenis;
    const matchYear =
      filterYear === "all" || h.tanggal.startsWith(`${filterYear}-`);

    return matchSearch && matchJenis && matchYear;
  });

  const handleOpenAdd = () => {
    setEditingId(null);
    const today = new Date().toISOString().split("T")[0];
    setDraft({
      tanggal: today,
      nama_libur: "",
      jenis_libur: "Libur Nasional",
      keterangan: "",
      status_aktif: 1,
    });
    setModalOpen(true);
  };

  const handleOpenEdit = (item: HariLiburRecord) => {
    setEditingId(item.id_libur);
    setDraft({
      tanggal: item.tanggal,
      nama_libur: item.nama_libur,
      jenis_libur: item.jenis_libur,
      keterangan: item.keterangan || "",
      status_aktif: item.status_aktif,
    });
    setModalOpen(true);
  };

  const handleToggleStatus = async (item: HariLiburRecord) => {
    if (!canManage) return;
    const nextStatus = item.status_aktif === 1 ? 0 : 1;
    try {
      await updateHariLibur(item.id_libur, { status_aktif: nextStatus });
      setHolidays((prev) =>
        prev.map((h) =>
          h.id_libur === item.id_libur ? { ...h, status_aktif: nextStatus } : h,
        ),
      );
      setFeedback({
        tone: "success",
        message: `Status libur "${item.nama_libur}" berhasil diubah menjadi ${nextStatus === 1 ? "Aktif" : "Nonaktif"}.`,
      });
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal mengubah status hari libur.",
      });
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.tanggal || !draft.nama_libur) {
      setFeedback({
        tone: "error",
        message: "Tanggal dan nama hari libur wajib diisi.",
      });
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await updateHariLibur(editingId, draft);
        setFeedback({
          tone: "success",
          message: "Data hari libur berhasil diperbarui.",
        });
      } else {
        await tambahHariLibur(draft);
        setFeedback({
          tone: "success",
          message: "Hari libur baru berhasil ditambahkan.",
        });
      }
      setModalOpen(false);
      await loadData();
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal menyimpan data hari libur.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await hapusHariLibur(deleteTarget.id_libur);
      setFeedback({
        tone: "success",
        message: `Hari libur "${deleteTarget.nama_libur}" berhasil dihapus.`,
      });
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus hari libur.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell contentClassName="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Operasional & Kalender"
          title="Kalender & Manajemen Hari Libur"
          description="Atur jadwal hari libur nasional, cuti bersama, dan hari non-kerja. Pada tanggal libur aktif, QR Scanner otomatis menolak scan dan Generate Alfa otomatis dinonaktifkan."
          actions={
            canManage ? (
              <button
                type="button"
                onClick={handleOpenAdd}
                className="flex items-center gap-2 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 active:scale-95"
              >
                <Icon name="calendar" className="size-4" />
                <span>+ Tambah Hari Libur</span>
              </button>
            ) : null
          }
        />

        {feedback && (
          <FeedbackBanner
            tone={feedback.tone}
            onDismiss={() => setFeedback(null)}
          >
            {feedback.message}
          </FeedbackBanner>
        )}

        {/* Filter Card */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="relative">
            <input
              type="text"
              placeholder="Cari nama atau tanggal libur..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-sky-500"
            />
          </div>
          <div>
            <select
              value={filterJenis}
              onChange={(e) => setFilterJenis(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2.5 text-sm text-white outline-none transition focus:border-sky-500"
            >
              <option value="all">Semua Jenis Libur</option>
              <option value="Libur Nasional">Libur Nasional</option>
              <option value="Cuti Bersama">Cuti Bersama</option>
              <option value="Libur Khusus">Libur Khusus / Perusahaan</option>
            </select>
          </div>
          <div>
            <select
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2.5 text-sm text-white outline-none transition focus:border-sky-500"
            >
              <option value="all">Semua Tahun</option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  Tahun {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Table Card */}
        <div className="overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/50 shadow-xl backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800/80 bg-slate-950/60 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-6 py-4">Tanggal Libur</th>
                  <th className="px-6 py-4">Nama Hari Libur</th>
                  <th className="px-6 py-4">Jenis</th>
                  <th className="px-6 py-4">Keterangan</th>
                  <th className="px-6 py-4">Status</th>
                  {canManage && <th className="px-6 py-4 text-right">Aksi</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40 text-slate-300">
                {loading ? (
                  <tr>
                    <td
                      colSpan={canManage ? 6 : 5}
                      className="px-6 py-12 text-center text-slate-400"
                    >
                      <div className="flex items-center justify-center gap-3">
                        <Icon
                          name="clock"
                          className="size-5 animate-spin text-sky-400"
                        />
                        <span>Memuat jadwal hari libur...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredHolidays.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canManage ? 6 : 5}
                      className="px-6 py-12 text-center text-slate-500"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <Icon
                          name="calendar"
                          className="size-8 text-slate-600"
                        />
                        <span>
                          Tidak ada data hari libur yang sesuai filter.
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredHolidays.map((item) => {
                    const isAktif = item.status_aktif === 1;
                    return (
                      <tr
                        key={item.id_libur}
                        className="transition hover:bg-white/[0.02]"
                      >
                        <td className="px-6 py-4 font-medium text-white whitespace-nowrap">
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
                              <Icon name="calendar" className="size-3.5" />
                            </span>
                            <div>
                              <div>{formatDisplayDate(item.tanggal)}</div>
                              <div className="text-xs text-slate-500">
                                {item.tanggal}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 font-bold text-white">
                          {item.nama_libur}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                              item.jenis_libur === "Libur Nasional"
                                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                                : item.jenis_libur === "Cuti Bersama"
                                  ? "border border-amber-500/20 bg-amber-500/10 text-amber-400"
                                  : "border border-purple-500/20 bg-purple-500/10 text-purple-400"
                            }`}
                          >
                            {item.jenis_libur}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-400">
                          {item.keterangan || "-"}
                        </td>
                        <td className="px-6 py-4">
                          {canManage ? (
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(item)}
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold transition hover:opacity-80 ${
                                isAktif
                                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                  : "bg-slate-800 text-slate-400 border border-slate-700"
                              }`}
                            >
                              <span
                                className={`size-1.5 rounded-full ${isAktif ? "bg-emerald-400" : "bg-slate-500"}`}
                              />
                              {isAktif ? "Aktif" : "Nonaktif"}
                            </button>
                          ) : (
                            <StatusBadge tone={isAktif ? "success" : "danger"}>
                              {isAktif ? "Aktif" : "Nonaktif"}
                            </StatusBadge>
                          )}
                        </td>
                        {canManage && (
                          <td className="px-6 py-4 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleOpenEdit(item)}
                                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
                                title="Edit Hari Libur"
                              >
                                <Icon name="tools" className="size-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(item)}
                                className="rounded-lg p-1.5 text-rose-400 transition hover:bg-rose-500/20 hover:text-rose-300"
                                title="Hapus Hari Libur"
                              >
                                <Icon name="reset" className="size-4" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modal Form Tambah / Edit */}
        {modalOpen ? (
          <Modal
            titleId="modal-holiday-form"
            onClose={() => !saving && setModalOpen(false)}
            title={editingId ? "Edit Hari Libur" : "Tambah Hari Libur Baru"}
          >
            <form onSubmit={handleFormSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="holiday-date"
                  className="mb-1 block text-xs font-bold text-slate-300 uppercase tracking-wider"
                >
                  Tanggal Libur (YYYY-MM-DD) *
                </label>
                <input
                  id="holiday-date"
                  type="date"
                  required
                  value={draft.tanggal}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, tanggal: e.target.value }))
                  }
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-white outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label
                  htmlFor="holiday-name"
                  className="mb-1 block text-xs font-bold text-slate-300 uppercase tracking-wider"
                >
                  Nama Hari Libur *
                </label>
                <input
                  id="holiday-name"
                  type="text"
                  required
                  placeholder="Contoh: Hari Kemerdekaan RI, Cuti Bersama Idul Fitri"
                  value={draft.nama_libur}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      nama_libur: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-white outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label
                  htmlFor="holiday-type"
                  className="mb-1 block text-xs font-bold text-slate-300 uppercase tracking-wider"
                >
                  Jenis Hari Libur
                </label>
                <select
                  id="holiday-type"
                  value={draft.jenis_libur}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      jenis_libur: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-white outline-none focus:border-sky-500"
                >
                  <option value="Libur Nasional">Libur Nasional</option>
                  <option value="Cuti Bersama">Cuti Bersama</option>
                  <option value="Libur Khusus">
                    Libur Khusus / Perusahaan
                  </option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="holiday-notes"
                  className="mb-1 block text-xs font-bold text-slate-300 uppercase tracking-wider"
                >
                  Keterangan / Catatan (Opsional)
                </label>
                <textarea
                  id="holiday-notes"
                  rows={2}
                  placeholder="Keterangan tambahan..."
                  value={draft.keterangan || ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      keterangan: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-white outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div>
                  <div className="text-xs font-bold text-white">
                    Status Aktif
                  </div>
                  <div className="text-xs text-slate-400">
                    Hanya hari libur berstatus Aktif yang akan menonaktifkan
                    scanner dan Alfa.
                  </div>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={draft.status_aktif === 1}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        status_aktif: e.target.checked ? 1 : 0,
                      }))
                    }
                    className="sr-only peer"
                  />
                  <div className="h-6 w-11 rounded-full bg-slate-800 peer peer-checked:bg-sky-500 peer-focus:outline-none after:absolute after:top-0.5 after:left-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white" />
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                  className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/5"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 rounded-xl bg-sky-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 disabled:opacity-50"
                >
                  {saving && (
                    <Icon name="clock" className="size-3.5 animate-spin" />
                  )}
                  <span>Simpan Hari Libur</span>
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {/* Modal Delete Confirmation */}
        {deleteTarget ? (
          <Modal
            titleId="modal-holiday-delete"
            onClose={() => !saving && setDeleteTarget(null)}
            title="Konfirmasi Hapus Hari Libur"
          >
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                Apakah Anda yakin ingin menghapus hari libur{" "}
                <strong className="text-white">
                  "{deleteTarget.nama_libur}"
                </strong>{" "}
                pada tanggal{" "}
                <strong className="text-white">
                  {formatDisplayDate(deleteTarget.tanggal)}
                </strong>
                ?
              </p>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">
                Setelah dihapus, sistem scanner dan Generate Alfa pada tanggal
                tersebut akan kembali berjalan normal.
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  disabled={saving}
                  className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/5"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving}
                  className="flex items-center gap-2 rounded-xl bg-rose-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-rose-500/20 transition hover:bg-rose-400 disabled:opacity-50"
                >
                  {saving && (
                    <Icon name="clock" className="size-3.5 animate-spin" />
                  )}
                  <span>Hapus Hari Libur</span>
                </button>
              </div>
            </div>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
