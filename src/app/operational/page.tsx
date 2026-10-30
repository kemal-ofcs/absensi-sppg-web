"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  BATAS_IMPORT_MASSAL,
  BATAS_KOREKSI_MASSAL,
  jalankanBerurutan,
  ringkasHasil,
} from "@/components/operational/aturanPilihPersonil";
import { PilihPersonil } from "@/components/operational/PilihPersonil";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { konfirmasiData } from "@/components/ui/KonfirmasiData";
import { PageHeader } from "@/components/ui/PageHeader";
import { PilihCari } from "@/components/ui/PilihCari";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { parseCsv } from "@/lib/client/xlsx";
import { useAuth } from "@/lib/context/AuthContext";
import {
  batalkanPenugasanBackup,
  buatPenugasanBackup,
  getDaftarBackup,
  hapusPenugasanBackup,
} from "@/lib/gateways/backup";
import {
  getDaftarKoreksi,
  hapusKoreksiAdmin,
  prosesKoreksiAdmin,
} from "@/lib/gateways/correction";
import { getDaftarKaryawan } from "@/lib/gateways/employee";
import {
  getDaftarImport,
  hapusImportOffline,
  type OfflineImportRow,
  prosesImportOffline,
} from "@/lib/gateways/offline-import";
import { getDaftarShift } from "@/lib/gateways/shift";
import { syncNow } from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { tanggalTampil } from "@/lib/validations/tutup-buku";

type Tab = "correction" | "backup" | "import";

const inputClass =
  "min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none focus:border-sky-400";

export default function OperationalPage() {
  const hydrated = useHydrated();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [tab, setTab] = useState<Tab>("correction");
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const [employees, setEmployees] = useState<Record<string, unknown>[]>([]);
  const [shifts, setShifts] = useState<Record<string, unknown>[]>([]);
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const [confirmKoreksi, setConfirmKoreksi] = useState<{
    ids: string[];
    sudahAda: string[];
  } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    type?: "correction" | "import" | "backup";
    idReferensi: string;
    title: string;
    subtitle: string;
  } | null>(null);

  const handleDeleteConfirmed = async () => {
    if (!deleteConfirm || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      if (deleteConfirm.type === "import") {
        const result = await hapusImportOffline(deleteConfirm.idReferensi);
        setFeedback({
          tone: result.sukses ? "success" : "error",
          text: result.pesan,
        });
      } else if (deleteConfirm.type === "backup") {
        const result = await hapusPenugasanBackup(deleteConfirm.idReferensi);
        setFeedback({
          tone: result.sukses ? "success" : "error",
          text: result.pesan,
        });
      } else {
        const result = await hapusKoreksiAdmin(deleteConfirm.idReferensi);
        setFeedback({
          tone: result.sukses ? "success" : "error",
          text: result.pesan,
        });
      }
      setDeleteConfirm(null);
      await load(deleteConfirm.type || "correction", false, false);
    } catch (err: unknown) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error ? err.message : "Gagal menghapus data riwayat.",
      });
    } finally {
      setBusy(false);
      isSubmittingRef.current = false;
    }
  };

  // Form State: Koreksi Admin
  const [correction, setCorrection] = useState({
    tanggal: new Date().toLocaleDateString("en-CA"),
    idPersonil: [] as string[],
    // 0 = backend memakai shift masing-masing karyawan (atau shift backup-nya).
    id_shift: 0,
    jenis_koreksi: "Izin",
    jam_koreksi: "",
    keterangan_admin: "",
  });

  // Form State: Backup Karyawan
  const [backup, setBackup] = useState({
    tanggal_tugas: new Date().toLocaleDateString("en-CA"),
    id_karyawan_asal: "",
    nama_karyawan_asal: "",
    divisi_asal: "",
    id_karyawan_pengganti: "",
    nama_karyawan_pengganti: "",
    divisi_pengganti: "",
    id_shift_backup: 1,
    alasan_backup: "Penggantian Shift",
    catatan: "",
  });

  // Form State: Import Manual (Per-Kolom)
  const [manualEntry, setManualEntry] = useState({
    tanggal: new Date().toLocaleDateString("en-CA"),
    idPersonil: [] as string[],
    jam_masuk: "07:00",
    jam_pulang: "15:00",
    status_kehadiran: "Hadir",
    status_absen: "",
    keterangan: "Import Manual",
  });

  // Bulk CSV import state
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [csv, setCsv] = useState(
    "tanggal,id_unik,jam_masuk,jam_pulang,status_kehadiran,keterangan\n",
  );

  const run = useCallback(async (task: () => Promise<void>) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await task();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Operasi gagal.",
      });
    } finally {
      setBusy(false);
      isSubmittingRef.current = false;
    }
  }, []);

  // Nomor urut muat terakhir. Pindah tab atau tanggal saat request lama belum
  // selesai membuat respons lama bisa tiba belakangan dan menimpa data yang
  // sedang dilihat; hanya respons dari muat terbaru yang boleh diterapkan.
  const loadSeqRef = useRef(0);
  const load = useCallback(
    async (
      currentTab: Tab = tab,
      synchronize = false,
      showFeedback = false,
    ) => {
      try {
        const seq = ++loadSeqRef.current;
        if (synchronize) {
          await syncNow().catch(() => undefined);
        }
        const [data, shiftList] = await Promise.all([
          currentTab === "backup"
            ? getDaftarBackup()
            : currentTab === "import"
              ? getDaftarImport()
              : getDaftarKoreksi(),
          getDaftarShift().catch(() => []),
        ]);
        if (seq !== loadSeqRef.current) return;
        setRecords(data);
        if (Array.isArray(shiftList) && shiftList.length > 0) {
          setShifts(shiftList);
        }
        if (showFeedback) {
          setFeedback({
            tone: "success",
            text: `${data.length} data berhasil dimuat.`,
          });
        }
      } catch (error) {
        if (showFeedback) {
          setFeedback({
            tone: "error",
            text: error instanceof Error ? error.message : "Gagal memuat data.",
          });
        }
      }
    },
    [tab],
  );

  // Load employee list for auto-fill dropdowns and active records
  useEffect(() => {
    if (hydrated && isAuthenticated) {
      void getDaftarKaryawan({ status_aktif: "Aktif" })
        .then((data) => setEmployees(data))
        .catch(() => undefined);
      void load(tab, false, false);
    }
  }, [hydrated, isAuthenticated, tab, load]);

  // Area ini terbuka bagi pemegang `backups.view` saja; tanpa ini mereka
  // mendarat di tab Koreksi yang selalu ditolak 403 tanpa pesan.
  useEffect(() => {
    if (
      user &&
      !hasPermission(user, "corrections.view") &&
      hasPermission(user, "backups.view")
    ) {
      setTab("backup");
    }
  }, [user]);

  useEffect(() => {
    const onSyncCompleted = () => {
      void load(tab, false, false);
    };
    window.addEventListener("sppg:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("sppg:sync-completed", onSyncCompleted);
    };
  }, [tab, load]);

  const cariKaryawan = (idKaryawan: string) =>
    employees.find((row) => String(row.id_unik) === idKaryawan);
  const namaKaryawan = (idKaryawan: string) =>
    String(cariKaryawan(idKaryawan)?.nama || idKaryawan);

  const shiftOptions =
    shifts.length > 0 ? (
      shifts.map((s) => (
        <option key={String(s.id_shift)} value={Number(s.id_shift)}>
          {String(s.nama_shift)} ({String(s.jam_masuk)} - {String(s.jam_pulang)}
          )
        </option>
      ))
    ) : (
      // Daftar palsu Shift 1/2/3 dulu membuat penugasan merujuk shift yang
      // mungkin tidak ada; backend kini menolaknya, jadi cukup beri tahu.
      <option value={0} disabled>
        Daftar shift tidak dapat dimuat
      </option>
    );

  const handleSelectBackupAsal = (ids: string[]) => {
    const found = ids[0] ? cariKaryawan(ids[0]) : undefined;
    setBackup((prev) => ({
      ...prev,
      id_karyawan_asal: ids[0] ?? "",
      nama_karyawan_asal: String(found?.nama || ""),
      divisi_asal: String(found?.divisi || ""),
      id_shift_backup: found
        ? Number(found.id_shift || 1)
        : prev.id_shift_backup,
    }));
  };

  const handleSelectBackupPengganti = (ids: string[]) => {
    const found = ids[0] ? cariKaryawan(ids[0]) : undefined;
    setBackup((prev) => ({
      ...prev,
      id_karyawan_pengganti: ids[0] ?? "",
      nama_karyawan_pengganti: String(found?.nama || ""),
      divisi_pengganti: String(found?.divisi || ""),
    }));
  };

  const executeCorrection = (ids: string[]) =>
    run(async () => {
      if (ids.length === 0) {
        throw new Error("Pilih minimal satu karyawan terlebih dahulu.");
      }
      const hasil = await jalankanBerurutan(ids, (idKaryawan) =>
        prosesKoreksiAdmin({
          tanggal: correction.tanggal,
          id_karyawan: idKaryawan,
          jenis_koreksi: correction.jenis_koreksi as Parameters<
            typeof prosesKoreksiAdmin
          >[0]["jenis_koreksi"],
          jam_koreksi: correction.jam_koreksi || undefined,
          keterangan_admin: correction.keterangan_admin || undefined,
          id_shift: correction.id_shift || undefined,
        }),
      );
      setFeedback({
        tone: hasil.gagal.length > 0 ? "error" : "success",
        text:
          ids.length === 1
            ? (hasil.gagal[0]?.pesan ??
              `Koreksi admin untuk ${namaKaryawan(ids[0])} tanggal ${correction.tanggal} tersimpan.`)
            : `Koreksi admin: ${ringkasHasil(hasil, namaKaryawan)}`,
      });
      // Yang gagal tetap terpilih supaya bisa langsung dicoba lagi.
      setCorrection((prev) => ({
        ...prev,
        idPersonil: hasil.gagal.map((item) => item.id),
        ...(hasil.gagal.length === 0
          ? { jam_koreksi: "", keterangan_admin: "" }
          : {}),
      }));
      if (hasil.berhasil.length > 0) {
        await load("correction", false, false);
      }
    });

  const submitCorrection = () => {
    const ids = correction.idPersonil;
    if (ids.length === 0) {
      setFeedback({
        tone: "error",
        text: "Pilih minimal satu karyawan terlebih dahulu.",
      });
      return;
    }
    const sudahAda = ids.filter((idKaryawan) =>
      records.some(
        (r) =>
          String(r.id_karyawan || r.id_unik) === idKaryawan &&
          String(r.tanggal || r.tanggal_kerja) === correction.tanggal,
      ),
    );
    if (sudahAda.length > 0 || ids.length > 1) {
      setConfirmKoreksi({ ids, sudahAda: sudahAda.map(namaKaryawan) });
      return;
    }
    void konfirmasiData([
      { label: "Tanggal", nilai: tanggalTampil(correction.tanggal) },
      { label: "Karyawan", nilai: namaKaryawan(ids[0] as string) },
      { label: "Jenis koreksi", nilai: correction.jenis_koreksi },
      { label: "Jam", nilai: correction.jam_koreksi },
      { label: "Keterangan", nilai: correction.keterangan_admin },
    ]).then((lanjut) => {
      if (lanjut) void executeCorrection(ids);
    });
  };

  const submitBackup = () =>
    run(async () => {
      if (!backup.id_karyawan_asal || !backup.id_karyawan_pengganti) {
        throw new Error(
          "Pilih Karyawan Asal dan Karyawan Pengganti terlebih dahulu.",
        );
      }
      const lanjut = await konfirmasiData([
        { label: "Tanggal", nilai: tanggalTampil(backup.tanggal_tugas) },
        {
          label: "Karyawan asal",
          nilai: namaKaryawan(backup.id_karyawan_asal),
        },
        {
          label: "Pengganti",
          nilai: namaKaryawan(backup.id_karyawan_pengganti),
        },
        {
          label: "Shift",
          nilai: String(
            shifts.find(
              (s) => Number(s.id_shift) === Number(backup.id_shift_backup),
            )?.nama_shift ?? "",
          ),
        },
        { label: "Alasan", nilai: backup.alasan_backup },
        { label: "Catatan", nilai: backup.catatan },
      ]);
      if (!lanjut) return;
      const result = await buatPenugasanBackup({
        tanggal_tugas: backup.tanggal_tugas,
        id_karyawan_asal: backup.id_karyawan_asal,
        id_karyawan_pengganti: backup.id_karyawan_pengganti,
        id_shift_backup: backup.id_shift_backup,
        alasan_backup: backup.alasan_backup,
        catatan: backup.catatan,
      });
      setFeedback({
        tone: result.sukses ? "success" : "error",
        text: result.pesan,
      });
      if (result.sukses) {
        setBackup((prev) => ({
          ...prev,
          id_karyawan_asal: "",
          nama_karyawan_asal: "",
          divisi_asal: "",
          id_karyawan_pengganti: "",
          nama_karyawan_pengganti: "",
          divisi_pengganti: "",
          alasan_backup: "Penggantian Shift",
          catatan: "",
        }));
        await load("backup", false, false);
      }
    });

  const submitManualEntry = () =>
    run(async () => {
      const ids = manualEntry.idPersonil;
      if (ids.length === 0) {
        throw new Error("Pilih minimal satu karyawan terlebih dahulu.");
      }
      const lanjut = await konfirmasiData([
        { label: "Tanggal", nilai: tanggalTampil(manualEntry.tanggal) },
        { label: "Karyawan", nilai: ids.map(namaKaryawan).join(", ") },
        { label: "Jam masuk", nilai: manualEntry.jam_masuk },
        { label: "Jam pulang", nilai: manualEntry.jam_pulang },
        { label: "Status kehadiran", nilai: manualEntry.status_kehadiran },
        { label: "Status absen", nilai: manualEntry.status_absen },
        { label: "Keterangan", nilai: manualEntry.keterangan },
      ]);
      if (!lanjut) return;
      const rows: OfflineImportRow[] = ids.map((idKaryawan) => {
        const found = cariKaryawan(idKaryawan);
        return {
          tanggal: manualEntry.tanggal,
          id_unik: idKaryawan,
          nama: found?.nama ? String(found.nama) : undefined,
          divisi: found?.divisi ? String(found.divisi) : undefined,
          jam_masuk: manualEntry.jam_masuk || undefined,
          jam_pulang: manualEntry.jam_pulang || undefined,
          status_kehadiran: manualEntry.status_kehadiran,
          status_absen: manualEntry.status_absen || undefined,
          keterangan: manualEntry.keterangan || undefined,
        };
      });
      const result = await prosesImportOffline(rows);
      // `results` berurutan sama dengan `rows`, di Web maupun Rust.
      const hasil = {
        berhasil: ids.filter((_, index) => result.results[index]?.sukses),
        gagal: ids.flatMap((idKaryawan, index) =>
          result.results[index]?.sukses
            ? []
            : [
                {
                  id: idKaryawan,
                  pesan: result.results[index]?.pesan || "Terjadi kesalahan",
                },
              ],
        ),
      };
      setFeedback({
        tone: hasil.gagal.length > 0 ? "error" : "success",
        text:
          ids.length === 1
            ? hasil.gagal.length === 0
              ? `Entri absensi manual untuk ${namaKaryawan(ids[0])} tanggal ${manualEntry.tanggal} berhasil disimpan.`
              : `Gagal menyimpan entri manual: ${hasil.gagal[0].pesan}`
            : `Entri manual: ${ringkasHasil(hasil, namaKaryawan)}`,
      });
      setManualEntry((prev) => ({
        ...prev,
        idPersonil: hasil.gagal.map((item) => item.id),
        ...(hasil.gagal.length === 0 ? { keterangan: "Import Manual" } : {}),
      }));
      if (hasil.berhasil.length > 0) {
        await load("import", false, false);
      }
    });

  const submitBulkCsv = () =>
    run(async () => {
      // Pembaca CSV bersama: menangani kutip ganda (keterangan berkoma) dan
      // pemisah titik koma dari Excel berbahasa Indonesia.
      const [headerParts = [], ...lines] = parseCsv(csv).rows;
      if (lines.length < 1) {
        throw new Error(
          "CSV kosong atau hanya berisi header. Masukkan data minimal 1 baris.",
        );
      }
      if (lines.length > BATAS_IMPORT_MASSAL) {
        throw new Error(
          `Import massal maksimal ${BATAS_IMPORT_MASSAL} baris sekali proses.`,
        );
      }
      const rows: OfflineImportRow[] = [];
      for (const parts of lines) {
        const rowObj: Record<string, string> = {};
        headerParts.forEach((header, idx) => {
          rowObj[header] = parts[idx] ?? "";
        });
        rows.push({
          tanggal: rowObj.tanggal || new Date().toLocaleDateString("en-CA"),
          id_unik: rowObj.id_unik || "",
          nama: rowObj.nama || undefined,
          divisi: rowObj.divisi || undefined,
          jam_masuk: rowObj.jam_masuk || undefined,
          jam_pulang: rowObj.jam_pulang || undefined,
          status_kehadiran: rowObj.status_kehadiran || "Hadir",
          status_absen: rowObj.status_absen || undefined,
          keterangan: rowObj.keterangan || undefined,
        });
      }
      const result = await prosesImportOffline(rows);
      setFeedback({
        tone: result.gagal > 0 ? "error" : "success",
        text: `Import massal selesai: ${result.berhasil} berhasil, ${result.gagal} gagal.`,
      });
      if (result.berhasil > 0) {
        setShowBulkUpload(false);
        setCsv(
          "tanggal,id_unik,jam_masuk,jam_pulang,status_kehadiran,keterangan\n",
        );
      }
      await load("import", false, false);
    });

  if (isLoading || !hydrated) {
    return (
      <AppShell contentClassName="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="flex items-center justify-center p-12 text-slate-400 font-mono text-sm">
          Memuat modul operasional absensi...
        </div>
      </AppShell>
    );
  }

  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "operational")) redirect("/forbidden");

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <PageHeader
        eyebrow="Operasional Absensi"
        title="Koreksi Admin, Backup & Import Manual"
        description="Kelola mutasi absensi, delegasi shift karyawan, dan input absensi manual dengan aturan prioritas terproteksi."
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.text}
        </FeedbackBanner>
      ) : null}

      {/* Konfirmasi koreksi: timpa koreksi lama dan/atau banyak karyawan */}
      {confirmKoreksi ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-amber-400">
              <Icon name="alert" className="size-6 shrink-0" />
              <h3 className="text-base font-bold text-white">
                {confirmKoreksi.ids.length > 1
                  ? `Simpan koreksi untuk ${confirmKoreksi.ids.length} karyawan?`
                  : "Konfirmasi Timpa Koreksi"}
              </h3>
            </div>
            <p className="text-sm text-slate-300">
              {correction.jenis_koreksi} pada tanggal{" "}
              <strong className="text-white">{correction.tanggal}</strong> untuk{" "}
              {confirmKoreksi.ids.length} karyawan.
            </p>
            {confirmKoreksi.sudahAda.length > 0 ? (
              <p className="text-xs text-amber-300/90 bg-amber-950/40 border border-amber-800/40 p-2.5 rounded-xl">
                {confirmKoreksi.sudahAda.length} karyawan sudah punya koreksi
                pada tanggal ini:{" "}
                {confirmKoreksi.sudahAda.slice(0, 5).join(", ")}
                {confirmKoreksi.sudahAda.length > 5
                  ? `, dan ${confirmKoreksi.sudahAda.length - 5} lainnya`
                  : ""}
                . Koreksi baru memperbarui absensi mereka pada tanggal itu.
              </p>
            ) : null}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmKoreksi(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 rounded-xl transition"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const ids = confirmKoreksi.ids;
                  setConfirmKoreksi(null);
                  void executeCorrection(ids);
                }}
                className="px-4 py-2 text-xs font-bold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-xl transition shadow-lg flex items-center gap-2"
              >
                Ya, Simpan Koreksi
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tab Switcher */}
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-900/60 p-2 font-mono text-xs">
        {(["correction", "backup", "import"] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setTab(value);
              setRecords([]);
              void load(value, false, false);
            }}
            className={`rounded-xl px-4 py-2.5 font-bold transition ${
              tab === value
                ? "bg-sky-400 text-slate-950 shadow-md shadow-sky-950"
                : "text-slate-400 hover:text-white"
            }`}
          >
            {value === "correction" && "Koreksi Admin"}
            {value === "backup" && "Penugasan Backup"}
            {value === "import" && "Import Manual"}
          </button>
        ))}
      </div>

      {/* TAB 1: KOREKSI ADMIN */}
      {tab === "correction" && hasPermission(user, "corrections.manage") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7 space-y-5 bg-slate-900/80 border border-slate-800">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-white">
              Formulir Koreksi Absensi (Otoritas Admin)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Koreksi absensi memiliki prioritas tertinggi dan langsung
              memperbarui rekaman absensi harian dan log scan.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 text-xs font-mono">
            {/* Tanggal */}
            <div>
              <span className="text-slate-400 block mb-1">Tanggal Absensi</span>
              <input
                aria-label="Tanggal absensi"
                type="date"
                className={inputClass}
                value={correction.tanggal}
                onChange={(event) =>
                  setCorrection({
                    ...correction,
                    tanggal: event.target.value,
                  })
                }
              />
            </div>

            {/* Karyawan: satu atau banyak sekaligus */}
            <div className="sm:col-span-2 md:col-span-3">
              <PilihPersonil
                id="koreksi-karyawan"
                label="Pilih karyawan (bisa lebih dari satu)"
                personil={employees}
                terpilih={correction.idPersonil}
                onChange={(ids) =>
                  setCorrection((prev) => ({ ...prev, idPersonil: ids }))
                }
                batas={BATAS_KOREKSI_MASSAL}
                disabled={busy}
              />
            </div>

            {/* Shift Jadwal Kerja Target */}
            <div>
              <span className="text-slate-400 block mb-1">
                Shift / Jadwal Kerja
              </span>
              <PilihCari
                aria-label="Pilih shift"
                className={inputClass}
                value={correction.id_shift}
                onChange={(event) =>
                  setCorrection({
                    ...correction,
                    id_shift: Number(event.target.value),
                  })
                }
              >
                <option value={0}>Ikuti shift masing-masing karyawan</option>
                {shiftOptions}
              </PilihCari>
            </div>

            {/* Jenis Koreksi */}
            <div>
              <span className="text-slate-400 block mb-1">Jenis Koreksi</span>
              <PilihCari
                aria-label="Jenis koreksi"
                className={inputClass}
                value={correction.jenis_koreksi}
                onChange={(event) =>
                  setCorrection({
                    ...correction,
                    jenis_koreksi: event.target.value,
                  })
                }
              >
                <option value="Sakit">Sakit</option>
                <option value="Izin">Izin</option>
                <option value="Dispen">Dispen</option>
                <option value="Alfa">Alfa</option>
                <option value="Lupa Absen Masuk">Lupa Absen Masuk</option>
                <option value="Lupa Absen Pulang">Lupa Absen Pulang</option>
                <option value="Kendala Sistem - Jam Masuk">
                  Kendala Sistem - Jam Masuk
                </option>
                <option value="Kendala Sistem - Jam Pulang">
                  Kendala Sistem - Jam Pulang
                </option>
                <option value="Terlambat">Terlambat (Disesuaikan)</option>
              </PilihCari>
            </div>

            {/* Jam Koreksi */}
            <div>
              <span className="text-slate-400 block mb-1">
                Jam Koreksi (HH:mm)
              </span>
              <input
                aria-label="Jam koreksi"
                type="time"
                className={inputClass}
                value={correction.jam_koreksi}
                onChange={(event) =>
                  setCorrection({
                    ...correction,
                    jam_koreksi: event.target.value,
                  })
                }
              />
            </div>

            {/* Keterangan Admin */}
            <div className="sm:col-span-2 md:col-span-2">
              <span className="text-slate-400 block mb-1">
                Keterangan / Alasan Koreksi
              </span>
              <input
                aria-label="Keterangan koreksi"
                className={inputClass}
                placeholder="Misal: Izin tertulis disetujui pimpinan / Kendala scanner mati"
                value={correction.keterangan_admin}
                onChange={(event) =>
                  setCorrection({
                    ...correction,
                    keterangan_admin: event.target.value,
                  })
                }
              />
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={submitCorrection}
            className="min-h-11 w-full rounded-xl bg-sky-400 font-black text-slate-950 transition hover:bg-sky-300 disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm shadow-md flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                <span>Sedang Memproses Koreksi...</span>
              </>
            ) : (
              <>Simpan Koreksi Admin</>
            )}
          </button>
        </section>
      ) : null}

      {/* TAB 2: BACKUP KARYAWAN */}
      {tab === "backup" && hasPermission(user, "backups.manage") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7 space-y-5 bg-slate-900/80 border border-slate-800">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-white">
              Penugasan Backup Karyawan
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Delegasikan jadwal kerja ke karyawan pengganti. Sistem akan
              mengarahkan scan karyawan pengganti ke shift backup.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 text-xs font-mono">
            {/* Tanggal Tugas */}
            <div>
              <span className="text-slate-400 block mb-1">Tanggal Tugas</span>
              <input
                aria-label="Tanggal tugas"
                type="date"
                className={inputClass}
                value={backup.tanggal_tugas}
                onChange={(event) =>
                  setBackup({ ...backup, tanggal_tugas: event.target.value })
                }
              />
            </div>

            {/* Shift Backup */}
            <div>
              <span className="text-slate-400 block mb-1">
                Shift Backup Ditugaskan
              </span>
              <PilihCari
                aria-label="Shift backup"
                className={inputClass}
                value={backup.id_shift_backup}
                onChange={(event) =>
                  setBackup({
                    ...backup,
                    id_shift_backup: Number(event.target.value),
                  })
                }
              >
                {shiftOptions}
              </PilihCari>
            </div>

            {/* Alasan Backup */}
            <div>
              <span className="text-slate-400 block mb-1">Alasan Backup</span>
              <input
                aria-label="Alasan backup"
                className={inputClass}
                placeholder="Misal: Menggantikan Cuti"
                value={backup.alasan_backup}
                onChange={(event) =>
                  setBackup({ ...backup, alasan_backup: event.target.value })
                }
              />
            </div>

            {/* Karyawan Asal (Yang Digantikan) */}
            <div>
              <PilihPersonil
                id="backup-asal"
                label="Karyawan asal (yang digantikan)"
                personil={employees}
                terpilih={
                  backup.id_karyawan_asal ? [backup.id_karyawan_asal] : []
                }
                onChange={handleSelectBackupAsal}
                disabled={busy}
              />
            </div>

            {/* Karyawan Pengganti */}
            <div>
              <PilihPersonil
                id="backup-pengganti"
                label="Karyawan pengganti"
                personil={employees}
                terpilih={
                  backup.id_karyawan_pengganti
                    ? [backup.id_karyawan_pengganti]
                    : []
                }
                onChange={handleSelectBackupPengganti}
                disabled={busy}
              />
            </div>

            {/* Catatan Tambahan */}
            <div>
              <span className="text-slate-400 block mb-1">
                Catatan Tambahan
              </span>
              <input
                aria-label="Catatan backup"
                className={inputClass}
                placeholder="Catatan opsional"
                value={backup.catatan}
                onChange={(event) =>
                  setBackup({ ...backup, catatan: event.target.value })
                }
              />
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={submitBackup}
            className="min-h-11 w-full rounded-xl bg-sky-400 font-black text-slate-950 transition hover:bg-sky-300 disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm shadow-md flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                <span>Sedang Menyimpan Backup...</span>
              </>
            ) : (
              <>Buat Penugasan Backup</>
            )}
          </button>
        </section>
      ) : null}

      {/* TAB 3: IMPORT MANUAL */}
      {tab === "import" && hasPermission(user, "corrections.manage") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7 space-y-6 bg-slate-900/80 border border-slate-800">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-white">
              Input Absensi Manual (Per-Kolom)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Tambahkan data absensi harian per kolom secara langsung. Pilih
              karyawan dan tanggal, maka sistem otomatis menghitung seluruh
              metrik shift dan mencatat di Log Scan.
            </p>
          </div>

          {/* Form Input Manual Per-Kolom */}
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 text-xs font-mono bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
            {/* Tanggal */}
            <div>
              <span className="text-slate-400 block mb-1 font-semibold">
                Tanggal Absensi
              </span>
              <input
                aria-label="Tanggal absensi"
                type="date"
                className={inputClass}
                value={manualEntry.tanggal}
                onChange={(e) =>
                  setManualEntry({ ...manualEntry, tanggal: e.target.value })
                }
              />
            </div>

            {/* Karyawan: satu atau banyak sekaligus */}
            <div className="sm:col-span-2 md:col-span-3">
              <PilihPersonil
                id="manual-karyawan"
                label="Pilih karyawan (bisa lebih dari satu)"
                personil={employees}
                terpilih={manualEntry.idPersonil}
                onChange={(ids) =>
                  setManualEntry((prev) => ({ ...prev, idPersonil: ids }))
                }
                batas={BATAS_IMPORT_MASSAL}
                disabled={busy}
              />
            </div>

            {/* Status Kehadiran */}
            <div>
              <span className="text-slate-400 block mb-1 font-semibold">
                Status Kehadiran
              </span>
              <select
                aria-label="Status kehadiran"
                className={inputClass}
                value={manualEntry.status_kehadiran}
                onChange={(e) =>
                  setManualEntry({
                    ...manualEntry,
                    status_kehadiran: e.target.value,
                  })
                }
              >
                <option value="Hadir">Hadir</option>
                <option value="Sakit">Sakit</option>
                <option value="Izin">Izin</option>
                <option value="Dispen">Dispen</option>
                <option value="Alfa">Alfa</option>
              </select>
            </div>

            {/* Jam Masuk */}
            <div>
              <span className="text-emerald-400 block mb-1 font-semibold">
                Jam Masuk (HH:mm)
              </span>
              <input
                aria-label="Jam Masuk"
                type="time"
                className={inputClass}
                value={manualEntry.jam_masuk}
                onChange={(e) =>
                  setManualEntry({ ...manualEntry, jam_masuk: e.target.value })
                }
              />
            </div>

            {/* Jam Pulang */}
            <div>
              <span className="text-sky-400 block mb-1 font-semibold">
                Jam Pulang (HH:mm)
              </span>
              <input
                aria-label="Jam Pulang"
                type="time"
                className={inputClass}
                value={manualEntry.jam_pulang}
                onChange={(e) =>
                  setManualEntry({ ...manualEntry, jam_pulang: e.target.value })
                }
              />
            </div>

            {/* Status Absen */}
            <div>
              <span className="text-amber-400 block mb-1 font-semibold">
                Status Absen
              </span>
              <PilihCari
                aria-label="Status Absen"
                className={inputClass}
                value={manualEntry.status_absen}
                onChange={(e) =>
                  setManualEntry({
                    ...manualEntry,
                    status_absen: e.target.value,
                  })
                }
              >
                <option value="">Otomatis (Generate Sistem Sesuai Jam)</option>
                <option value="Lengkap">Lengkap (Masuk & Pulang)</option>
                <option value="Belum Pulang">Belum Pulang (Hanya Masuk)</option>
                <option value="Perlu Verifikasi">
                  Perlu Verifikasi (Hanya Pulang)
                </option>
                <option value="Tidak Hadir">
                  Tidak Hadir (Sakit/Izin/Alfa)
                </option>
                <option value="Tepat Waktu">Tepat Waktu</option>
                <option value="Terlambat">Terlambat</option>
                <option value="Datang Lebih Awal">Datang Lebih Awal</option>
              </PilihCari>
            </div>

            {/* Keterangan */}
            <div>
              <span className="text-slate-400 block mb-1">Keterangan</span>
              <input
                aria-label="Keterangan"
                className={inputClass}
                placeholder="Misal: Absensi manual"
                value={manualEntry.keterangan}
                onChange={(e) =>
                  setManualEntry({ ...manualEntry, keterangan: e.target.value })
                }
              />
            </div>

            <div className="sm:col-span-2 md:col-span-3 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={submitManualEntry}
                className="min-h-11 w-full rounded-xl bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-black transition disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm shadow-md flex items-center justify-center gap-2"
              >
                {busy ? (
                  <>
                    <div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                    <span>Sedang Menyimpan Entri Manual...</span>
                  </>
                ) : (
                  <>Simpan Entri Manual</>
                )}
              </button>
            </div>
          </div>

          {/* Collapsible Section: Bulk CSV Upload */}
          <div className="border-t border-slate-800/80 pt-4">
            <button
              type="button"
              onClick={() => setShowBulkUpload(!showBulkUpload)}
              className="text-xs font-mono text-sky-400 hover:text-sky-300 font-bold flex items-center gap-2"
            >
              <span>{showBulkUpload ? "▼" : "▶"}</span>
              <span>Opsi Tambahan: Import Massal File CSV (Opsional)</span>
            </button>

            {showBulkUpload ? (
              <div className="mt-3 space-y-3 bg-slate-950/40 p-4 rounded-2xl border border-slate-800">
                <p className="text-xs text-slate-400">
                  Tempel teks CSV dengan format header:{" "}
                  <code className="text-sky-300 font-mono">
                    tanggal,id_unik,jam_masuk,jam_pulang,status_kehadiran,keterangan
                  </code>
                </p>
                <textarea
                  aria-label="Data CSV Import Manual"
                  rows={6}
                  className={`${inputClass} min-h-36 py-3 font-mono text-xs`}
                  value={csv}
                  onChange={(event) => setCsv(event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={submitBulkCsv}
                  className="min-h-10 w-full rounded-xl bg-amber-400 hover:bg-amber-300 font-bold text-slate-950 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-mono flex items-center justify-center gap-2"
                >
                  {busy ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                      <span>Sedang Mengimpor Data CSV...</span>
                    </>
                  ) : (
                    <>🚀 Proses Import Massal CSV</>
                  )}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Riwayat Data Section */}
      <section className="app-panel rounded-3xl p-5 bg-slate-900/80 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <h2 className="font-bold text-white text-sm">
            📋 Log Riwayat{" "}
            {tab === "backup"
              ? "Backup"
              : tab === "import"
                ? "Import Manual"
                : "Koreksi Admin"}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(tab)}
            className="rounded-xl border border-white/10 px-4 py-2 text-xs font-mono font-bold bg-slate-800 hover:bg-slate-700 text-sky-300 transition"
          >
            🔄 Muat Data
          </button>
        </div>

        {tab === "backup" && records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400 bg-slate-950/40">
                <tr>
                  <th className="p-2.5">ID Backup</th>
                  <th className="p-2.5">Tanggal Tugas</th>
                  <th className="p-2.5">Karyawan Asal</th>
                  <th className="p-2.5">Karyawan Pengganti</th>
                  <th className="p-2.5">Shift Backup</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {records.map((item) => (
                  <tr key={String(item.id_backup)}>
                    <td className="p-2.5 text-sky-400 font-bold">
                      {String(item.id_backup)}
                    </td>
                    <td className="p-2.5">{String(item.tanggal_tugas)}</td>
                    <td className="p-2.5">
                      {String(item.nama_karyawan_asal)} (
                      {String(item.id_karyawan_asal)})
                    </td>
                    <td className="p-2.5 text-emerald-300 font-bold">
                      {String(item.nama_karyawan_pengganti)} (
                      {String(item.id_karyawan_pengganti)})
                    </td>
                    <td className="p-2.5">
                      Shift {String(item.id_shift_backup)}
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          item.status_tugas === "Aktif"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                            : "bg-rose-950 text-rose-300 border border-rose-800"
                        }`}
                      >
                        {String(item.status_tugas)}
                      </span>
                    </td>
                    <td className="p-2.5">
                      <div className="flex items-center gap-1.5">
                        {item.status_tugas === "Aktif" &&
                        hasPermission(user, "backups.manage") ? (
                          <button
                            type="button"
                            onClick={() =>
                              run(async () => {
                                const result = await batalkanPenugasanBackup(
                                  String(item.id_backup),
                                );
                                setFeedback({
                                  tone: result.sukses ? "success" : "error",
                                  text: result.pesan,
                                });
                                load();
                              })
                            }
                            className="px-2.5 py-1 rounded bg-amber-950/80 hover:bg-amber-900 border border-amber-800 text-amber-300 text-[11px]"
                          >
                            Batalkan
                          </button>
                        ) : null}
                        {hasPermission(user, "operational.delete") ? (
                          <button
                            type="button"
                            onClick={() =>
                              setDeleteConfirm({
                                type: "backup",
                                idReferensi: String(item.id_backup || ""),
                                title: `Hapus Backup: ${item.id_backup}`,
                                subtitle: `${item.nama_karyawan_pengganti} (${item.id_karyawan_pengganti}) menggantikan ${item.nama_karyawan_asal} (${item.id_karyawan_asal}) pada ${item.tanggal_tugas}`,
                              })
                            }
                            className="px-2.5 py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[11px] font-bold transition flex items-center gap-1"
                            title="Hapus baris backup ini"
                          >
                            <span>🗑️</span>
                            <span>Hapus</span>
                          </button>
                        ) : null}
                        {!hasPermission(user, "operational.delete") &&
                        !(
                          item.status_tugas === "Aktif" &&
                          hasPermission(user, "backups.manage")
                        ) ? (
                          <span>-</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === "correction" && records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400 bg-slate-950/40">
                <tr>
                  <th className="p-2.5">Referensi</th>
                  <th className="p-2.5">Tanggal</th>
                  <th className="p-2.5">Karyawan</th>
                  <th className="p-2.5">Jenis Koreksi</th>
                  <th className="p-2.5">Jam Koreksi</th>
                  <th className="p-2.5">Keterangan</th>
                  <th className="p-2.5">Operator</th>
                  {hasPermission(user, "operational.delete") ? (
                    <th className="p-2.5 text-center">Aksi</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {records.map((item) => (
                  <tr key={String(item.id_referensi || item.id_koreksi)}>
                    <td className="p-2.5 text-sky-400 font-bold">
                      {String(item.id_referensi || "-")}
                    </td>
                    <td className="p-2.5">{String(item.tanggal)}</td>
                    <td className="p-2.5 font-bold text-white">
                      {String(item.nama)} ({String(item.id_karyawan)})
                    </td>
                    <td className="p-2.5">
                      <span className="px-2 py-0.5 rounded bg-sky-950 border border-sky-800 text-sky-300 text-[11px]">
                        {String(item.jenis_koreksi)}
                      </span>
                    </td>
                    <td className="p-2.5">{String(item.jam_koreksi || "-")}</td>
                    <td className="p-2.5 text-slate-400 max-w-xs truncate">
                      {String(item.keterangan_admin || "-")}
                    </td>
                    <td className="p-2.5 text-slate-400">
                      {String(item.kode_operator || "-")}
                    </td>
                    {hasPermission(user, "operational.delete") ? (
                      <td className="p-2.5 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteConfirm({
                              type: "correction",
                              idReferensi: String(item.id_referensi || ""),
                              title: `Hapus Koreksi: ${item.id_referensi}`,
                              subtitle: `${item.nama} (${item.id_karyawan}) · ${item.jenis_koreksi} pada ${item.tanggal}`,
                            })
                          }
                          className="px-2.5 py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[11px] font-bold transition flex items-center gap-1 mx-auto"
                          title="Hapus baris koreksi ini"
                        >
                          <span>🗑️</span>
                          <span>Hapus</span>
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === "import" && records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono text-slate-300">
              <thead className="border-b border-slate-800 text-slate-400 bg-slate-950/40">
                <tr>
                  <th className="p-2.5">Event Key</th>
                  <th className="p-2.5">Tanggal</th>
                  <th className="p-2.5">Karyawan</th>
                  <th className="p-2.5">Divisi</th>
                  <th className="p-2.5">Jam Masuk</th>
                  <th className="p-2.5">Jam Pulang</th>
                  <th className="p-2.5">Kehadiran</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5">Keterangan</th>
                  <th className="p-2.5">Operator</th>
                  {hasPermission(user, "operational.delete") ? (
                    <th className="p-2.5 text-center">Aksi</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {records.map((item) => (
                  <tr key={String(item.event_key || item.id_import)}>
                    <td
                      className="p-2.5 text-sky-400 font-bold max-w-[140px] truncate"
                      title={String(item.event_key || "")}
                    >
                      {String(item.event_key || item.id_import || "-")}
                    </td>
                    <td className="p-2.5">{String(item.tanggal)}</td>
                    <td className="p-2.5 font-bold text-white">
                      {String(item.nama)} ({String(item.id_unik)})
                    </td>
                    <td className="p-2.5 text-slate-400">
                      {String(item.divisi || "-")}
                    </td>
                    <td className="p-2.5 text-emerald-300 font-bold">
                      {String(item.jam_masuk || "-")}
                    </td>
                    <td className="p-2.5 text-amber-300 font-bold">
                      {String(item.jam_pulang || "-")}
                    </td>
                    <td className="p-2.5">
                      <span className="px-2 py-0.5 rounded bg-sky-950 border border-sky-800 text-sky-300 text-[11px]">
                        {String(item.status_kehadiran || "Hadir")}
                      </span>
                    </td>
                    <td className="p-2.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          item.status_proses === "Sudah Diproses" ||
                          item.status_proses === "Berhasil"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                            : "bg-rose-950 text-rose-300 border border-rose-800"
                        }`}
                      >
                        {String(item.status_proses || item.status_absen || "-")}
                      </span>
                    </td>
                    <td
                      className="p-2.5 text-slate-400 max-w-xs truncate"
                      title={String(item.pesan_error || item.keterangan || "")}
                    >
                      {String(item.pesan_error || item.keterangan || "-")}
                    </td>
                    <td className="p-2.5 text-slate-400">
                      {String(item.kode_operator || "-")}
                    </td>
                    {hasPermission(user, "operational.delete") ? (
                      <td className="p-2.5 text-center">
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteConfirm({
                              type: "import",
                              idReferensi: String(item.event_key || ""),
                              title: `Hapus Import: ${item.event_key || item.id_import}`,
                              subtitle: `${item.nama} (${item.id_unik}) · Masuk: ${item.jam_masuk || "-"}, Pulang: ${item.jam_pulang || "-"} pada ${item.tanggal}`,
                            })
                          }
                          className="px-2.5 py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 text-[11px] font-bold transition flex items-center gap-1 mx-auto"
                          title="Hapus baris import ini"
                        >
                          <span>🗑️</span>
                          <span>Hapus</span>
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-slate-500 font-mono py-4 text-center">
            Tekan &quot;Muat Data&quot; untuk menampilkan riwayat tercatat.
          </p>
        )}
      </section>

      {/* Modal Konfirmasi Hapus Riwayat */}
      {deleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md rounded-3xl border border-rose-800/60 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="border-b border-slate-800 pb-3 flex items-center gap-3 text-rose-400">
              <div className="w-10 h-10 rounded-2xl bg-rose-950/80 border border-rose-800 flex items-center justify-center text-xl shrink-0">
                <Icon name="alert" className="size-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Konfirmasi Hapus{" "}
                  {deleteConfirm.type === "import"
                    ? "Import Manual"
                    : deleteConfirm.type === "backup"
                      ? "Penugasan Backup"
                      : "Koreksi"}
                </h3>
                <p className="text-xs text-rose-300 mt-0.5 font-mono">
                  {deleteConfirm.title}
                </p>
              </div>
            </div>

            <div className="bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 text-xs font-mono text-slate-300 space-y-1">
              <p>{deleteConfirm.subtitle}</p>
              <p className="text-amber-400 text-[11px] pt-1">
                {deleteConfirm.type === "backup"
                  ? "Menghapus data penugasan backup akan menghapus riwayat penugasan ini secara permanen dan menyelaraskan kembali status backup karyawan jika tidak ada penugasan aktif lainnya."
                  : `Menghapus ${deleteConfirm.type === "import" ? "rekaman import" : "koreksi"} akan membatalkan efeknya pada absensi harian dan mencatat jejak audit operator.`}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono font-bold transition disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleDeleteConfirmed}
                className="px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-white text-xs font-mono font-bold transition disabled:opacity-50 flex items-center gap-1.5"
              >
                {busy ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    <span>Menghapus...</span>
                  </>
                ) : (
                  <>
                    <span>🗑️</span>
                    <span>
                      Ya, Hapus{" "}
                      {deleteConfirm.type === "import"
                        ? "Import"
                        : deleteConfirm.type === "backup"
                          ? "Backup"
                          : "Koreksi"}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
