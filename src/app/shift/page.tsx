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
  hapusShift,
  type ShiftInput,
  tambahShift,
  updateShift,
} from "@/lib/gateways/shift";
import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  firstValidationMessage,
  validateShiftDraft,
} from "@/lib/validations/stabilization";

function parseTimeToMinutes(t: string): number | null {
  if (!t) return null;
  const match = /^(\d{2}):(\d{2})/.exec(t.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Kalkulasi jam kerja normal dalam satuan MENIT sesuai rumus code-sheet/13.1_Helper_Tambahan.txt
 * Rumus: (jamPulang - jamMasuk) - istirahat + batasMasuk
 */
function hitungJamKerjaNormalOtomatis(
  jamMasuk: string,
  jamPulang: string,
  istirahatMenit: number,
  batasMasukMenit: number,
): number {
  const mMasuk = parseTimeToMinutes(jamMasuk);
  let mPulang = parseTimeToMinutes(jamPulang);

  if (mMasuk === null || mPulang === null) return 0;

  // Penanganan shift malam (jam pulang lebih kecil dari jam masuk)
  if (mPulang < mMasuk) {
    mPulang += 1440;
  }

  const total =
    mPulang -
    mMasuk -
    Number(istirahatMenit || 0) +
    Number(batasMasukMenit || 0);
  return total > 0 ? total : 0;
}

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
    awal_absen_menit: 120,
    batas_masuk_menit: 60,
    toleransi_masuk_menit: 0,
    jam_kerja_normal_menit: 480,
    istirahat_menit: 60,
    batas_pulang_menit: 240,
    offset_istirahat_mulai: 240,
    offset_generate_alfa: 180,
    buffer_shift_malam_menit: 120,
  });
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Delete Confirmation State
  const [deleteConfirmShift, setDeleteConfirmShift] = useState<{
    id: number;
    nama: string;
    kode: number;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

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

  // Recalculate work hours automatically on form change
  const updateFormField = <K extends keyof ShiftInput>(
    field: K,
    value: ShiftInput[K],
  ) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (
        field === "jam_masuk" ||
        field === "jam_pulang" ||
        field === "istirahat_menit" ||
        field === "batas_masuk_menit"
      ) {
        next.jam_kerja_normal_menit = hitungJamKerjaNormalOtomatis(
          next.jam_masuk,
          next.jam_pulang,
          next.istirahat_menit ?? 60,
          next.batas_masuk_menit ?? 60,
        );
      }
      return next;
    });
  };

  const openAddModal = () => {
    setIsEditing(false);
    setEditId(null);
    const usedCodes = new Set(
      shiftList.map((shift) => Number(shift.kode_shift)),
    );
    let nextKode = 1;
    while (usedCodes.has(nextKode)) nextKode += 1;

    const defaultMasuk = "07:00";
    const defaultPulang = "15:00";
    const defaultIstirahat = 60;
    const defaultBatasMasuk = 60;
    const defaultAwalAbsen = 120;
    const calcNormalWork = hitungJamKerjaNormalOtomatis(
      defaultMasuk,
      defaultPulang,
      defaultIstirahat,
      defaultBatasMasuk,
    );

    setFormData({
      kode_shift: nextKode,
      nama_shift: `Shift ${nextKode} - Regular`,
      jam_masuk: defaultMasuk,
      jam_pulang: defaultPulang,
      awal_absen_menit: defaultAwalAbsen,
      batas_masuk_menit: defaultBatasMasuk,
      toleransi_masuk_menit: 0,
      jam_kerja_normal_menit: calcNormalWork,
      istirahat_menit: defaultIstirahat,
      batas_pulang_menit: 240,
      offset_istirahat_mulai: 240,
      offset_generate_alfa: 180,
      buffer_shift_malam_menit: 120,
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (row: Record<string, unknown>) => {
    setIsEditing(true);
    const id = Number(row.id_shift);
    setEditId(id);

    const masuk = String(row.jam_masuk || "07:00");
    const pulang = String(row.jam_pulang || "15:00");
    const istirahat = Number(row.istirahat_menit ?? 60);
    const batasMasuk = Number(row.batas_masuk_menit ?? 60);
    const awalAbsen = Number(row.awal_absen_menit ?? 120);

    setFormData({
      kode_shift: Number(row.kode_shift || 1),
      nama_shift: String(row.nama_shift || ""),
      jam_masuk: masuk,
      jam_pulang: pulang,
      awal_absen_menit: awalAbsen,
      batas_masuk_menit: batasMasuk,
      toleransi_masuk_menit: Number(row.toleransi_masuk_menit || 0),
      jam_kerja_normal_menit: hitungJamKerjaNormalOtomatis(
        masuk,
        pulang,
        istirahat,
        batasMasuk,
      ),
      istirahat_menit: istirahat,
      batas_pulang_menit: Number(row.batas_pulang_menit ?? 240),
      offset_istirahat_mulai: Number(row.offset_istirahat_mulai ?? 240),
      offset_generate_alfa: Number(row.offset_generate_alfa ?? 180),
      buffer_shift_malam_menit: Number(row.buffer_shift_malam_menit ?? 120),
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

  const handleDeleteShift = async () => {
    if (!deleteConfirmShift) return;
    setIsDeleting(true);
    setErrorMsg(null);
    try {
      const res = await hapusShift(deleteConfirmShift.id);
      if (res.sukses) {
        setAlertMsg(`Shift ${deleteConfirmShift.nama} berhasil dihapus.`);
        setDeleteConfirmShift(null);
        if (showModal && editId === deleteConfirmShift.id) {
          setShowModal(false);
        }
        await loadShifts();
      } else {
        setErrorMsg(res.pesan || "Gagal menghapus shift.");
        setDeleteConfirmShift(null);
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal menghapus shift.",
      );
      setDeleteConfirmShift(null);
    } finally {
      setIsDeleting(false);
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
            Shift Configuration & Dynamic Rules
          </span>
          <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
            🕒 Pengaturan Shift & Toleransi Jam Absensi
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Konfigurasi jam masuk, pulang, jendela awal absen, batas toleransi,
            jam kerja normal otomatis, istirahat, dan shift malam.
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={openAddModal}
            className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-bold text-xs rounded-xl transition shadow-lg shadow-amber-950/60 flex items-center gap-2 active:scale-95"
          >
            <span>+</span> Tambah Shift Baru
          </button>
        ) : null}
      </div>

      {/* Feedback Alert */}
      {alertMsg ? (
        <FeedbackBanner tone="success" onDismiss={() => setAlertMsg(null)}>
          {alertMsg}
        </FeedbackBanner>
      ) : null}
      {errorMsg && !showModal && !deleteConfirmShift ? (
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
        <div className="app-panel rounded-3xl px-6 py-16 text-center border border-slate-800 bg-slate-900/50">
          <p className="text-base font-bold text-white">Belum ada shift</p>
          <p className="mt-2 text-sm text-slate-400">
            Tambahkan shift pertama untuk mulai mengatur jadwal kerja karyawan.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {shiftList.map((row) => {
            const isNight =
              String(row.jam_pulang || "") < String(row.jam_masuk || "");
            const normalMinutes = Number(row.jam_kerja_normal_menit || 0);
            const normalHours = (normalMinutes / 60)
              .toFixed(1)
              .replace(/\.0$/, "");

            return (
              <div
                key={String(row.id_shift)}
                className="bg-slate-900/90 border border-slate-800 hover:border-amber-500/50 rounded-3xl p-5 space-y-4 shadow-xl transition flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-xs font-mono font-bold">
                        Kode #{String(row.kode_shift)}
                      </span>
                      {isNight ? (
                        <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 rounded-full text-[10px] font-mono">
                          🌙 Shift Malam
                        </span>
                      ) : null}
                    </div>
                    {canManage ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditModal(row)}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded-lg text-xs font-mono border border-slate-700 transition"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteConfirmShift({
                              id: Number(row.id_shift),
                              nama: String(row.nama_shift || ""),
                              kode: Number(row.kode_shift || 0),
                            })
                          }
                          className="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 rounded-lg text-xs font-mono border border-rose-500/30 transition"
                        >
                          Hapus
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <h3 className="text-base font-bold text-white">
                    {String(row.nama_shift)}
                  </h3>

                  {/* Jam Masuk & Pulang Box */}
                  <div className="grid grid-cols-2 gap-3 p-3 bg-slate-950 border border-slate-800 rounded-2xl font-mono text-xs">
                    <div>
                      <span className="text-[10px] text-slate-500 block uppercase">
                        Jam Masuk
                      </span>
                      <span className="text-sky-300 font-bold text-base">
                        {String(row.jam_masuk)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block uppercase">
                        Jam Pulang
                      </span>
                      <span className="text-amber-400 font-bold text-base">
                        {String(row.jam_pulang)}
                      </span>
                    </div>
                  </div>

                  {/* Detail Parameters List */}
                  <div className="space-y-1.5 font-mono text-xs text-slate-400 pt-1">
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Awal Absen Dibuka:</span>
                      <span className="text-slate-200 font-semibold">
                        {Number(row.awal_absen_menit ?? 120)} mnt sblm
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Batas Masuk Tepat Waktu:</span>
                      <span className="text-emerald-400 font-semibold">
                        +{Number(row.batas_masuk_menit ?? 60)} menit
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Toleransi Terlambat:</span>
                      <span className="text-amber-400 font-semibold">
                        +{Number(row.toleransi_masuk_menit ?? 0)} menit
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Jam Kerja Normal:</span>
                      <span className="text-sky-300 font-bold">
                        {normalMinutes} mnt ({normalHours} Jam)
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Istirahat:</span>
                      <span className="text-slate-300">
                        {Number(row.istirahat_menit ?? 60)} menit
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Batas Pulang:</span>
                      <span className="text-slate-300">
                        +{Number(row.batas_pulang_menit ?? 240)} menit
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Offset Potong Istirahat:</span>
                      <span className="text-slate-300">
                        {Number(row.offset_istirahat_mulai ?? 240)} menit
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                      <span>Offset Generate Alfa:</span>
                      <span className="text-rose-300">
                        {Number(row.offset_generate_alfa ?? 180)} menit
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Buffer Shift Malam:</span>
                      <span className="text-indigo-300">
                        {Number(row.buffer_shift_malam_menit ?? 120)} menit
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Add Shift Modal */}
      {showModal && canManage ? (
        <Modal
          title={isEditing ? "Edit Konfigurasi Shift" : "Tambah Shift Baru"}
          titleId="shift-modal-title"
          descriptionId="shift-modal-description"
          onClose={() => setShowModal(false)}
        >
          <p
            id="shift-modal-description"
            className="mb-4 text-xs leading-5 text-slate-400"
          >
            Atur parameter shift kerja. Durasi jam kerja normal dihitung
            otomatis berdasarkan jam masuk, jam pulang, istirahat, dan batas
            masuk.
          </p>
          {errorMsg ? (
            <FeedbackBanner tone="error" onDismiss={() => setErrorMsg(null)}>
              {errorMsg}
            </FeedbackBanner>
          ) : null}
          <form
            onSubmit={handleFormSubmit}
            className="space-y-4 text-xs font-mono max-h-[70vh] overflow-y-auto pr-1"
          >
            {/* Nama Shift & Kode */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="shift-code"
                  className="text-slate-400 block mb-1"
                >
                  Kode Shift:
                </label>
                <input
                  id="shift-code"
                  type="number"
                  min={1}
                  disabled={isEditing}
                  value={formData.kode_shift}
                  onChange={(e) =>
                    updateFormField("kode_shift", Number(e.target.value))
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500 disabled:opacity-50"
                />
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="shift-name"
                  className="text-slate-400 block mb-1"
                >
                  Nama Shift:
                </label>
                <input
                  id="shift-name"
                  type="text"
                  value={formData.nama_shift}
                  onChange={(e) =>
                    updateFormField("nama_shift", e.target.value)
                  }
                  placeholder="Contoh: Shift 1 - Pagi Normal"
                  aria-invalid={!!formErrors.nama_shift}
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {/* Jam Masuk & Jam Pulang */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-slate-950/60 rounded-2xl border border-slate-800">
              <div>
                <label
                  htmlFor="shift-start"
                  className="text-slate-400 block mb-1 font-bold text-sky-400"
                >
                  Jam Masuk (HH:mm):
                </label>
                <input
                  id="shift-start"
                  type="time"
                  value={formData.jam_masuk}
                  onChange={(e) => updateFormField("jam_masuk", e.target.value)}
                  aria-invalid={!!formErrors.jam_masuk}
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-end"
                  className="text-slate-400 block mb-1 font-bold text-amber-400"
                >
                  Jam Pulang (HH:mm):
                </label>
                <input
                  id="shift-end"
                  type="time"
                  value={formData.jam_pulang}
                  onChange={(e) =>
                    updateFormField("jam_pulang", e.target.value)
                  }
                  aria-invalid={!!formErrors.jam_pulang}
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {/* Awal Absen & Batas Masuk */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="shift-early-window"
                  className="text-slate-400 block mb-1"
                >
                  Awal Absen Masuk (Menit sebelum):
                </label>
                <input
                  id="shift-early-window"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.awal_absen_menit ?? 120}
                  onChange={(e) =>
                    updateFormField("awal_absen_menit", Number(e.target.value))
                  }
                  placeholder="120"
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
                <span className="text-[10px] text-slate-500">
                  Waktu scan mulai diterima sebelum jam masuk (Otomatis: 120
                  mnt).
                </span>
              </div>
              <div>
                <label
                  htmlFor="shift-ontime-window"
                  className="text-slate-400 block mb-1"
                >
                  Batas Masuk Tepat Waktu (Menit):
                </label>
                <input
                  id="shift-ontime-window"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.batas_masuk_menit ?? 60}
                  onChange={(e) =>
                    updateFormField("batas_masuk_menit", Number(e.target.value))
                  }
                  placeholder="60"
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
                <span className="text-[10px] text-slate-500">
                  Jendela hadir tepat waktu setelah jam masuk (Otomatis: 60
                  mnt).
                </span>
              </div>
            </div>

            {/* Toleransi Masuk & Istirahat */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="shift-tolerance"
                  className="text-slate-400 block mb-1"
                >
                  Toleransi Keterlambatan (Menit):
                </label>
                <input
                  id="shift-tolerance"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.toleransi_masuk_menit ?? 0}
                  onChange={(e) =>
                    updateFormField(
                      "toleransi_masuk_menit",
                      Number(e.target.value),
                    )
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
                <span className="text-[10px] text-slate-500">
                  Toleransi scan masuk terlambat sebelum ditolak.
                </span>
              </div>
              <div>
                <label
                  htmlFor="shift-break"
                  className="text-slate-400 block mb-1"
                >
                  Waktu Istirahat (Menit):
                </label>
                <input
                  id="shift-break"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.istirahat_menit ?? 60}
                  onChange={(e) =>
                    updateFormField("istirahat_menit", Number(e.target.value))
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
                <span className="text-[10px] text-slate-500">
                  Durasi potongan istirahat (Otomatis: 60 mnt).
                </span>
              </div>
            </div>

            {/* Jam Kerja Normal (Kalkulasi Otomatis - Terkunci) */}
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl">
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="shift-duration"
                  className="text-amber-300 font-bold flex items-center gap-1.5"
                >
                  <span>🔒</span>
                  <span>Jam Kerja Normal (Otomatis & Terkunci):</span>
                </label>
                <span className="text-xs font-bold text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-lg border border-amber-500/30 font-mono">
                  {(Number(formData.jam_kerja_normal_menit || 0) / 60)
                    .toFixed(1)
                    .replace(/\.0$/, "")}{" "}
                  Jam
                </span>
              </div>
              <input
                id="shift-duration"
                type="number"
                readOnly
                disabled
                value={formData.jam_kerja_normal_menit ?? 480}
                aria-invalid={!!formErrors.jam_kerja_normal_menit}
                className="min-h-10 w-full rounded-xl border border-amber-500/40 bg-slate-900/80 px-3 text-amber-200 outline-none font-bold cursor-not-allowed select-none opacity-90"
              />
              <span className="text-[10px] text-amber-200/80 block mt-1.5">
                Nilai otomatis terkunci dihitung dari: (Jam Pulang - Jam Masuk)
                - Istirahat + Batas Masuk ={" "}
                <strong className="text-amber-300 font-bold">
                  {formData.jam_kerja_normal_menit}
                </strong>{" "}
                menit.
              </span>
            </div>

            {/* Batas Pulang, Offset Istirahat, Offset Alfa, Buffer Malam */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label
                  htmlFor="shift-checkout-limit"
                  className="text-slate-400 block mb-1"
                >
                  Batas Pulang (Menit):
                </label>
                <input
                  id="shift-checkout-limit"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.batas_pulang_menit ?? 240}
                  onChange={(e) =>
                    updateFormField(
                      "batas_pulang_menit",
                      Number(e.target.value),
                    )
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-break-offset"
                  className="text-slate-400 block mb-1"
                >
                  Offset Potong Istirahat (Menit):
                </label>
                <input
                  id="shift-break-offset"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.offset_istirahat_mulai ?? 240}
                  onChange={(e) =>
                    updateFormField(
                      "offset_istirahat_mulai",
                      Number(e.target.value),
                    )
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-alfa-offset"
                  className="text-slate-400 block mb-1"
                >
                  Offset Generate Alfa (Menit):
                </label>
                <input
                  id="shift-alfa-offset"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.offset_generate_alfa ?? 180}
                  onChange={(e) =>
                    updateFormField(
                      "offset_generate_alfa",
                      Number(e.target.value),
                    )
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label
                  htmlFor="shift-night-buffer"
                  className="text-slate-400 block mb-1"
                >
                  Buffer Shift Malam (Menit):
                </label>
                <input
                  id="shift-night-buffer"
                  type="number"
                  min={0}
                  max={1440}
                  value={formData.buffer_shift_malam_menit ?? 120}
                  onChange={(e) =>
                    updateFormField(
                      "buffer_shift_malam_menit",
                      Number(e.target.value),
                    )
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>

            {/* Modal Action Buttons */}
            <div className="pt-4 border-t border-slate-800 flex items-center justify-between gap-2">
              {isEditing && editId ? (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteConfirmShift({
                      id: editId,
                      nama: formData.nama_shift,
                      kode: formData.kode_shift,
                    });
                  }}
                  className="px-3.5 py-2 bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
                >
                  <span>🗑</span>
                  <span>Hapus Shift</span>
                </button>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl font-semibold hover:bg-slate-700"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-amber-500 text-slate-950 rounded-xl font-bold hover:bg-amber-400 shadow-md shadow-amber-950"
                >
                  Simpan Shift
                </button>
              </div>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* Delete Confirmation Modal */}
      {deleteConfirmShift && canManage ? (
        <Modal
          title="Konfirmasi Hapus Shift"
          titleId="delete-shift-modal-title"
          descriptionId="delete-shift-modal-description"
          onClose={() => !isDeleting && setDeleteConfirmShift(null)}
        >
          <div className="space-y-4 text-xs font-mono">
            <div className="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-2xl text-rose-200 space-y-2">
              <p className="font-bold text-sm text-rose-300 flex items-center gap-2">
                <span>⚠️</span> Hapus Shift {deleteConfirmShift.nama}?
              </p>
              <p className="text-xs text-rose-200/90 leading-relaxed font-sans">
                Anda akan menghapus konfigurasi{" "}
                <strong>
                  Shift #{deleteConfirmShift.kode} - {deleteConfirmShift.nama}
                </strong>
                . Shift yang sedang terikat pada data karyawan aktif tidak dapat
                dihapus demi menjaga integritas data absensi.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setDeleteConfirmShift(null)}
                className="px-4 py-2.5 bg-slate-800 text-slate-300 rounded-xl font-semibold hover:bg-slate-700 disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={handleDeleteShift}
                className="px-5 py-2.5 bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold rounded-xl shadow-lg shadow-rose-950 transition flex items-center gap-2 disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    Menghapus...
                  </>
                ) : (
                  "Ya, Hapus Shift"
                )}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}
