"use client";

import { redirect } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getDaftarShift,
  type ShiftInput,
  tambahShift,
  updateShift,
} from "@/lib/gateways/shift";
import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  firstValidationMessage,
  validateShiftDraft,
} from "@/lib/validations/stabilization";

export default function ShiftPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canManage = hasPermission(user, "shifts.manage");

  const [shiftList, setShiftList] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Modal State
  const [showModal, setShowModal] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState<ShiftInput>({
    kode_shift: 1,
    nama_shift: "",
    jam_masuk: "07:00",
    jam_pulang: "15:00",
    toleransi_masuk_menit: 0,
    jam_kerja_normal_menit: 480,
    istirahat_menit: 60,
  });
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const loadShifts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDaftarShift();
      setShiftList(data);
      setErrorMsg(null);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Data shift belum dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isHydrated && isAuthenticated) {
      loadShifts();
    }
  }, [isHydrated, isAuthenticated, loadShifts]);

  const openAddModal = () => {
    setIsEditing(false);
    setEditId(null);
    const usedCodes = new Set(
      shiftList.map((shift) => Number(shift.kode_shift)),
    );
    let nextKode = 1;
    while (usedCodes.has(nextKode)) nextKode += 1;
    setFormData({
      kode_shift: nextKode,
      nama_shift: `Shift ${nextKode} - Regular`,
      jam_masuk: "08:00",
      jam_pulang: "16:00",
      toleransi_masuk_menit: 15,
      jam_kerja_normal_menit: 480,
      istirahat_menit: 60,
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (row: Record<string, unknown>) => {
    setIsEditing(true);
    const id = Number(row.id_shift);
    setEditId(id);
    setFormData({
      kode_shift: Number(row.kode_shift || 1),
      nama_shift: String(row.nama_shift || ""),
      jam_masuk: String(row.jam_masuk || "07:00"),
      jam_pulang: String(row.jam_pulang || "15:00"),
      toleransi_masuk_menit: Number(row.toleransi_masuk_menit || 0),
      jam_kerja_normal_menit: Number(row.jam_kerja_normal_menit || 480),
      istirahat_menit: Number(row.istirahat_menit || 60),
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validateShiftDraft(formData);
    if (Object.keys(validationErrors).length > 0) {
      setFormErrors(validationErrors);
      setErrorMsg(firstValidationMessage(validationErrors));
      return;
    }

    try {
      if (isEditing && editId) {
        await updateShift(editId, formData);
        setAlertMsg(`Shift ${formData.nama_shift} berhasil diperbarui.`);
      } else {
        await tambahShift(formData);
        setAlertMsg(`Shift baru ${formData.nama_shift} berhasil ditambahkan.`);
      }
      setShowModal(false);
      await loadShifts();
      setFormErrors({});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menyimpan shift.";
      setErrorMsg(msg);
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Pengaturan Shift...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "shift")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="text-xs uppercase tracking-widest text-amber-400 font-semibold font-mono">
            Shift Configuration & Rules
          </span>
          <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
            🕒 Pengaturan Shift & Toleransi Jam Absensi
          </h1>
          <p className="text-xs text-slate-400">
            Konfigurasi jam masuk, jam pulang, toleransi keterlambatan, dan
            durasi kerja normal per shift.
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={openAddModal}
            className="px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-bold text-xs rounded-xl transition shadow-lg shadow-amber-950/60 flex items-center gap-1.5 active:scale-95"
          >
            Tambah Shift Baru
          </button>
        ) : null}
      </div>

      {/* Feedback Alert */}
      {alertMsg ? (
        <FeedbackBanner tone="success" onDismiss={() => setAlertMsg(null)}>
          {alertMsg}
        </FeedbackBanner>
      ) : null}
      {errorMsg && !showModal ? (
        <FeedbackBanner tone="error" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </FeedbackBanner>
      ) : null}

      {/* Shift Grid Cards */}
      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center space-y-3">
          <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono">
            Memuat konfigurasi shift...
          </p>
        </div>
      ) : shiftList.length === 0 ? (
        <div className="app-panel rounded-3xl px-6 py-16 text-center">
          <p className="text-base font-bold text-white">Belum ada shift</p>
          <p className="mt-2 text-sm text-slate-400">
            Tambahkan shift pertama untuk mulai mengatur jadwal karyawan.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {shiftList.map((row) => (
            <div
              key={String(row.id_shift)}
              className="bg-slate-900/90 border border-slate-800 hover:border-amber-500/50 rounded-3xl p-6 space-y-4 shadow-xl transition flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="px-2.5 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-xs font-mono font-bold">
                    Kode Shift #{String(row.kode_shift)}
                  </span>
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => openEditModal(row)}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded-lg text-xs font-mono border border-slate-700 transition"
                    >
                      Edit Shift
                    </button>
                  ) : null}
                </div>

                <h3 className="text-lg font-bold text-white">
                  {String(row.nama_shift)}
                </h3>

                <div className="grid grid-cols-2 gap-3 p-3 bg-slate-950 border border-slate-800 rounded-2xl font-mono text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 block">
                      Jam Masuk:
                    </span>
                    <span className="text-sky-300 font-bold text-sm">
                      {String(row.jam_masuk)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">
                      Jam Pulang:
                    </span>
                    <span className="text-sky-300 font-bold text-sm">
                      {String(row.jam_pulang)}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 font-mono text-xs text-slate-400">
                  <div className="flex justify-between border-b border-slate-800/60 pb-1">
                    <span>Toleransi Terlambat:</span>
                    <span className="text-amber-400 font-bold">
                      {Number(row.toleransi_masuk_menit || 0)} Menit
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-slate-800/60 pb-1">
                    <span>Jam Kerja Normal:</span>
                    <span className="text-slate-200">
                      {Number(row.jam_kerja_normal_menit || 480) / 60} Jam
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Waktu Istirahat:</span>
                    <span className="text-slate-200">
                      {Number(row.istirahat_menit || 60)} Menit
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit / Add Shift Modal */}
      {showModal && canManage ? (
        <Modal
          title={isEditing ? "Edit konfigurasi shift" : "Tambah shift baru"}
          titleId="shift-modal-title"
          descriptionId="shift-modal-description"
          onClose={() => setShowModal(false)}
        >
          <p
            id="shift-modal-description"
            className="mb-4 text-xs leading-5 text-slate-400"
          >
            Gunakan format waktu 24 jam dan nilai durasi dalam menit.
          </p>
          {errorMsg ? (
            <FeedbackBanner tone="error" onDismiss={() => setErrorMsg(null)}>
              {errorMsg}
            </FeedbackBanner>
          ) : null}
          <form
            onSubmit={handleFormSubmit}
            className="space-y-4 text-xs font-mono"
          >
            <div>
              <label htmlFor="shift-name" className="text-slate-400 block mb-1">
                Nama Shift:
              </label>
              <input
                id="shift-name"
                type="text"
                value={formData.nama_shift}
                onChange={(e) =>
                  setFormData({ ...formData, nama_shift: e.target.value })
                }
                placeholder="Contoh: Shift 1 - Pagi Normal"
                aria-invalid={!!formErrors.nama_shift}
                className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="shift-start"
                  className="text-slate-400 block mb-1"
                >
                  Jam Masuk:
                </label>
                <input
                  id="shift-start"
                  type="time"
                  value={formData.jam_masuk}
                  onChange={(e) =>
                    setFormData({ ...formData, jam_masuk: e.target.value })
                  }
                  aria-invalid={!!formErrors.jam_masuk}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-end"
                  className="text-slate-400 block mb-1"
                >
                  Jam Pulang:
                </label>
                <input
                  id="shift-end"
                  type="time"
                  value={formData.jam_pulang}
                  onChange={(e) =>
                    setFormData({ ...formData, jam_pulang: e.target.value })
                  }
                  aria-invalid={!!formErrors.jam_pulang}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="shift-tolerance"
                  className="text-slate-400 block mb-1"
                >
                  Toleransi Terlambat:
                </label>
                <input
                  id="shift-tolerance"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.toleransi_masuk_menit}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      toleransi_masuk_menit: Number(e.target.value),
                    })
                  }
                  aria-invalid={!!formErrors.toleransi_masuk_menit}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-duration"
                  className="text-slate-400 block mb-1"
                >
                  Durasi Kerja:
                </label>
                <input
                  id="shift-duration"
                  type="number"
                  min={1}
                  max={1440}
                  value={formData.jam_kerja_normal_menit}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      jam_kerja_normal_menit: Number(e.target.value),
                    })
                  }
                  aria-invalid={!!formErrors.jam_kerja_normal_menit}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl font-semibold hover:bg-slate-700"
              >
                Batal
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-amber-500 text-slate-950 rounded-xl font-bold hover:bg-amber-400 shadow-md shadow-amber-950"
              >
                Simpan Shift
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </AppShell>
  );
}
