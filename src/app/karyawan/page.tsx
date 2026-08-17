"use client";

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function formatDisplayDate(dateStr: unknown): string {
  if (!dateStr || typeof dateStr !== "string") return "-";
  if (/^\d{2}\/\d{2}\/\d{4}/.test(dateStr)) return dateStr;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return dateStr;
}

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
  const [filterDivisi, setFilterDivisi] = useState<string>("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef<boolean>(false);

  const [qrPreview, setQrPreview] = useState<{
    id: string;
    nama: string;
    png: string;
  } | null>(null);
  const [detailKaryawan, setDetailKaryawan] = useState<Record<
    string,
    unknown
  > | null>(null);
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
    tanggal_daftar: new Date().toLocaleDateString("en-CA"),
    catatan: "",
    jenis_personil: "Pegawai",
    tanggal_mulai_aktif: new Date().toLocaleDateString("en-CA"),
    tanggal_selesai_aktif: "",
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
          divisi: filterDivisi || undefined,
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
  }, [appliedSearch, filterDivisi, filterStatus]);

  useEffect(() => {
    if (isHydrated && isAuthenticated) {
      void loadData();
    }
  }, [isHydrated, isAuthenticated, loadData]);

  // Extract unique divisions for filter — memoized to avoid recalc on every render
  const divisions = useMemo(
    () =>
      Array.from(
        new Set(
          karyawanList
            .map((k) => String(k.divisi || "").trim())
            .filter((d) => d && d !== "-"),
        ),
      ).sort(),
    [karyawanList],
  );

  const openAddModal = () => {
    setIsEditing(false);
    setEditId(null);
    const identifiers = createEmployeeIdentifiers(crypto.randomUUID());
    const todayStr = new Date().toLocaleDateString("en-CA");
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
      tanggal_daftar: todayStr,
      catatan: "",
      jenis_personil: "Pegawai",
      tanggal_mulai_aktif: todayStr,
      tanggal_selesai_aktif: "",
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
      tanggal_daftar: String(row.tanggal_daftar || ""),
      catatan: String(row.catatan || ""),
      jenis_personil: String(row.jenis_personil || "Pegawai"),
      tanggal_mulai_aktif: String(row.tanggal_mulai_aktif || ""),
      tanggal_selesai_aktif: String(row.tanggal_selesai_aktif || ""),
    });
    setFormErrors({});
    setErrorMsg(null);
    setShowModal(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    const validationErrors = validateEmployeeDraft(formData);
    if (Object.keys(validationErrors).length > 0) {
      setFormErrors(validationErrors);
      setErrorMsg(firstValidationMessage(validationErrors));
      return;
    }

    isSubmittingRef.current = true;
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
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleToggleStatus = async (id_unik: string, currentStatus: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    const nextStatus = currentStatus === "Aktif" ? "Nonaktif" : "Aktif";
    try {
      await toggleStatusKaryawan(id_unik, nextStatus);
      await loadData();
      if (detailKaryawan && detailKaryawan.id_unik === id_unik) {
        setDetailKaryawan({ ...detailKaryawan, status_aktif: nextStatus });
      }
      setAlertMsg(`Status karyawan berhasil diubah menjadi ${nextStatus}.`);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Gagal mengubah status karyawan.",
      );
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleGenerateMassal = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
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
    } finally {
      isSubmittingRef.current = false;
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
            Kelola profil lengkap 14 parameter karyawan, shift kerja, status
            keaktifan, dan QR token absensi.
          </p>
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-emerald-300 font-semibold text-xs rounded-xl border border-emerald-500/40 disabled:opacity-50 transition shadow-sm"
            >
              {bulkWorking ? "⏳ Memproses..." : "📥 Import Excel"}
            </button>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs rounded-xl border border-slate-700 transition"
            >
              📄 Template
            </button>
            <button
              type="button"
              onClick={handleExportEmployees}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-sky-300 font-semibold text-xs rounded-xl border border-sky-500/40 transition shadow-sm"
            >
              📊 Export Excel
            </button>

            <button
              type="button"
              onClick={handleGenerateMassal}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold text-xs rounded-xl border border-amber-500/40 transition shadow-sm"
            >
              ⚡ Generate QR Massal
            </button>

            <button
              type="button"
              onClick={openAddModal}
              className="px-4 py-2 bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-500 hover:to-blue-500 text-white font-bold text-xs rounded-xl transition shadow-lg shadow-sky-950/60 flex items-center gap-1.5 active:scale-95"
            >
              ➕ Tambah Karyawan
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
        className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-md sm:flex-row font-mono text-xs"
      >
        <div className="flex w-full gap-2 sm:max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari ID, Kode, Nama, Divisi, Jabatan..."
            className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 text-xs text-white outline-none transition focus:border-sky-500 placeholder:text-slate-600"
          />
          <button
            type="submit"
            className="min-h-10 rounded-xl bg-sky-500 px-4 text-xs font-bold text-slate-950 hover:bg-sky-400"
          >
            Cari
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select
            value={filterDivisi}
            onChange={(e) => setFilterDivisi(e.target.value)}
            className="min-h-10 rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 outline-none focus:border-sky-500"
          >
            <option value="">Semua Divisi</option>
            {divisions.map((div) => (
              <option key={div} value={div}>
                {div}
              </option>
            ))}
          </select>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="min-h-10 rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 outline-none focus:border-sky-500"
          >
            <option value="">Semua Status</option>
            <option value="Aktif">Status: Aktif</option>
            <option value="Nonaktif">Status: Nonaktif</option>
          </select>
        </div>
      </form>

      {/* Main Full 14-Column Table Container */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3 text-xs font-mono text-slate-400 bg-slate-950/40">
          <span>
            Menampilkan {karyawanList.length} karyawan terdaftar (
            {karyawanList.filter((k) => k.status_aktif === "Aktif").length}{" "}
            Aktif)
          </span>
          {appliedSearch ? (
            <span className="text-sky-400">
              Pencarian: &quot;{appliedSearch}&quot;
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center space-y-3">
            <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs text-slate-400 font-mono">
              Memuat data karyawan...
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[65vh]">
            <table className="w-full min-w-[1950px] text-left text-xs font-mono border-collapse">
              <thead className="bg-slate-950 text-slate-400 sticky top-0 z-10 border-b border-slate-800 shadow-md">
                <tr>
                  <th className="p-3.5">ID Unik / NIK</th>
                  <th className="p-3.5">Kode</th>
                  <th className="p-3.5">Nama Karyawan</th>
                  <th className="p-3.5">Divisi</th>
                  <th className="p-3.5">Jabatan</th>
                  <th className="p-3.5">No. HP</th>
                  <th className="p-3.5 text-center">L/P</th>
                  <th className="p-3.5">Shift Kerja</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5">Tgl Daftar</th>
                  <th className="p-3.5">Catatan</th>
                  <th className="p-3.5">Personil</th>
                  <th className="p-3.5">Mulai Aktif</th>
                  <th className="p-3.5">Selesai Aktif</th>
                  <th className="p-3.5">Status QR</th>
                  <th className="p-3.5 text-center sticky top-0 right-0 bg-slate-950 z-30 border-l border-slate-800/80 min-w-[220px]">
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {karyawanList.length === 0 ? (
                  <tr>
                    <td
                      colSpan={16}
                      className="p-12 text-center text-slate-500"
                    >
                      Tidak ada data karyawan yang sesuai dengan filter.
                    </td>
                  </tr>
                ) : (
                  karyawanList.map((row) => (
                    <tr
                      key={String(row.id_unik)}
                      className="hover:bg-slate-800/40 transition"
                    >
                      {/* 1. ID Unik */}
                      <td className="p-3.5 text-sky-400 font-bold whitespace-nowrap">
                        {String(row.id_unik)}
                      </td>
                      {/* 2. Kode Karyawan */}
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.kode_karyawan || "-")}
                      </td>
                      {/* 3. Nama */}
                      <td className="p-3.5 text-white font-bold whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="w-5 h-5 bg-slate-800 text-slate-300 rounded-full flex items-center justify-center text-[10px]">
                            {String(row.lp) === "P" ? "👩" : "👨"}
                          </span>
                          <span>{String(row.nama)}</span>
                        </div>
                      </td>
                      {/* 4. Divisi */}
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.divisi || "-")}
                      </td>
                      {/* 5. Jabatan */}
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {String(row.jabatan_status || "Staff")}
                      </td>
                      {/* 6. No HP */}
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        {String(row.no_hp || "-")}
                      </td>
                      {/* 7. L/P */}
                      <td className="p-3.5 text-center whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            row.lp === "P"
                              ? "bg-fuchsia-950 text-fuchsia-300 border border-fuchsia-800"
                              : "bg-blue-950 text-blue-300 border border-blue-800"
                          }`}
                        >
                          {String(row.lp || "L")}
                        </span>
                      </td>
                      {/* 8. Shift */}
                      <td className="p-3.5 text-amber-300 font-semibold whitespace-nowrap">
                        {String(row.nama_shift || "Shift 1 Pagi")}
                      </td>
                      {/* 9. Status Aktif */}
                      <td className="p-3.5 whitespace-nowrap">
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
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              row.status_aktif === "Aktif"
                                ? "text-emerald-400"
                                : "text-rose-400"
                            }`}
                          >
                            {String(row.status_aktif || "Aktif")}
                          </span>
                        )}
                      </td>
                      {/* 10. Tgl Daftar */}
                      <td className="p-3.5 text-slate-400 whitespace-nowrap">
                        {formatDisplayDate(row.tanggal_daftar)}
                      </td>
                      {/* 11. Catatan */}
                      <td
                        className="p-3.5 text-slate-400 max-w-[160px] truncate"
                        title={String(row.catatan || "")}
                      >
                        {String(row.catatan || "-")}
                      </td>
                      {/* 12. Jenis Personil */}
                      <td className="p-3.5 text-slate-300 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-slate-800 text-slate-300 border border-slate-700 rounded text-[10px]">
                          {String(row.jenis_personil || "Pegawai")}
                        </span>
                      </td>
                      {/* 13. Mulai Aktif */}
                      <td className="p-3.5 text-emerald-400 whitespace-nowrap">
                        {formatDisplayDate(row.tanggal_mulai_aktif)}
                      </td>
                      {/* 14. Selesai Aktif */}
                      <td className="p-3.5 text-amber-400 whitespace-nowrap">
                        {formatDisplayDate(row.tanggal_selesai_aktif)}
                      </td>
                      {/* 15. Status QR */}
                      <td className="p-3.5 whitespace-nowrap">
                        <span className="px-2 py-0.5 bg-slate-800 text-slate-300 border border-slate-700 rounded-md text-[10px]">
                          {String(row.status_qr || "Generated")}
                        </span>
                      </td>
                      {/* 16. Aksi */}
                      <td className="p-3.5 text-center whitespace-nowrap sticky right-0 bg-slate-900/95 z-10 border-l border-slate-800/80 min-w-[220px]">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDetailKaryawan(row)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 rounded-lg text-xs transition flex items-center gap-1"
                          >
                            <span>👁️</span> Detail
                          </button>
                          {canManage ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleShowQr(row)}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 rounded-lg text-xs transition flex items-center gap-1"
                              >
                                <span>🔲</span> QR
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditModal(row)}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 rounded-lg text-xs transition flex items-center gap-1"
                              >
                                <span>✏️</span> Edit
                              </button>
                            </>
                          ) : null}
                        </div>
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

      {/* DETAIL KARYAWAN MODAL */}
      {detailKaryawan ? (
        <Modal
          title={`Profil Lengkap: ${String(detailKaryawan.nama || "")}`}
          titleId="detail-employee-title"
          onClose={() => setDetailKaryawan(null)}
        >
          <div className="space-y-4 text-xs font-mono">
            {/* Profile Header Box */}
            <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-sky-950 border border-sky-800 text-sky-300 text-xl font-bold flex items-center justify-center">
                  {String(detailKaryawan.lp) === "P" ? "👩" : "👨"}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    {String(detailKaryawan.nama || "-")}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    {String(detailKaryawan.divisi || "-")} •{" "}
                    {String(detailKaryawan.jabatan_status || "Staff")}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span
                  className={`px-3 py-1 rounded-full text-[10px] font-bold border ${
                    detailKaryawan.status_aktif === "Aktif"
                      ? "bg-emerald-950 text-emerald-300 border-emerald-800"
                      : "bg-rose-950 text-rose-300 border-rose-800"
                  }`}
                >
                  {String(detailKaryawan.status_aktif || "Aktif")}
                </span>
                <span className="text-[10px] text-slate-500">
                  {String(detailKaryawan.jenis_personil || "Pegawai")}
                </span>
              </div>
            </div>

            {/* 14 Attributes Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  ID Unik / NIK
                </span>
                <span className="text-white font-bold">
                  {String(detailKaryawan.id_unik || "-")}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Kode Karyawan
                </span>
                <span className="text-white font-bold">
                  {String(detailKaryawan.kode_karyawan || "-")}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Nomor HP
                </span>
                <span className="text-white font-bold">
                  {String(detailKaryawan.no_hp || "-")}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Jenis Kelamin
                </span>
                <span className="text-white font-bold">
                  {detailKaryawan.lp === "P" ? "Perempuan" : "Laki-laki"}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Shift Kerja
                </span>
                <span className="text-amber-300 font-bold">
                  {String(detailKaryawan.nama_shift || "Shift 1 Pagi")}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Tanggal Daftar
                </span>
                <span className="text-slate-300 font-bold">
                  {formatDisplayDate(detailKaryawan.tanggal_daftar)}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Mulai Aktif
                </span>
                <span className="text-emerald-400 font-bold">
                  {formatDisplayDate(detailKaryawan.tanggal_mulai_aktif)}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Selesai Aktif
                </span>
                <span className="text-amber-400 font-bold">
                  {formatDisplayDate(detailKaryawan.tanggal_selesai_aktif)}
                </span>
              </div>
              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-[10px] text-slate-500 block uppercase">
                  Status QR Token
                </span>
                <span className="text-sky-300 font-bold">
                  {String(detailKaryawan.status_qr || "Generated")}
                </span>
              </div>
            </div>

            {/* Catatan */}
            <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
              <span className="text-[10px] text-slate-500 block uppercase mb-1">
                Catatan Karyawan
              </span>
              <p className="text-slate-300">
                {String(detailKaryawan.catatan || "Tidak ada catatan khusus.")}
              </p>
            </div>

            {/* Modal Bottom Actions */}
            <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleShowQr(detailKaryawan)}
                  className="px-3 py-1.5 bg-emerald-950 hover:bg-emerald-900 text-emerald-300 rounded-xl font-bold border border-emerald-700/60 flex items-center gap-1.5"
                >
                  <span>🔲</span> Lihat QR
                </button>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => {
                      const row = detailKaryawan;
                      setDetailKaryawan(null);
                      openEditModal(row);
                    }}
                    className="px-3 py-1.5 bg-sky-950 hover:bg-sky-900 text-sky-300 rounded-xl font-bold border border-sky-700/60 flex items-center gap-1.5"
                  >
                    <span>✏️</span> Edit Data
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setDetailKaryawan(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-bold"
              >
                Tutup
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* QR PREVIEW MODAL */}
      {qrPreview ? (
        <Modal
          title={`QR Token Absensi: ${qrPreview.nama}`}
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
              className="rounded-xl bg-white p-3 shadow-2xl"
            />
            <p className="font-mono text-xs text-slate-400 font-bold">
              NIK: {qrPreview.id}
            </p>
            <button
              type="button"
              onClick={handleSaveQrPng}
              className="rounded-xl bg-sky-500 hover:bg-sky-400 px-5 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-sky-950 transition"
            >
              📥 Simpan QR sebagai PNG
            </button>
          </div>
        </Modal>
      ) : null}

      {/* ADD / EDIT EMPLOYEE MODAL (ALL 14 FIELDS) */}
      {showModal && canManage ? (
        <Modal
          title={
            isEditing
              ? `Edit Karyawan: ${formData.nama}`
              : "Tambah Karyawan Baru"
          }
          titleId="employee-modal-title"
          descriptionId="employee-modal-description"
          onClose={() => setShowModal(false)}
        >
          <p
            id="employee-modal-description"
            className="mb-4 text-xs leading-5 text-slate-400"
          >
            Lengkapi 14 parameter identitas kerja, kontak, shift, dan masa aktif
            karyawan.
          </p>
          {errorMsg ? (
            <FeedbackBanner tone="error" onDismiss={() => setErrorMsg(null)}>
              {errorMsg}
            </FeedbackBanner>
          ) : null}
          <form
            onSubmit={handleFormSubmit}
            className="space-y-3.5 text-xs font-mono"
          >
            {/* ID & Kode */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-id"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-code"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Nama Lengkap */}
            <div>
              <label
                htmlFor="employee-name"
                className="text-slate-400 block mb-1 font-semibold"
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
                className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
              />
            </div>

            {/* Divisi & Jabatan */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-division"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-position"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Gender, Shift & Personil */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="employee-gender"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  <option value="L">Laki-laki (L)</option>
                  <option value="P">Perempuan (P)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="employee-shift"
                  className="text-slate-400 block mb-1 font-semibold"
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
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  {shiftList.map((s) => (
                    <option key={String(s.id_shift)} value={Number(s.id_shift)}>
                      {String(s.nama_shift)} ({String(s.jam_masuk)} -{" "}
                      {String(s.jam_pulang)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="employee-personnel"
                  className="text-slate-400 block mb-1 font-semibold"
                >
                  Jenis Personil:
                </label>
                <select
                  id="employee-personnel"
                  value={formData.jenis_personil || "Pegawai"}
                  onChange={(e) =>
                    setFormData({ ...formData, jenis_personil: e.target.value })
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  <option value="Pegawai">Pegawai</option>
                  <option value="Kontrak">Kontrak</option>
                  <option value="Magang">Magang</option>
                  <option value="Harian">Harian</option>
                </select>
              </div>
            </div>

            {/* No HP & Status Aktif */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-phone"
                  className="mb-1 block text-slate-400 font-semibold"
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
                  placeholder="08xxxxxxxxxx"
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-status"
                  className="mb-1 block text-slate-400 font-semibold"
                >
                  Status Keaktifan:
                </label>
                <select
                  id="employee-status"
                  value={formData.status_aktif || "Aktif"}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      status_aktif: e.target.value as "Aktif" | "Nonaktif",
                    })
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                >
                  <option value="Aktif">Aktif</option>
                  <option value="Nonaktif">Nonaktif</option>
                </select>
              </div>
            </div>

            {/* Tanggal Mulai & Selesai Aktif */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="employee-start-date"
                  className="mb-1 block text-slate-400 font-semibold"
                >
                  Tanggal Mulai Aktif:
                </label>
                <input
                  id="employee-start-date"
                  type="date"
                  value={formData.tanggal_mulai_aktif || ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tanggal_mulai_aktif: e.target.value,
                    })
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="employee-end-date"
                  className="mb-1 block text-slate-400 font-semibold"
                >
                  Tanggal Selesai Aktif (Opsional):
                </label>
                <input
                  id="employee-end-date"
                  type="date"
                  value={formData.tanggal_selesai_aktif || ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tanggal_selesai_aktif: e.target.value,
                    })
                  }
                  className="min-h-10 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-white outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Catatan */}
            <div>
              <label
                htmlFor="employee-notes"
                className="mb-1 block text-slate-400 font-semibold"
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
                placeholder="Catatan tambahan karyawan..."
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
              />
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
                className="px-5 py-2 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-500 shadow-md shadow-sky-950 transition"
              >
                {isEditing ? "Simpan Perubahan" : "Tambah Karyawan"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </AppShell>
  );
}
