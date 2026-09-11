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
import { getDaftarKaryawan } from "@/lib/gateways/employee";
import {
  deletePayrollComponent,
  deleteSalaryConfig,
  getPayrollComponents,
  getSalaryConfigs,
  type PayrollComponentRow,
  type SalaryConfigRow,
  savePayrollComponent,
  saveSalaryConfig,
} from "@/lib/gateways/payroll";
import { syncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export default function PayrollConfigPage() {
  const isHydrated = useHydrated();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [activeTab, setActiveTab] = useState<"salary" | "components">("salary");

  // Salary configs state
  const [salaryConfigs, setSalaryConfigs] = useState<SalaryConfigRow[]>([]);
  const [employees, setEmployees] = useState<Record<string, unknown>[]>([]);
  const [salarySearch, setSalarySearch] = useState("");
  const [loadingSalary, setLoadingSalary] = useState(true);
  const [modalSalaryOpen, setModalSalaryOpen] = useState(false);
  const [draftSalary, setDraftSalary] = useState<Partial<SalaryConfigRow>>({
    id_karyawan: "",
    rate_per_hour: 25000,
    ptkp_status: "TK/0",
    effective_date: new Date().toISOString().slice(0, 10),
  });

  // Components state
  const [components, setComponents] = useState<PayrollComponentRow[]>([]);
  const [loadingComponents, setLoadingComponents] = useState(true);
  const [modalCompOpen, setModalCompOpen] = useState(false);
  const [draftComp, setDraftComp] = useState<Partial<PayrollComponentRow>>({
    name: "",
    category: "ALLOWANCE",
    calc_type: "FIXED",
    default_value: 0,
    applies_to: "ALL",
    is_active: 1,
  });

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadSalaryData = useCallback(async () => {
    setLoadingSalary(true);
    try {
      const [configs, empList] = await Promise.all([
        getSalaryConfigs(salarySearch),
        getDaftarKaryawan(),
      ]);
      setSalaryConfigs(configs);
      setEmployees(empList);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal memuat data rate gaji.",
      });
    } finally {
      setLoadingSalary(false);
    }
  }, [salarySearch]);

  const loadComponentsData = useCallback(async () => {
    setLoadingComponents(true);
    try {
      const data = await getPayrollComponents();
      setComponents(data);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal memuat komponen payroll.",
      });
    } finally {
      setLoadingComponents(false);
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
    void loadSalaryData();
    void loadComponentsData();
  }, [
    isHydrated,
    authLoading,
    isAuthenticated,
    user,
    router,
    loadSalaryData,
    loadComponentsData,
  ]);

  useEffect(() => {
    const handleSync = () => {
      void loadSalaryData();
      void loadComponentsData();
    };
    window.addEventListener("sppg:sync-completed", handleSync);
    return () => window.removeEventListener("sppg:sync-completed", handleSync);
  }, [loadSalaryData, loadComponentsData]);

  const [isSyncing, setIsSyncing] = useState(false);

  const handleReload = async () => {
    setIsSyncing(true);
    try {
      await syncNow();
    } catch {
      // Ignore
    } finally {
      await Promise.all([loadSalaryData(), loadComponentsData()]);
      setIsSyncing(false);
    }
  };

  const handleSaveSalary = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await saveSalaryConfig(draftSalary);
      setModalSalaryOpen(false);
      setFeedback({
        type: "success",
        message: "Rate gaji karyawan berhasil disimpan.",
      });
      await loadSalaryData();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menyimpan rate gaji.",
      });
    }
  };

  const handleDeleteSalary = async (id: string, name: string) => {
    if (!confirm(`Hapus rate gaji untuk "${name}"?`)) return;
    try {
      await deleteSalaryConfig(id);
      setFeedback({
        type: "success",
        message: `Rate gaji untuk "${name}" berhasil dihapus.`,
      });
      await loadSalaryData();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus rate gaji.",
      });
    }
  };

  const handleSaveComponent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await savePayrollComponent(draftComp);
      setModalCompOpen(false);
      setFeedback({
        type: "success",
        message: "Komponen payroll berhasil disimpan.",
      });
      await loadComponentsData();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menyimpan komponen.",
      });
    }
  };

  const handleDeleteComponent = async (id: string) => {
    if (!confirm("Apakah Anda yakin ingin menghapus komponen ini?")) return;
    try {
      await deletePayrollComponent(id);
      setFeedback({ type: "success", message: "Komponen berhasil dihapus." });
      await loadComponentsData();
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error ? err.message : "Gagal menghapus komponen.",
      });
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
          eyebrow="Konfigurasi"
          title="Konfigurasi Penggajian"
          description="Pengaturan rate gaji per jam karyawan, komponen tunjangan/potongan, aturan lembur & pajak."
          actions={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleReload()}
                disabled={isSyncing || loadingSalary || loadingComponents}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700 disabled:opacity-50"
              >
                <Icon
                  name="refresh"
                  className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                />
                {isSyncing ? "Menyinkronkan..." : "Muat Ulang"}
              </button>
              <Link
                href="/payroll"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 transition flex items-center gap-2 border border-slate-700"
              >
                <Icon name="arrow-left" className="w-4 h-4" />
                Kembali ke Dashboard
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

        {/* Sub-modul Navigasi */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link
            href="/payroll/config/overtime-rules"
            className="p-4 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl transition flex items-center justify-between group"
          >
            <div>
              <div className="text-sm font-semibold text-slate-200 group-hover:text-sky-400 transition">
                Jenjang Lembur PP 35/2021
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Pengali Hari Kerja vs Hari Libur
              </div>
            </div>
            <Icon
              name="arrow-right"
              className="w-4 h-4 text-slate-500 group-hover:text-sky-400 transition"
            />
          </Link>
          <Link
            href="/payroll/config/tax-rules"
            className="p-4 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl transition flex items-center justify-between group"
          >
            <div>
              <div className="text-sm font-semibold text-slate-200 group-hover:text-sky-400 transition">
                PPh 21 (TER & Pasal 17)
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Tarif Efektif PMK 168/2023 & UU HPP
              </div>
            </div>
            <Icon
              name="arrow-right"
              className="w-4 h-4 text-slate-500 group-hover:text-sky-400 transition"
            />
          </Link>
          <Link
            href="/payroll/config/bpjs-rules"
            className="p-4 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl transition flex items-center justify-between group"
          >
            <div>
              <div className="text-sm font-semibold text-slate-200 group-hover:text-sky-400 transition">
                Aturan Iuran BPJS
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                JHT, JP, JKK, JKM, BPJS Kesehatan
              </div>
            </div>
            <Icon
              name="arrow-right"
              className="w-4 h-4 text-slate-500 group-hover:text-sky-400 transition"
            />
          </Link>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab("salary")}
            className={`pb-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "salary"
                ? "border-sky-500 text-sky-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Rate Gaji Karyawan ({salaryConfigs.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("components")}
            className={`pb-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "components"
                ? "border-sky-500 text-sky-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Komponen Tunjangan & Potongan ({components.length})
          </button>
        </div>

        {/* Tab Content: Salary */}
        {activeTab === "salary" && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <input
                type="text"
                placeholder="Cari nama karyawan..."
                value={salarySearch}
                onChange={(e) => setSalarySearch(e.target.value)}
                className="px-3 py-1.5 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-200 w-64 focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => {
                  setDraftSalary({
                    id_karyawan: employees[0]?.id_unik
                      ? String(employees[0].id_unik)
                      : "",
                    rate_per_hour: 25000,
                    ptkp_status: "TK/0",
                    effective_date: new Date().toISOString().slice(0, 10),
                  });
                  setModalSalaryOpen(true);
                }}
                className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
                Atur Rate Karyawan
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
                  <tr>
                    <th className="py-3 px-4">Karyawan / ID</th>
                    <th className="py-3 px-4 text-right">Rate / Jam</th>
                    <th className="py-3 px-4 text-center">Status PTKP</th>
                    <th className="py-3 px-4">Tanggal Efektif</th>
                    <th className="py-3 px-4">Diatur Oleh</th>
                    <th className="py-3 px-4 text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {loadingSalary ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-8 text-center text-slate-500"
                      >
                        Memuat data rate gaji...
                      </td>
                    </tr>
                  ) : salaryConfigs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-8 text-center text-slate-500"
                      >
                        Belum ada rate gaji karyawan yang diatur.
                      </td>
                    </tr>
                  ) : (
                    salaryConfigs.map((cfg) => {
                      const emp = employees.find(
                        (e) => String(e.id_unik) === cfg.id_karyawan,
                      );
                      return (
                        <tr
                          key={cfg.id}
                          className="hover:bg-slate-800/40 transition"
                        >
                          <td className="py-3 px-4 font-medium text-slate-200">
                            <div>
                              {emp ? String(emp.nama) : cfg.id_karyawan}
                            </div>
                            <div className="text-xs text-slate-500">
                              {cfg.id_karyawan}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-sky-400">
                            {IDR.format(cfg.rate_per_hour)}
                          </td>
                          <td className="py-3 px-4 text-center font-semibold text-slate-300">
                            <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-xs">
                              {cfg.ptkp_status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-xs font-mono">
                            {cfg.effective_date}
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-xs">
                            {cfg.created_by}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setDraftSalary(cfg);
                                  setModalSalaryOpen(true);
                                }}
                                className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 rounded border border-slate-700 transition"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const name = emp
                                    ? String(emp.nama)
                                    : cfg.id_karyawan;
                                  handleDeleteSalary(cfg.id, name);
                                }}
                                className="px-2 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded border border-rose-800/40 transition"
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
          </div>
        )}

        {/* Tab Content: Components */}
        {activeTab === "components" && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div className="text-xs text-slate-500">
                Komponen tunjangan dan potongan tambahan per periode payroll.
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraftComp({
                    name: "",
                    category: "ALLOWANCE",
                    calc_type: "FIXED",
                    default_value: 0,
                    applies_to: "ALL",
                    is_active: 1,
                  });
                  setModalCompOpen(true);
                }}
                className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
                Tambah Komponen
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/80 text-xs font-semibold uppercase text-slate-400 border-b border-slate-700/60">
                  <tr>
                    <th className="py-3 px-4">Nama Komponen</th>
                    <th className="py-3 px-4 text-center">Kategori</th>
                    <th className="py-3 px-4 text-center">Tipe Kalkulasi</th>
                    <th className="py-3 px-4 text-right">Nilai Default</th>
                    <th className="py-3 px-4">Penerima</th>
                    <th className="py-3 px-4 text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {loadingComponents ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-8 text-center text-slate-500"
                      >
                        Memuat data komponen...
                      </td>
                    </tr>
                  ) : components.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-8 text-center text-slate-500"
                      >
                        Belum ada komponen tunjangan atau potongan.
                      </td>
                    </tr>
                  ) : (
                    components.map((comp) => (
                      <tr
                        key={comp.id}
                        className="hover:bg-slate-800/40 transition"
                      >
                        <td className="py-3 px-4 font-semibold text-slate-200">
                          {comp.name}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                              comp.category === "ALLOWANCE"
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                            }`}
                          >
                            {comp.category === "ALLOWANCE"
                              ? "Tunjangan"
                              : "Potongan"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center text-xs font-mono text-slate-400">
                          {comp.calc_type === "FIXED"
                            ? "Nominal Tetap"
                            : "Persentase Gaji"}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-slate-200">
                          {comp.calc_type === "FIXED"
                            ? IDR.format(comp.default_value)
                            : `${comp.default_value}%`}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400">
                          {comp.applies_to === "ALL"
                            ? "Semua Karyawan"
                            : comp.applies_to}
                        </td>
                        <td className="py-3 px-4 text-center space-x-2">
                          <button
                            type="button"
                            onClick={() => {
                              setDraftComp(comp);
                              setModalCompOpen(true);
                            }}
                            className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 rounded border border-slate-700"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteComponent(comp.id)}
                            className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-rose-400 rounded border border-slate-700"
                          >
                            Hapus
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modal Form Salary Config */}
        {modalSalaryOpen ? (
          <Modal
            title="Atur Rate Gaji Karyawan"
            titleId="modal-salary-config"
            onClose={() => setModalSalaryOpen(false)}
          >
            <form
              onSubmit={handleSaveSalary}
              className="space-y-4 text-sm text-slate-300"
            >
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                  <span>Pilih Karyawan</span>
                  <select
                    value={draftSalary.id_karyawan}
                    onChange={(e) =>
                      setDraftSalary((prev) => ({
                        ...prev,
                        id_karyawan: e.target.value,
                      }))
                    }
                    // Rate unik per (karyawan, tanggal berlaku) dan kedua
                    // backend meng-upsert lewat kunci itu: mengganti salah
                    // satunya pada baris yang sudah ada selalu gagal (bentrok
                    // PK). Rate baru untuk tanggal lain = tambah rate baru.
                    disabled={Boolean(draftSalary.id)}
                    required
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                  >
                    <option value="">-- Pilih Karyawan --</option>
                    {employees.map((emp) => (
                      <option
                        key={String(emp.id_unik)}
                        value={String(emp.id_unik)}
                      >
                        {String(emp.nama)} (
                        {emp.divisi ? String(emp.divisi) : "Divisi -"} |{" "}
                        {String(emp.id_unik)})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                    <span>Rate Gaji Pokok (Rp / Jam)</span>
                    <input
                      type="number"
                      min={0}
                      value={draftSalary.rate_per_hour}
                      onChange={(e) =>
                        setDraftSalary((prev) => ({
                          ...prev,
                          rate_per_hour: Number(e.target.value),
                        }))
                      }
                      required
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono font-normal"
                    />
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                    <span>Status PTKP (Pajak)</span>
                    <select
                      value={draftSalary.ptkp_status}
                      onChange={(e) =>
                        setDraftSalary((prev) => ({
                          ...prev,
                          ptkp_status: e.target.value,
                        }))
                      }
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                    >
                      <option value="TK/0">TK/0 (Lajang 0 Tanggungan)</option>
                      <option value="TK/1">TK/1 (Lajang 1 Tanggungan)</option>
                      <option value="TK/2">TK/2 (Lajang 2 Tanggungan)</option>
                      <option value="TK/3">TK/3 (Lajang 3 Tanggungan)</option>
                      <option value="K/0">K/0 (Kawin 0 Tanggungan)</option>
                      <option value="K/1">K/1 (Kawin 1 Tanggungan)</option>
                      <option value="K/2">K/2 (Kawin 2 Tanggungan)</option>
                      <option value="K/3">K/3 (Kawin 3 Tanggungan)</option>
                    </select>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                  <span>Tanggal Berlaku Efektif</span>
                  <input
                    type="date"
                    value={draftSalary.effective_date}
                    onChange={(e) =>
                      setDraftSalary((prev) => ({
                        ...prev,
                        effective_date: e.target.value,
                      }))
                    }
                    disabled={Boolean(draftSalary.id)}
                    required
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal disabled:opacity-60"
                  />
                </label>
                {draftSalary.id ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Karyawan dan tanggal berlaku dikunci. Untuk tanggal lain,
                    tambahkan rate baru — rate lama tetap tersimpan sebagai
                    riwayat.
                  </p>
                ) : null}
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setModalSalaryOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold"
                >
                  Simpan Rate
                </button>
              </div>
            </form>
          </Modal>
        ) : null}

        {/* Modal Form Component */}
        {modalCompOpen ? (
          <Modal
            title="Pengaturan Komponen Payroll"
            titleId="modal-component-config"
            onClose={() => setModalCompOpen(false)}
          >
            <form
              onSubmit={handleSaveComponent}
              className="space-y-4 text-sm text-slate-300"
            >
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                  <span>Nama Komponen</span>
                  <input
                    type="text"
                    placeholder="Misal: Tunjangan Jabatan, Iuran Koperasi..."
                    value={draftComp.name}
                    onChange={(e) =>
                      setDraftComp((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                    required
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                    <span>Kategori</span>
                    <select
                      value={draftComp.category}
                      onChange={(e) =>
                        setDraftComp((prev) => ({
                          ...prev,
                          category: e.target.value as "ALLOWANCE" | "DEDUCTION",
                        }))
                      }
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                    >
                      <option value="ALLOWANCE">
                        Tunjangan (Penambah Gaji)
                      </option>
                      <option value="DEDUCTION">
                        Potongan (Pengurang Gaji)
                      </option>
                    </select>
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                    <span>Tipe Kalkulasi</span>
                    <select
                      value={draftComp.calc_type}
                      onChange={(e) =>
                        setDraftComp((prev) => ({
                          ...prev,
                          calc_type: e.target.value as "FIXED" | "PERCENTAGE",
                        }))
                      }
                      className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-normal"
                    >
                      <option value="FIXED">Nominal Tetap (Rp)</option>
                      <option value="PERCENTAGE">
                        Persentase (%) Gaji Pokok
                      </option>
                    </select>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">
                  <span>Nilai Nominal / Persentase</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={draftComp.default_value}
                    onChange={(e) =>
                      setDraftComp((prev) => ({
                        ...prev,
                        default_value: Number(e.target.value),
                      }))
                    }
                    required
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500 font-mono font-normal"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setModalCompOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold"
                >
                  Simpan Komponen
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
