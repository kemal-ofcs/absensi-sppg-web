"use client";

import { redirect } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { PageHeader } from "@/components/ui/PageHeader";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  batalkanPenugasanBackup,
  buatPenugasanBackup,
  getDaftarBackup,
} from "@/lib/gateways/backup";
import {
  getDaftarKoreksi,
  prosesKoreksiAdmin,
} from "@/lib/gateways/correction";
import {
  type OfflineImportRow,
  prosesImportOffline,
} from "@/lib/gateways/offline-import";
import { useHydrated } from "@/lib/hooks/useHydrated";

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
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [correction, setCorrection] = useState({
    tanggal: new Date().toISOString().slice(0, 10),
    id_karyawan: "",
    jenis_koreksi: "Izin",
    jam_koreksi: "",
    keterangan_admin: "",
  });
  const [backup, setBackup] = useState({
    tanggal_tugas: new Date().toISOString().slice(0, 10),
    id_karyawan_asal: "",
    id_karyawan_pengganti: "",
    id_shift_backup: 1,
    alasan_backup: "",
    catatan: "",
  });
  const [csv, setCsv] = useState(
    "tanggal,id_unik,jam_masuk,jam_pulang,status_kehadiran,keterangan\n",
  );
  const [busy, setBusy] = useState(false);

  if (!hydrated || isLoading)
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 text-slate-300">
        Memuat operasional...
      </div>
    );
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "operational")) redirect("/forbidden");

  const run = async (task: () => Promise<void>) => {
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
    }
  };
  const load = () =>
    run(async () => {
      const data =
        tab === "backup" ? await getDaftarBackup() : await getDaftarKoreksi();
      setRecords(data);
      setFeedback({
        tone: "success",
        text: `${data.length} data berhasil dimuat.`,
      });
    });
  const submitCorrection = () =>
    run(async () => {
      const result = await prosesKoreksiAdmin(
        correction as Parameters<typeof prosesKoreksiAdmin>[0],
      );
      setFeedback({
        tone: result.sukses ? "success" : "error",
        text: result.pesan,
      });
    });
  const submitBackup = () =>
    run(async () => {
      const result = await buatPenugasanBackup(backup);
      setFeedback({
        tone: result.sukses ? "success" : "error",
        text: result.pesan,
      });
    });
  const submitImport = () =>
    run(async () => {
      const lines = csv.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) throw new Error("CSV belum memiliki baris data.");
      const headers = lines[0]
        .split(",")
        .map((value) => value.trim().toLowerCase());
      const rows: OfflineImportRow[] = lines.slice(1).map((line) => {
        const values = line.split(",").map((value) => value.trim());
        const data = Object.fromEntries(
          headers.map((key, index) => [key, values[index] ?? ""]),
        );
        return {
          tanggal: data.tanggal ?? "",
          id_unik: data.id_unik ?? "",
          nama: data.nama,
          divisi: data.divisi,
          jam_masuk: data.jam_masuk,
          jam_pulang: data.jam_pulang,
          status_kehadiran: data.status_kehadiran,
          status_absen: data.status_absen,
          keterangan: data.keterangan,
        };
      });
      const result = await prosesImportOffline(rows);
      setFeedback({
        tone: result.gagal > 0 ? "error" : "success",
        text: `Import selesai: ${result.berhasil} berhasil, ${result.gagal} gagal.`,
      });
    });

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Operasional absensi"
        title="Koreksi, backup & import"
        description="Semua perubahan Desktop disimpan lokal dahulu. Konflik tidak pernah menimpa data server otomatis."
      />
      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.text}
        </FeedbackBanner>
      ) : null}
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-900/60 p-2">
        {(["correction", "backup", "import"] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setTab(value);
              setRecords([]);
            }}
            className={`min-h-10 rounded-xl px-4 text-xs font-black ${tab === value ? "bg-sky-400 text-slate-950" : "text-slate-300"}`}
          >
            {value === "correction"
              ? "Koreksi Admin"
              : value === "backup"
                ? "Backup Karyawan"
                : "Import Offline"}
          </button>
        ))}
      </div>
      {tab === "correction" && hasPermission(user, "corrections.manage") ? (
        <section className="app-panel grid gap-4 rounded-3xl p-5 sm:grid-cols-2 sm:p-7">
          <input
            aria-label="Tanggal koreksi"
            type="date"
            className={inputClass}
            value={correction.tanggal}
            onChange={(event) =>
              setCorrection({ ...correction, tanggal: event.target.value })
            }
          />
          <input
            aria-label="ID karyawan"
            className={inputClass}
            placeholder="ID karyawan"
            value={correction.id_karyawan}
            onChange={(event) =>
              setCorrection({ ...correction, id_karyawan: event.target.value })
            }
          />
          <select
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
            {[
              "Sakit",
              "Izin",
              "Dispen",
              "Alfa",
              "Terlambat",
              "Lupa Absen Masuk",
              "Lupa Absen Pulang",
              "Kendala Sistem - Jam Masuk",
              "Kendala Sistem - Jam Pulang",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <input
            aria-label="Jam koreksi"
            type="time"
            className={inputClass}
            value={correction.jam_koreksi}
            onChange={(event) =>
              setCorrection({ ...correction, jam_koreksi: event.target.value })
            }
          />
          <input
            aria-label="Keterangan koreksi"
            className={`${inputClass} sm:col-span-2`}
            placeholder="Keterangan admin"
            value={correction.keterangan_admin}
            onChange={(event) =>
              setCorrection({
                ...correction,
                keterangan_admin: event.target.value,
              })
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={submitCorrection}
            className="min-h-11 rounded-xl bg-sky-400 font-black text-slate-950 disabled:opacity-50 sm:col-span-2"
          >
            Simpan koreksi
          </button>
        </section>
      ) : null}
      {tab === "backup" && hasPermission(user, "backups.manage") ? (
        <section className="app-panel grid gap-4 rounded-3xl p-5 sm:grid-cols-2 sm:p-7">
          <input
            aria-label="Tanggal tugas"
            type="date"
            className={inputClass}
            value={backup.tanggal_tugas}
            onChange={(event) =>
              setBackup({ ...backup, tanggal_tugas: event.target.value })
            }
          />
          <input
            aria-label="Shift backup"
            type="number"
            min="1"
            className={inputClass}
            value={backup.id_shift_backup}
            onChange={(event) =>
              setBackup({
                ...backup,
                id_shift_backup: Number(event.target.value),
              })
            }
          />
          <input
            aria-label="Karyawan asal"
            className={inputClass}
            placeholder="ID karyawan asal"
            value={backup.id_karyawan_asal}
            onChange={(event) =>
              setBackup({ ...backup, id_karyawan_asal: event.target.value })
            }
          />
          <input
            aria-label="Karyawan pengganti"
            className={inputClass}
            placeholder="ID karyawan pengganti"
            value={backup.id_karyawan_pengganti}
            onChange={(event) =>
              setBackup({
                ...backup,
                id_karyawan_pengganti: event.target.value,
              })
            }
          />
          <input
            aria-label="Alasan backup"
            className={`${inputClass} sm:col-span-2`}
            placeholder="Alasan penugasan"
            value={backup.alasan_backup}
            onChange={(event) =>
              setBackup({ ...backup, alasan_backup: event.target.value })
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={submitBackup}
            className="min-h-11 rounded-xl bg-sky-400 font-black text-slate-950 disabled:opacity-50 sm:col-span-2"
          >
            Buat penugasan
          </button>
        </section>
      ) : null}
      {tab === "import" && hasPermission(user, "corrections.manage") ? (
        <section className="app-panel rounded-3xl p-5 sm:p-7">
          <p className="mb-3 text-sm text-slate-400">
            Tempel CSV dengan header contoh di bawah. Maksimal 500 baris per
            proses.
          </p>
          <textarea
            aria-label="Data CSV Import Offline"
            rows={10}
            className={`${inputClass} min-h-56 py-3 font-mono text-xs`}
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={submitImport}
            className="mt-4 min-h-11 w-full rounded-xl bg-amber-300 font-black text-slate-950 disabled:opacity-50"
          >
            Proses Import Offline
          </button>
        </section>
      ) : null}
      {tab !== "import" ? (
        <section className="app-panel rounded-3xl p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-black text-white">Riwayat lokal/server</h2>
            <button
              type="button"
              disabled={busy}
              onClick={load}
              className="rounded-xl border border-white/10 px-4 py-2 text-xs font-bold"
            >
              Muat data
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <pre className="min-w-[600px] whitespace-pre-wrap text-xs text-slate-400">
              {records.length
                ? JSON.stringify(records, null, 2)
                : "Tekan Muat data untuk melihat riwayat."}
            </pre>
          </div>
          {tab === "backup" &&
          records.some((item) => item.status_tugas === "Aktif") &&
          hasPermission(user, "backups.manage") ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {records
                .filter((item) => item.status_tugas === "Aktif")
                .slice(0, 10)
                .map((item) => (
                  <button
                    key={String(item.id_backup)}
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
                      })
                    }
                    className="rounded-lg border border-rose-400/20 px-3 py-2 text-xs text-rose-200"
                  >
                    Batalkan {String(item.id_backup)}
                  </button>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </AppShell>
  );
}
