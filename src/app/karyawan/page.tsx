"use client";

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { saveFileWithPicker } from "@/lib/client/download";
import {
  downloadEmployeeTemplate,
  exportEmployees,
  readEmployeeWorkbook,
} from "@/lib/client/employee-workbook";
import { createQrPng, employeeQrPayload } from "@/lib/client/qr-code";
import { useAuth } from "@/lib/context/AuthContext";
import {
  generateTokenMassal,
  getDaftarKaryawan,
  importKaryawanMassal,
  type KaryawanInput,
  tambahKaryawan,
  toggleStatusKaryawan,
  updateKaryawan,
} from "@/lib/gateways/employee";
import { getDaftarIdCard } from "@/lib/gateways/id-card";
import { getDaftarShift } from "@/lib/gateways/shift";
import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  createEmployeeIdentifiers,
  firstValidationMessage,
  validateEmployeeDraft,
} from "@/lib/validations/stabilization";

export default function KaryawanPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const canManage = hasPermission(user, "employees.manage");

  const [karyawanList, setKaryawanList] = useState<Record<string, unknown>[]>(
    [],
  );
  const [shiftList, setShiftList] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>("");
  const [appliedSearch, setAppliedSearch] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [qrPreview, setQrPreview] = useState<{
    id: string;
    nama: string;
    png: string;
  } | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);

  // Modal State
  const [showModal, setShowModal] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formData, setFormData] = useState<KaryawanInput>({
    id_unik: "",
    kode_karyawan: "",
    nama: "",
    divisi: "SPPG Operational",
    jabatan_status: "Staff",
    no_hp: "",
    lp: "L",
    id_shift: 1,
    status_aktif: "Aktif",
    catatan: "",
  });
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [data, shifts] = await Promise.all([
        getDaftarKaryawan({
          search: appliedSearch,
          status_aktif: filterStatus || undefined,
        }),
        getDaftarShift(),
      ]);
      setKaryawanList(data);
      setShiftList(shifts);
      setErrorMsg(null);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Data karyawan belum dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, filterStatus]);

  useEffect(() => {
    if (isHydrated && isAuthenticated) {
      loadData();
    }
  }, [isHydrated, isAuthenticated, loadData]);

  const openAddModal = () => {
    setIsEditing(false);
    setEditId(null);
    const identifiers = createEmployeeIdentifiers(crypto.randomUUID());
    setFormData({
      id_unik: identifiers.idUnik,
      kode_karyawan: identifiers.kodeKaryawan,
      nama: "",
      divisi: "SPPG Operational",
      jabatan_status: "Staff",
      no_hp: "",
      lp: "L",
      id_shift: Number(shiftList[0]?.id_shift || 1),
      status_aktif: "Aktif",
      catatan: "",
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const openEditModal = (row: Record<string, unknown>) => {
    setIsEditing(true);
    const id = String(row.id_unik);
    setEditId(id);
    setFormData({
      id_unik: id,
      kode_karyawan: String(row.kode_karyawan || ""),
      nama: String(row.nama || ""),
      divisi: String(row.divisi || "SPPG Operational"),
      jabatan_status: String(row.jabatan_status || "Staff"),
      no_hp: String(row.no_hp || ""),
      lp: (row.lp as "L" | "P") || "L",
      id_shift: Number(row.id_shift || 1),
      status_aktif: (row.status_aktif as "Aktif" | "Nonaktif") || "Aktif",
      catatan: String(row.catatan || ""),
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validateEmployeeDraft(formData);
    if (Object.keys(validationErrors).length > 0) {
      setFormErrors(validationErrors);
      setErrorMsg(firstValidationMessage(validationErrors));
      return;
    }

    try {
      if (isEditing && editId) {
        await updateKaryawan(editId, formData);
        setAlertMsg(`Data karyawan ${formData.nama} berhasil diperbarui.`);
      } else {
        await tambahKaryawan(formData);
        setAlertMsg(`Karyawan baru ${formData.nama} berhasil ditambahkan.`);
      }
      setShowModal(false);
      await loadData();
      setFormErrors({});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menyimpan data.";
      setErrorMsg(msg);
    }
  };

  const handleToggleStatus = async (id_unik: string, currentStatus: string) => {
    const nextStatus = currentStatus === "Aktif" ? "Nonaktif" : "Aktif";
    try {
      await toggleStatusKaryawan(id_unik, nextStatus);
      await loadData();
      setAlertMsg(`Status karyawan berhasil diubah menjadi ${nextStatus}.`);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal mengubah status karyawan.",
      );
    }
  };

  const handleGenerateMassal = async () => {
    try {
      const res = await generateTokenMassal();
      setAlertMsg(
        `Berhasil me-generate ${res.total_generated} token QR karyawan.`,
      );
      await loadData();
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal membuat token QR massal.",
      );
    }
  };

  const handleImport = async (file: File) => {
    setBulkWorking(true);
    try {
      const drafts = await readEmployeeWorkbook(file);
      const result = await importKaryawanMassal(drafts);
      setAlertMsg(
        `Import selesai: ${result.berhasil} berhasil, ${result.dilewati} dilewati karena sudah ada/gagal.`,
      );
      await loadData();
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error ? cause.message : "Import Excel gagal.",
      );
    } finally {
      setBulkWorking(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const res = await downloadEmployeeTemplate();
      if (res.cancelled) return;
      if (res.path) {
        setAlertMsg(`Template Excel berhasil disimpan di: ${res.path}`);
      } else {
        setAlertMsg("Template Excel berhasil diunduh.");
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal mengunduh template Excel.",
      );
    }
  };

  const handleExportEmployees = async () => {
    try {
      const res = await exportEmployees(karyawanList);
      if (res.cancelled) return;
      if (res.path) {
        setAlertMsg(`Data karyawan berhasil diekspor ke: ${res.path}`);
      } else {
        setAlertMsg("Data karyawan berhasil diekspor.");
      }
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal mengekspor data Excel.",
      );
    }
  };

  const handleSaveQrPng = async () => {
    if (!qrPreview) return;
    try {
      const safeNama = qrPreview.nama.replace(/[/\\?%*:|"<>]/g, "-").trim();
      const res = await saveFileWithPicker(
        qrPreview.png,
        `qr-${safeNama || qrPreview.id}.png`,
        {
          description: "Gambar QR Absensi (PNG)",
          accept: { "image/png": [".png"] },
        },
      );
      if (res.cancelled) return;
      if (res.path) {
        setAlertMsg(`QR ${qrPreview.nama} berhasil disimpan di: ${res.path}`);
      } else {
        setAlertMsg(`QR ${qrPreview.nama} berhasil disimpan.`);
      }
      setQrPreview(null);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal menyimpan QR PNG.",
      );
    }
  };

  const handleShowQr = async (row: Record<string, unknown>) => {
    try {
      const cards = await getDaftarIdCard({ search: String(row.id_unik) });
      const card = cards.find(
        (item) => String(item.id_unik) === String(row.id_unik),
      );
      const payload = employeeQrPayload(card ?? {});
      if (!payload) {
        throw new Error(
          "Token QR karyawan belum tersedia. Jalankan Generate QR Token Massal lalu coba lagi.",
        );
      }
      setQrPreview({
        id: String(row.id_unik),
        nama: String(row.nama),
        png: await createQrPng(payload),
      });
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : "QR gagal dibuat.");
    }
  };

  if (!isHydrated || authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100 font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-slate-400 font-mono animate-pulse">
            Memuat Data Karyawan...
          </p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "karyawan")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
      {/* Top Action Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="text-xs uppercase tracking-widest text-sky-400 font-semibold font-mono">
            Master Data Management
          </span>
          <h1 className="text-xl sm:text-2xl font-bold text-white mt-1">
            👥 Manajemen Master Data Karyawan
          </h1>
          <p className="text-xs text-slate-400">
            Kelola profil karyawan, penugasan shift, status aktif, dan QR Code
            absensi.
          </p>
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
              }}
            />
            <button
              type="button"
              disabled={bulkWorking}
              onClick={() => importInputRef.current?.click()}
              className="px-3.5 py-2 bg-slate-800 text-emerald-300 font-semibold text-xs rounded-xl border border-emerald-500/40 disabled:opacity-50"
            >
              {bulkWorking ? "Memproses..." : "Import Excel"}
            </button>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="px-3.5 py-2 bg-slate-800 text-slate-300 font-semibold text-xs rounded-xl border border-slate-700"
            >
              Template
            </button>
            <button
              type="button"
              onClick={handleExportEmployees}
              className="px-3.5 py-2 bg-slate-800 text-sky-300 font-semibold text-xs rounded-xl border border-sky-500/40"
            >
              Export Excel
            </button>

            <button
              type="button"
              onClick={handleGenerateMassal}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold text-xs rounded-xl border border-amber-500/40 transition shadow-sm"
            >
              ⚡ Generate QR Token Massal
            </button>

            <button
              type="button"
              onClick={openAddModal}
              className="px-4 py-2 bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white font-bold text-xs rounded-xl transition shadow-lg shadow-sky-950/60 flex items-center gap-1.5 active:scale-95"
            >
              ➕ Tambah Karyawan Baru
            </button>
          </div>
        ) : null}
      </div>

      {/* Alert Feedback */}
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

      {/* Search & Filter Bar */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedSearch(search.trim());
        }}
        className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-md sm:flex-row"
      >
        <div className="flex w-full gap-2 sm:max-w-md">
          <label htmlFor="employee-search" className="sr-only">
            Cari karyawan
          </label>
          <input
            id="employee-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari Nama, NIK, atau Divisi..."
            className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 text-xs text-white outline-none transition focus:border-sky-500"
          />
          <button
            type="submit"
            className="min-h-11 rounded-xl bg-sky-500 px-4 text-xs font-bold text-slate-950 hover:bg-sky-400"
          >
            Cari
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <label htmlFor="employee-status-filter" className="sr-only">
            Filter status karyawan
          </label>
          <select
            id="employee-status-filter"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 outline-none focus:border-sky-500 sm:w-auto"
          >
            <option value="">Semua Status</option>
            <option value="Aktif">Status: Aktif</option>
            <option value="Nonaktif">Status: Nonaktif</option>
          </select>
        </div>
      </form>

      {/* Employee Table Container */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center space-y-3">
            <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs text-slate-400 font-mono">
              Memuat data karyawan...
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono">
                  <th className="p-4">ID / NIK</th>
                  <th className="p-4">Kode</th>
                  <th className="p-4">Nama Karyawan</th>
                  <th className="p-4">Divisi & Jabatan</th>
                  <th className="p-4">Shift Kerja</th>
                  <th className="p-4">Status QR</th>
                  <th className="p-4">Status</th>
                  <th className="p-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {karyawanList.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-12 text-center text-slate-500">
                      Tidak ada data karyawan yang ditemukan.
                    </td>
                  </tr>
                ) : (
                  karyawanList.map((row) => (
                    <tr
                      key={String(row.id_unik)}
                      className="hover:bg-slate-800/40 transition"
                    >
                      <td className="p-4 text-sky-400 font-bold">
                        {String(row.id_unik)}
                      </td>
                      <td className="p-4 text-slate-300">
                        {String(row.kode_karyawan || "-")}
                      </td>
                      <td className="p-4 text-white font-semibold flex items-center gap-2">
                        <span className="w-5 h-5 bg-slate-800 text-slate-300 rounded-full flex items-center justify-center text-[10px] font-bold">
                          {String(row.lp) === "P" ? "👩" : "👨"}
                        </span>
                        {String(row.nama)}
                      </td>
                      <td className="p-4 text-slate-300">
                        <div>{String(row.divisi)}</div>
                        <div className="text-[10px] text-slate-500">
                          {String(row.jabatan_status || "Staff")}
                        </div>
                      </td>
                      <td className="p-4 text-amber-300 font-semibold">
                        {String(row.nama_shift || "Shift 1 Pagi")}
                      </td>
                      <td className="p-4">
                        <span className="px-2 py-0.5 bg-slate-800 text-slate-300 border border-slate-700 rounded-md text-[10px]">
                          {String(row.status_qr || "Generated")}
                        </span>
                      </td>
                      <td className="p-4">
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() =>
                              handleToggleStatus(
                                String(row.id_unik),
                                String(row.status_aktif),
                              )
                            }
                            className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition ${
                              row.status_aktif === "Aktif"
                                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30"
                                : "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30"
                            }`}
                          >
                            {String(row.status_aktif || "Aktif")}
                          </button>
                        ) : (
                          <span>{String(row.status_aktif || "Aktif")}</span>
                        )}
                      </td>
                      <td className="p-4 text-right">
                        {canManage ? (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => void handleShowQr(row)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 rounded-lg text-xs transition"
                            >
                              Lihat QR
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditModal(row)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 rounded-lg text-xs transition"
                            >
                              Edit
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-500">
                            Lihat saja
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage ? (
        <div className="text-right">
          <Link
            href="/id-cards"
            className="text-xs font-bold text-sky-300 hover:text-sky-200"
          >
            Buka pembuatan dan cetak ID card →
          </Link>
        </div>
      ) : null}

      {qrPreview ? (
        <Modal
          title={`QR ${qrPreview.nama}`}
          titleId="qr-preview-title"
          onClose={() => setQrPreview(null)}
        >
          <div className="flex flex-col items-center gap-4 text-center">
            <Image
              unoptimized
              src={qrPreview.png}
              alt={`QR absensi ${qrPreview.nama}`}
              width={320}
              height={320}
              className="rounded-xl bg-white p-3"
            />
            <p className="font-mono text-xs text-slate-400">{qrPreview.id}</p>
            <button
              type="button"
              onClick={handleSaveQrPng}
              className="rounded-xl bg-sky-400 px-5 py-2 text-xs font-bold text-slate-950"
            >
              Simpan QR sebagai PNG
            </button>
          </div>
        </Modal>
      ) : null}

      {/* Add / Edit Employee Modal */}
      {showModal && canManage ? (
        <Modal
          title={isEditing ? "Edit data karyawan" : "Tambah karyawan baru"}
          titleId="employee-modal-title"
          descriptionId="employee-modal-description"
          onClose={() => setShowModal(false)}
        >
          <p
            id="employee-modal-description"
            className="mb-4 text-xs leading-5 text-slate-400"
          >
            Lengkapi identitas kerja dan shift karyawan. ID yang dibuat otomatis
            dapat disesuaikan sebelum disimpan.
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-id"
                  className="text-slate-400 block mb-1"
                >
                  ID Unik / NIK:
                </label>
                <input
                  id="employee-id"
                  type="text"
                  disabled={isEditing}
                  value={formData.id_unik}
                  onChange={(e) =>
                    setFormData({ ...formData, id_unik: e.target.value })
                  }
                  aria-invalid={!!formErrors.id_unik}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-code"
                  className="text-slate-400 block mb-1"
                >
                  Kode Karyawan:
                </label>
                <input
                  id="employee-code"
                  type="text"
                  value={formData.kode_karyawan}
                  onChange={(e) =>
                    setFormData({ ...formData, kode_karyawan: e.target.value })
                  }
                  aria-invalid={!!formErrors.kode_karyawan}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="employee-name"
                className="text-slate-400 block mb-1"
              >
                Nama Lengkap Karyawan:
              </label>
              <input
                id="employee-name"
                type="text"
                value={formData.nama}
                onChange={(e) =>
                  setFormData({ ...formData, nama: e.target.value })
                }
                placeholder="Masukkan nama lengkap..."
                aria-invalid={!!formErrors.nama}
                className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-division"
                  className="text-slate-400 block mb-1"
                >
                  Divisi:
                </label>
                <input
                  id="employee-division"
                  type="text"
                  value={formData.divisi}
                  onChange={(e) =>
                    setFormData({ ...formData, divisi: e.target.value })
                  }
                  aria-invalid={!!formErrors.divisi}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-position"
                  className="text-slate-400 block mb-1"
                >
                  Jabatan:
                </label>
                <input
                  id="employee-position"
                  type="text"
                  value={formData.jabatan_status}
                  onChange={(e) =>
                    setFormData({ ...formData, jabatan_status: e.target.value })
                  }
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-gender"
                  className="text-slate-400 block mb-1"
                >
                  Jenis Kelamin:
                </label>
                <select
                  id="employee-gender"
                  value={formData.lp}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      lp: e.target.value as "L" | "P",
                    })
                  }
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  <option value="L">Laki-laki (L)</option>
                  <option value="P">Perempuan (P)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="employee-shift"
                  className="text-slate-400 block mb-1"
                >
                  Shift Kerja:
                </label>
                <select
                  id="employee-shift"
                  value={formData.id_shift}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      id_shift: Number(e.target.value),
                    })
                  }
                  aria-invalid={!!formErrors.id_shift}
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  {shiftList.map((s) => (
                    <option key={String(s.id_shift)} value={Number(s.id_shift)}>
                      {String(s.nama_shift)} ({String(s.jam_masuk)} -{" "}
                      {String(s.jam_pulang)})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-phone"
                  className="mb-1 block text-slate-400"
                >
                  Nomor HP:
                </label>
                <input
                  id="employee-phone"
                  type="tel"
                  value={formData.no_hp}
                  onChange={(event) =>
                    setFormData({ ...formData, no_hp: event.target.value })
                  }
                  autoComplete="tel"
                  className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-notes"
                  className="mb-1 block text-slate-400"
                >
                  Catatan:
                </label>
                <textarea
                  id="employee-notes"
                  value={formData.catatan}
                  onChange={(event) =>
                    setFormData({ ...formData, catatan: event.target.value })
                  }
                  rows={2}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
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
                className="px-4 py-2 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-500 shadow-md shadow-sky-950"
              >
                Simpan Data
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </AppShell>
  );
}
