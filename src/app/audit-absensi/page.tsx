"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getAuditKualitasAbsensi,
  type HasilAuditAbsensi,
  type KeparahanTemuan,
} from "@/lib/gateways/attendance-audit";
import { useHydrated } from "@/lib/hooks/useHydrated";

type FilterKeparahan = "semua" | KeparahanTemuan;

const KEPARAHAN_TONE: Record<
  KeparahanTemuan,
  "danger" | "warning" | "info" | "neutral"
> = {
  tinggi: "danger",
  sedang: "warning",
  rendah: "info",
  info: "neutral",
};

const KEPARAHAN_LABEL: Record<KeparahanTemuan, string> = {
  tinggi: "Perlu Tindakan",
  sedang: "Perlu Dicek",
  rendah: "Catatan",
  info: "Informasi",
};

const FILTER_OPTIONS: Array<{ value: FilterKeparahan; label: string }> = [
  { value: "semua", label: "Semua" },
  { value: "tinggi", label: "Perlu Tindakan" },
  { value: "sedang", label: "Perlu Dicek" },
  { value: "rendah", label: "Catatan" },
  { value: "info", label: "Informasi" },
];

function formatTanggalPanjang(value: string) {
  if (!value) return "-";
  try {
    const [y, m, d] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(y, m - 1, d));
  } catch {
    return value;
  }
}

function skorTone(skor: number) {
  if (skor >= 90) return "text-emerald-400";
  if (skor >= 70) return "text-amber-400";
  return "text-rose-400";
}

function StatCard({
  label,
  value,
  hint,
  tone = "text-white",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-black ${tone}`}>{value}</div>
      {hint ? (
        <div className="mt-0.5 text-[11px] leading-4 text-slate-500">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default function AuditAbsensiPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [tanggal, setTanggal] = useState("");
  const [audit, setAudit] = useState<HasilAuditAbsensi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKeparahan>("semua");
  const [pencarian, setPencarian] = useState("");

  const loadData = useCallback(
    async (targetTanggal?: string, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const hasil = await getAuditKualitasAbsensi(targetTanggal || undefined);
        setAudit(hasil);
        // Server yang memutuskan tanggal default (zona operasional), bukan
        // jam browser — sinkronkan input dengan jawabannya.
        setTanggal((current) => current || hasil.tanggal);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Gagal memuat audit kualitas absensi.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isHydrated || !isAuthenticated) return;
    void loadData();
  }, [isHydrated, isAuthenticated, loadData]);

  useEffect(() => {
    const onSyncCompleted = () => void loadData(tanggal, true);
    window.addEventListener("sppg:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("sppg:sync-completed", onSyncCompleted);
    };
  }, [loadData, tanggal]);

  const temuanTampil = useMemo(() => {
    if (!audit) return [];
    const kunci = pencarian.trim().toLowerCase();
    return audit.temuan.filter((item) => {
      if (filter !== "semua" && item.keparahan !== filter) return false;
      if (!kunci) return true;
      return (
        item.nama.toLowerCase().includes(kunci) ||
        item.idKaryawan.toLowerCase().includes(kunci) ||
        item.divisi.toLowerCase().includes(kunci) ||
        item.kategori.toLowerCase().includes(kunci)
      );
    });
  }, [audit, filter, pencarian]);

  if (!isHydrated || authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex items-center gap-3 text-slate-400">
          <Icon name="clock" className="size-6 animate-spin text-sky-400" />
          <span>Memuat audit kualitas absensi...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    redirect("/login");
  }

  if (!canAccessArea(user, "audit")) {
    redirect("/forbidden");
  }

  const ringkasan = audit?.ringkasan;

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <PageHeader
        eyebrow="Kualitas Data"
        title="Audit Kualitas Absensi"
        description="Ringkasan kesehatan data absensi harian: siapa yang belum absen padahal jam absen sudah lewat, sesi yang menggantung tanpa scan pulang, dan scan yang perlu diverifikasi."
        badge={
          audit?.hariLibur ? (
            <StatusBadge tone="info">Hari Libur: {audit.hariLibur}</StatusBadge>
          ) : null
        }
        actions={
          <>
            <label className="sr-only" htmlFor="audit-tanggal">
              Tanggal kerja yang diaudit
            </label>
            <input
              id="audit-tanggal"
              type="date"
              value={tanggal}
              onChange={(event) => {
                setTanggal(event.target.value);
                void loadData(event.target.value);
              }}
              className="min-h-10 rounded-xl border border-slate-800 bg-slate-950 px-3 text-sm text-white outline-none focus:border-amber-500"
            />
            <button
              type="button"
              onClick={() => void loadData(tanggal)}
              disabled={loading}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-sky-500 px-4 text-sm font-bold text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 disabled:opacity-50"
            >
              <Icon
                name="refresh"
                className={`size-4 ${loading ? "animate-spin" : ""}`}
              />
              Muat Ulang
            </button>
          </>
        }
      />

      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError(null)}>
          {error}
        </FeedbackBanner>
      ) : null}

      {loading && !audit ? (
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-6 text-slate-400">
          <Icon name="clock" className="size-5 animate-spin text-sky-400" />
          Menghitung kualitas absensi...
        </div>
      ) : null}

      {audit && ringkasan ? (
        <>
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                Ringkasan {formatTanggalPanjang(audit.tanggal)}
              </h2>
              <span className="text-[11px] text-slate-500">
                Diaudit pada {audit.waktuAudit} WIB
              </span>
            </div>

            {audit.hariLibur ? (
              <FeedbackBanner tone="warning">
                <strong>{audit.hariLibur}</strong> — tanggal ini hari libur
                aktif, jadi tidak ada karyawan yang dinilai wajib absen.
              </FeedbackBanner>
            ) : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                label="Skor Kualitas"
                value={`${ringkasan.skorKualitas}%`}
                hint={`${ringkasan.wajibAbsen - ringkasan.karyawanBermasalah} dari ${ringkasan.wajibAbsen} karyawan bersih`}
                tone={skorTone(ringkasan.skorKualitas)}
              />
              <StatCard
                label="Wajib Absen"
                value={ringkasan.wajibAbsen}
                hint={`${ringkasan.totalKaryawanAktif} karyawan aktif`}
              />
              <StatCard
                label="Belum Scan Masuk"
                value={ringkasan.belumScanMasuk}
                hint="Jam absen sudah lewat"
                tone="text-rose-400"
              />
              <StatCard
                label="Belum Scan Pulang"
                value={ringkasan.belumScanPulang}
                hint="Sesi menggantung"
                tone="text-amber-400"
              />
              <StatCard
                label="Perlu Verifikasi"
                value={ringkasan.perluVerifikasi}
                hint={`${ringkasan.scanDitolak} scan ditolak`}
                tone="text-amber-400"
              />
              <StatCard
                label="Alfa"
                value={ringkasan.alfa}
                hint={`${ringkasan.hadir} hadir, ${ringkasan.izinSakit} izin/sakit`}
                tone="text-rose-400"
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <StatusBadge tone="success">Hadir {ringkasan.hadir}</StatusBadge>
              <StatusBadge tone="info">
                Sedang Bekerja {ringkasan.sedangBekerja}
              </StatusBadge>
              <StatusBadge tone="neutral">
                Menunggu Jam Absen {ringkasan.menungguJamAbsen}
              </StatusBadge>
              <StatusBadge tone="warning">
                Terlambat {ringkasan.terlambat}
              </StatusBadge>
              <StatusBadge tone="warning">
                Jam Kerja Kurang {ringkasan.jamKerjaKurang}
              </StatusBadge>
              <StatusBadge tone="neutral">
                Koreksi Admin {ringkasan.koreksiAdmin}
              </StatusBadge>
              <StatusBadge tone="neutral">
                Shift Fleksibel {ringkasan.fleksibel}
              </StatusBadge>
              {ringkasan.menungguJamAbsen > 0 ? (
                <StatusBadge tone="neutral">
                  Menunggu Jam Absen {ringkasan.menungguJamAbsen}
                </StatusBadge>
              ) : null}
              {ringkasan.tanpaData > 0 ? (
                <StatusBadge tone="danger">
                  Tanpa Data {ringkasan.tanpaData}
                </StatusBadge>
              ) : null}
              {ringkasan.shiftTidakValid > 0 ? (
                <StatusBadge tone="danger">
                  Shift Tidak Valid {ringkasan.shiftTidakValid}
                </StatusBadge>
              ) : null}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                Daftar Temuan ({temuanTampil.length})
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="audit-cari">
                  Cari nama, ID, divisi, atau kategori temuan
                </label>
                <input
                  id="audit-cari"
                  type="search"
                  value={pencarian}
                  onChange={(event) => setPencarian(event.target.value)}
                  placeholder="Cari nama / divisi / kategori..."
                  className="min-h-10 w-56 rounded-xl border border-slate-800 bg-slate-950 px-3 text-sm text-white outline-none focus:border-amber-500"
                />
                <div className="flex flex-wrap gap-1.5">
                  {FILTER_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFilter(option.value)}
                      className={`min-h-8 rounded-lg border px-2.5 text-[11px] font-bold transition ${
                        filter === option.value
                          ? "border-sky-400/40 bg-sky-500/20 text-sky-200"
                          : "border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {temuanTampil.length === 0 ? (
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-6 text-center text-sm text-emerald-200">
                <Icon name="check" className="mx-auto mb-2 size-6" />
                {audit.temuan.length === 0
                  ? "Tidak ada temuan. Data absensi tanggal ini bersih."
                  : "Tidak ada temuan yang cocok dengan filter/pencarian ini."}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-white/10">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-slate-900/80 text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Karyawan</th>
                      <th className="px-4 py-3">Shift</th>
                      <th className="px-4 py-3">Temuan</th>
                      <th className="px-4 py-3">Keterangan</th>
                      <th className="px-4 py-3">Masuk / Pulang</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {temuanTampil.map((item) => (
                      <tr
                        key={`${item.idKaryawan}-${item.kategori}`}
                        className="align-top hover:bg-white/5"
                      >
                        <td className="px-4 py-3">
                          <div className="font-bold text-white">
                            {item.nama}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {item.idKaryawan} &middot; {item.divisi}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          <div>{item.namaShift}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {item.jamShift}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge tone={KEPARAHAN_TONE[item.keparahan]}>
                            {item.kategori}
                          </StatusBadge>
                          <div className="mt-1 text-[11px] text-slate-500">
                            {KEPARAHAN_LABEL[item.keparahan]}
                          </div>
                        </td>
                        <td className="max-w-md px-4 py-3 text-slate-300">
                          {item.detail}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-300">
                          {item.jamMasuk || "--:--"} /{" "}
                          {item.jamPulang || "--:--"}
                          {item.sumber ? (
                            <div className="mt-1 font-sans text-[11px] text-slate-500">
                              {item.sumber}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {audit.logAudit.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                Log Audit Tanggal Ini
              </h2>
              <div className="space-y-2">
                {audit.logAudit.map((log) => (
                  <div
                    key={`${log.waktu}-${log.jenis}-${log.nama}`}
                    className="flex flex-wrap items-start gap-3 rounded-xl border border-white/10 bg-slate-950/60 p-3 text-xs"
                  >
                    <span className="font-mono text-slate-500">
                      {log.waktu}
                    </span>
                    <StatusBadge
                      tone={log.status === "Gagal" ? "danger" : "neutral"}
                    >
                      {log.jenis}
                    </StatusBadge>
                    <span className="font-semibold text-slate-200">
                      {log.nama || "-"}
                    </span>
                    <span className="min-w-0 flex-1 text-slate-400">
                      {log.detail}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
