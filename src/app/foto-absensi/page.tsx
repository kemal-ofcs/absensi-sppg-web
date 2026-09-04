"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { AttendancePhotoEntry } from "@/lib/attendance/photo-history";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  deleteAttendancePhotoEntry,
  getAttendancePhotoImage,
  getAttendancePhotos,
  purgeAttendancePhotoEntries,
} from "@/lib/gateways/attendance-photo";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Retensi bawaan tombol pembersihan. */
const PURGE_DAYS = 90;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatTimestamp(value: string) {
  if (!value) return "-";
  // Timestamp datang dari jam database dalam bentuk "YYYY-MM-DD HH:MM:SS".
  // Ditampilkan apa adanya: mengubahnya lewat `new Date()` akan menggesernya
  // ke zona waktu perangkat dan membuat bukti terlihat di jam yang salah.
  return value.replace("T", " ").slice(0, 19);
}

function formatSize(bytes: number) {
  if (!bytes) return "-";
  return `${Math.max(1, Math.round((bytes * 3) / 4 / 1024))} KB`;
}

/**
 * Peninjauan foto bukti absensi.
 *
 * Foto diambil terminal saat scan ketika role operatornya menyalakan sakelar
 * "Wajib foto bukti absensi" di halaman Master Operator. Sengaja TIDAK ikut
 * snapshot sync — satu foto sekitar 40 KB, dan menariknya massal akan membuat
 * setiap siklus sync berukuran puluhan megabyte di tiap perangkat. Daftar di
 * bawah dibaca langsung dari database cloud, dan isi fotonya diambil satu per
 * satu hanya ketika benar-benar dibuka.
 */
export default function FotoAbsensiPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [entries, setEntries] = useState<AttendancePhotoEntry[]>([]);
  const [tanggalMulai, setTanggalMulai] = useState(() => daysAgoIso(7));
  const [tanggalSelesai, setTanggalSelesai] = useState(() => todayIso());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error" | "warning";
    message: string;
  } | null>(null);
  const [preview, setPreview] = useState<{
    entry: AttendancePhotoEntry;
    src: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttendancePhotoEntry | null>(
    null,
  );
  const [purgeOpen, setPurgeOpen] = useState(false);

  const canDelete = hasPermission(user, "attendance_photo.delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(
        await getAttendancePhotos({ tanggalMulai, tanggalSelesai, search }),
      );
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Daftar foto absensi tidak dapat dimuat.",
      });
    } finally {
      setLoading(false);
    }
  }, [tanggalMulai, tanggalSelesai, search]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void load();
  }, [isAuthenticated, load]);

  const openPhoto = async (entry: AttendancePhotoEntry) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await getAttendancePhotoImage(entry.idFoto);
      setPreview({
        entry,
        src: `data:${result.mime};base64,${result.base64}`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Foto tidak dapat dibuka.",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteAttendancePhotoEntry(deleteTarget.idFoto);
      setDeleteTarget(null);
      setFeedback({
        tone: "success",
        message: `Foto bukti ${deleteTarget.nama} dihapus. Data absensinya sendiri tidak ikut terhapus.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Foto tidak dapat dihapus.",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmPurge = async () => {
    setBusy(true);
    try {
      const result = await purgeAttendancePhotoEntries(PURGE_DAYS);
      setPurgeOpen(false);
      setFeedback({
        tone: result.deleted > 0 ? "success" : "warning",
        message:
          result.deleted > 0
            ? `${result.deleted} foto lama dibersihkan. Rekap kehadirannya tetap utuh.`
            : `Tidak ada foto yang lebih tua dari ${PURGE_DAYS} hari.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Pembersihan foto gagal.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!isHydrated || authLoading) {
    return <div className="min-h-dvh bg-slate-950" />;
  }
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "attendance_photo")) redirect("/forbidden");

  const totalUkuran = entries.reduce(
    (sum, entry) => sum + entry.ukuranBase64,
    0,
  );

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
      <PageHeader
        eyebrow="Keamanan absensi"
        title="Foto Bukti Absensi"
        description="Foto yang diambil terminal pada saat scan, lengkap dengan alamat IP perangkat dan operator yang mengoperasikannya. Terisi otomatis untuk role yang mewajibkan foto bukti."
        actions={
          <StatusBadge tone={canDelete ? "warning" : "info"}>
            <Icon name={canDelete ? "tools" : "lock"} className="size-3.5" />
            {canDelete ? "Boleh hapus foto" : "Hanya baca"}
          </StatusBadge>
        }
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
        </FeedbackBanner>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          label="Foto tampil"
          value={String(entries.length)}
          hint="Sesuai filter aktif"
        />
        <SummaryTile
          label="Karyawan berbeda"
          value={String(new Set(entries.map((entry) => entry.idKaryawan)).size)}
          hint="Pada rentang tanggal ini"
        />
        <SummaryTile
          label="Perkiraan ukuran"
          value={formatSize(totalUkuran)}
          hint="Isi foto hanya diunduh saat dibuka"
        />
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-3">
          <label className="space-y-1.5 text-xs font-bold text-slate-300">
            Dari tanggal
            <input
              type="date"
              value={tanggalMulai}
              onChange={(event) => setTanggalMulai(event.target.value)}
              className="app-input w-full"
            />
          </label>
          <label className="space-y-1.5 text-xs font-bold text-slate-300">
            Sampai tanggal
            <input
              type="date"
              value={tanggalSelesai}
              onChange={(event) => setTanggalSelesai(event.target.value)}
              className="app-input w-full"
            />
          </label>
          <label className="space-y-1.5 text-xs font-bold text-slate-300">
            Pencarian
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nama, ID karyawan, divisi, kode operator"
              className="app-input w-full"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy}
            className="min-h-11 rounded-xl bg-sky-400/10 px-4 text-xs font-black text-sky-200 transition hover:bg-sky-400/20 disabled:opacity-50"
          >
            Muat ulang
          </button>
          {canDelete ? (
            <button
              type="button"
              onClick={() => setPurgeOpen(true)}
              disabled={busy}
              className="min-h-11 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 text-xs font-black text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
            >
              Bersihkan foto &gt; {PURGE_DAYS} hari
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="app-panel grid min-h-72 place-items-center rounded-3xl text-sm text-slate-400">
          Memuat foto bukti absensi...
        </div>
      ) : entries.length === 0 ? (
        <div className="app-panel grid min-h-72 place-items-center rounded-3xl p-6 text-center">
          <div className="space-y-2">
            <p className="text-base font-black text-white">
              Belum ada foto pada rentang ini
            </p>
            <p className="mx-auto max-w-md text-sm text-slate-400">
              Foto baru terkumpul setelah sebuah role menyalakan &ldquo;Wajib
              foto bukti absensi&rdquo; di halaman Master Operator, dan
              operatornya melakukan scan.
            </p>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3">
          {entries.map((entry) => (
            <li key={entry.idFoto}>
              <article className="app-panel rounded-3xl p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-black text-white">
                        {entry.nama || entry.idKaryawan}
                      </h2>
                      <StatusBadge
                        tone={
                          entry.jenisScan === "Masuk" ? "success" : "neutral"
                        }
                      >
                        {entry.jenisScan || "Scan"}
                      </StatusBadge>
                    </div>
                    <p className="truncate font-mono text-[11px] text-slate-400">
                      {entry.idKaryawan}
                      {entry.divisi ? ` · ${entry.divisi}` : ""}
                    </p>
                    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                      <DetailRow
                        label="Waktu scan"
                        value={formatTimestamp(entry.timestampScan)}
                      />
                      <DetailRow
                        label="Tanggal kerja"
                        value={entry.tanggalKerja || "-"}
                      />
                      <DetailRow
                        label="IP perangkat"
                        value={entry.ipPerangkat || "Tidak tercatat"}
                      />
                      <DetailRow
                        label="Operator"
                        value={entry.kodeOperator || "-"}
                      />
                    </dl>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void openPhoto(entry)}
                      disabled={busy}
                      className="min-h-10 rounded-xl bg-sky-400/10 px-4 text-xs font-black text-sky-200 transition hover:bg-sky-400/20 disabled:opacity-50"
                    >
                      Lihat foto
                    </button>
                    {canDelete ? (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(entry)}
                        disabled={busy}
                        className="min-h-10 rounded-xl bg-rose-400/10 px-4 text-xs font-black text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
                      >
                        Hapus
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      {preview ? (
        <Modal
          title={`Foto bukti — ${preview.entry.nama || preview.entry.idKaryawan}`}
          titleId="attendance-photo-title"
          onClose={() => setPreview(null)}
        >
          <div className="space-y-3">
            {/* Foto disimpan sebagai base64 di database cloud, jadi ditampilkan
                lewat data URI — tidak ada permintaan jaringan keluar, sesuai
                batasan CSP Desktop yang hari ini hanya mengizinkan `ipc:`. */}
            {/** biome-ignore lint/performance/noImgElement: sumbernya data URI dari database, bukan aset yang bisa dioptimalkan next/image */}
            <img
              src={preview.src}
              alt={`Bukti absensi ${preview.entry.nama}`}
              className="w-full rounded-2xl border border-white/10"
            />
            <dl className="grid gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm sm:grid-cols-2">
              <DetailRow
                label="Waktu scan"
                value={formatTimestamp(preview.entry.timestampScan)}
              />
              <DetailRow
                label="Jenis scan"
                value={preview.entry.jenisScan || "-"}
              />
              <DetailRow
                label="IP perangkat"
                value={preview.entry.ipPerangkat || "Tidak tercatat"}
              />
              <DetailRow
                label="Sumber"
                value={preview.entry.sumberData || "-"}
              />
              <DetailRow
                label="ID sesi absensi"
                value={preview.entry.idSesi || "-"}
              />
              <DetailRow
                label="Perangkat"
                value={preview.entry.clientId || "-"}
              />
            </dl>
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title="Hapus foto bukti"
          titleId="attendance-photo-delete-title"
          onClose={() => setDeleteTarget(null)}
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-300">
              Foto bukti milik{" "}
              <strong className="text-white">{deleteTarget.nama}</strong> pada{" "}
              {formatTimestamp(deleteTarget.timestampScan)} akan dihapus
              permanen. Baris absensi dan log scannya tetap ada — yang hilang
              hanya bukti visualnya.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-rose-500 px-5 text-sm font-black text-slate-950 disabled:opacity-60"
              >
                {busy ? "Menghapus..." : "Hapus foto"}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="min-h-11 rounded-xl border border-white/15 px-5 text-sm font-bold text-slate-300"
              >
                Batal
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {purgeOpen ? (
        <Modal
          title="Bersihkan foto lama"
          titleId="attendance-photo-purge-title"
          onClose={() => setPurgeOpen(false)}
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-300">
              Seluruh foto bukti yang tanggal kerjanya lebih dari {PURGE_DAYS}{" "}
              hari lalu akan dihapus dari database cloud. Rekap kehadiran,
              riwayat, dan laporan tidak terpengaruh.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void confirmPurge()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-rose-500 px-5 text-sm font-black text-slate-950 disabled:opacity-60"
              >
                {busy ? "Membersihkan..." : `Bersihkan > ${PURGE_DAYS} hari`}
              </button>
              <button
                type="button"
                onClick={() => setPurgeOpen(false)}
                className="min-h-11 rounded-xl border border-white/15 px-5 text-sm font-bold text-slate-300"
              >
                Batal
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="app-panel rounded-2xl p-4">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-black text-white">{value}</p>
      <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className="truncate font-mono text-xs text-slate-200">{value}</dd>
    </div>
  );
}
