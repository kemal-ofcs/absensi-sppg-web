"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getDaftarKaryawan } from "@/lib/gateways/employee";
import {
  getHolidayWhitelist,
  type HolidayWhitelistEntry,
  type HolidayWhitelistInput,
  hapusHolidayWhitelist,
  tambahHolidayWhitelist,
  updateHolidayWhitelist,
} from "@/lib/gateways/holiday-whitelist";
import { getDaftarShift } from "@/lib/gateways/shift";

const EMPTY_DRAFT: HolidayWhitelistInput = {
  scope_type: "DIVISI",
  scope_value: "",
  tanggal_libur: null,
  keterangan: "",
  status_aktif: 1,
};

interface ShiftOption {
  kode: number;
  nama: string;
}

interface Props {
  canManage: boolean;
}

/**
 * Pengelolaan whitelist Shift/Divisi hari libur.
 *
 * Cakupan disimpan sebagai KODE shift dan NAMA divisi — bukan id_shift — karena
 * id itu AUTOINCREMENT yang berbeda di tiap perangkat, sehingga whitelist yang
 * dibuat di satu perangkat akan menunjuk shift lain begitu tersinkronisasi.
 */
export function HolidayWhitelistPanel({ canManage }: Props) {
  const [entries, setEntries] = useState<HolidayWhitelistEntry[]>([]);
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  // Saran isian nama divisi. Kegagalan memuatnya TIDAK boleh menghalangi
  // pengelolaan whitelist — nama divisi tetap bisa diketik manual.
  const [divisiOptions, setDivisiOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<HolidayWhitelistInput>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] =
    useState<HolidayWhitelistEntry | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [list, shiftRows, employeeRows] = await Promise.all([
        getHolidayWhitelist(),
        getDaftarShift().catch(() => [] as Record<string, unknown>[]),
        getDaftarKaryawan().catch(() => [] as Record<string, unknown>[]),
      ]);
      setEntries(list);
      setDivisiOptions(
        Array.from(
          new Set(
            employeeRows
              .map((row) => String(row.divisi ?? "").trim())
              .filter((value) => value !== ""),
          ),
        ).sort((a, b) => a.localeCompare(b, "id-ID")),
      );
      setShifts(
        shiftRows
          .map((row) => ({
            kode: Number(row.kode_shift ?? 0),
            nama: String(row.nama_shift ?? ""),
          }))
          .filter((row) => Number.isFinite(row.kode) && row.kode > 0),
      );
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Gagal memuat whitelist hari libur.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const shiftLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const shift of shifts) map.set(String(shift.kode), shift.nama);
    return map;
  }, [shifts]);

  const handleOpenAdd = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setModalOpen(true);
  };

  const handleOpenEdit = (item: HolidayWhitelistEntry) => {
    setEditingId(item.id);
    setDraft({
      scope_type: item.scope_type,
      scope_value: item.scope_value,
      tanggal_libur: item.tanggal_libur,
      keterangan: item.keterangan ?? "",
      status_aktif: item.status_aktif,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.scope_value.trim()) {
      setFeedback({
        tone: "error",
        message:
          draft.scope_type === "SHIFT"
            ? "Pilih Shift yang boleh scan saat hari libur."
            : "Isi nama Divisi yang boleh scan saat hari libur.",
      });
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await updateHolidayWhitelist(editingId, draft);
        setFeedback({ tone: "success", message: "Whitelist diperbarui." });
      } else {
        await tambahHolidayWhitelist(draft);
        setFeedback({ tone: "success", message: "Whitelist ditambahkan." });
      }
      setModalOpen(false);
      await loadData();
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Gagal menyimpan whitelist.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (item: HolidayWhitelistEntry) => {
    if (!canManage) return;
    const nextStatus = item.status_aktif === 1 ? 0 : 1;
    try {
      await updateHolidayWhitelist(item.id, {
        scope_type: item.scope_type,
        scope_value: item.scope_value,
        tanggal_libur: item.tanggal_libur,
        keterangan: item.keterangan,
        status_aktif: nextStatus,
      });
      setEntries((prev) =>
        prev.map((row) =>
          row.id === item.id ? { ...row, status_aktif: nextStatus } : row,
        ),
      );
    } catch (err) {
      setFeedback({
        tone: "error",
        message: err instanceof Error ? err.message : "Gagal mengubah status.",
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await hapusHolidayWhitelist(deleteTarget.id);
      setFeedback({ tone: "success", message: "Whitelist dihapus." });
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      setFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus whitelist.",
      });
    } finally {
      setSaving(false);
    }
  };

  const describeScope = (item: HolidayWhitelistEntry) => {
    if (item.scope_type === "SHIFT") {
      const nama = shiftLabel.get(item.scope_value.trim());
      return nama
        ? `Shift ${item.scope_value} - ${nama}`
        : `Shift kode ${item.scope_value}`;
    }
    return `Divisi ${item.scope_value}`;
  };

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <h2 className="text-base font-bold text-white">
            Whitelist Scan Hari Libur
          </h2>
          <p className="max-w-2xl text-xs leading-relaxed text-slate-400">
            Hanya karyawan dengan Shift atau Divisi di daftar ini yang boleh
            scan QR pada tanggal hari libur aktif — misalnya Shift Satpam,
            Divisi Keamanan, Maintenance, atau Teknisi. Karyawan lain ditolak
            dengan pesan ramah dan{" "}
            <strong className="text-slate-300">tidak</strong> kena Alfa, karena
            Generate Alfa memang melewati hari libur. Seluruh jam kerja yang
            tercatat pada tanggal libur dihitung memakai Aturan Jenjang Lembur{" "}
            <strong className="text-slate-300">HARI_LIBUR</strong>.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={handleOpenAdd}
            className="flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 active:scale-95"
          >
            <Icon name="lock" className="size-4" />
            <span>+ Tambah Whitelist</span>
          </button>
        ) : null}
      </header>

      {feedback && (
        <div className="pt-4">
          <FeedbackBanner
            tone={feedback.tone}
            onDismiss={() => setFeedback(null)}
          >
            {feedback.message}
          </FeedbackBanner>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-500">Memuat…</p>
      ) : entries.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-semibold text-slate-300">
            Belum ada Shift atau Divisi yang di-whitelist.
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Selama daftar ini kosong, seluruh scan pada hari libur ditolak —
            sama seperti perilaku aplikasi sebelumnya.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {entries.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">
                    {describeScope(item)}
                  </span>
                  <StatusBadge
                    tone={item.status_aktif === 1 ? "success" : "neutral"}
                  >
                    {item.status_aktif === 1 ? "Aktif" : "Nonaktif"}
                  </StatusBadge>
                  <StatusBadge tone={item.tanggal_libur ? "warning" : "info"}>
                    {item.tanggal_libur
                      ? `Khusus ${item.tanggal_libur}`
                      : "Semua hari libur"}
                  </StatusBadge>
                </div>
                {item.keterangan ? (
                  <p className="truncate text-xs text-slate-400">
                    {item.keterangan}
                  </p>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleToggle(item)}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white"
                  >
                    {item.status_aktif === 1 ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenEdit(item)}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-sky-500 hover:text-sky-200"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(item)}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-rose-500 hover:text-rose-200"
                  >
                    Hapus
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {modalOpen && (
        <Modal
          title={editingId ? "Edit Whitelist" : "Tambah Whitelist"}
          titleId="whitelist-modal-title"
          onClose={() => setModalOpen(false)}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="whitelist-scope-type"
                className="mb-1.5 block text-xs font-semibold text-slate-300"
              >
                Cakupan
              </label>
              <select
                id="whitelist-scope-type"
                value={draft.scope_type}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    scope_type: event.target.value,
                    scope_value: "",
                  }))
                }
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none transition focus:border-emerald-500"
              >
                <option value="DIVISI">Divisi</option>
                <option value="SHIFT">Shift</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="whitelist-scope-value"
                className="mb-1.5 block text-xs font-semibold text-slate-300"
              >
                {draft.scope_type === "SHIFT" ? "Shift" : "Nama Divisi"}
              </label>
              {draft.scope_type === "SHIFT" ? (
                <select
                  id="whitelist-scope-value"
                  value={draft.scope_value}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      scope_value: event.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none transition focus:border-emerald-500"
                >
                  <option value="">— Pilih Shift —</option>
                  {shifts.map((shift) => (
                    <option key={shift.kode} value={String(shift.kode)}>
                      {shift.kode} - {shift.nama}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    id="whitelist-scope-value"
                    list="whitelist-divisi-options"
                    value={draft.scope_value}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        scope_value: event.target.value,
                      }))
                    }
                    placeholder="Contoh: Keamanan"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-emerald-500"
                  />
                  <datalist id="whitelist-divisi-options">
                    {divisiOptions.map((divisi) => (
                      <option key={divisi} value={divisi} />
                    ))}
                  </datalist>
                </>
              )}
            </div>

            <div>
              <label
                htmlFor="whitelist-tanggal"
                className="mb-1.5 block text-xs font-semibold text-slate-300"
              >
                Berlaku pada tanggal (opsional)
              </label>
              <input
                id="whitelist-tanggal"
                type="date"
                value={draft.tanggal_libur ?? ""}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    tanggal_libur: event.target.value || null,
                  }))
                }
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none transition focus:border-emerald-500"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Kosongkan agar berlaku untuk SEMUA hari libur. Isi hanya bila
                pengecualian ini khusus satu tanggal.
              </p>
            </div>

            <div>
              <label
                htmlFor="whitelist-keterangan"
                className="mb-1.5 block text-xs font-semibold text-slate-300"
              >
                Keterangan (opsional)
              </label>
              <input
                id="whitelist-keterangan"
                value={draft.keterangan ?? ""}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    keterangan: event.target.value,
                  }))
                }
                placeholder="Contoh: Piket jaga gedung"
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-emerald-500"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-slate-500"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-400 disabled:opacity-60"
              >
                {saving ? "Menyimpan…" : "Simpan"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="Hapus Whitelist"
          titleId="whitelist-delete-title"
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-sm text-slate-300">
            Hapus <strong>{describeScope(deleteTarget)}</strong> dari whitelist?
            Setelah dihapus, karyawan pada cakupan itu tidak lagi bisa scan pada
            hari libur.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-slate-500"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={saving}
              className="rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-400 disabled:opacity-60"
            >
              {saving ? "Menghapus…" : "Hapus"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
