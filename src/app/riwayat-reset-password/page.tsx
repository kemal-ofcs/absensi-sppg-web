"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  deletePasswordResetHistory,
  getPasswordResetHistory,
  getPasswordResetPhoto,
  purgePasswordResetHistory,
} from "@/lib/gateways/password-reset-history";
import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  RESET_HISTORY_STATUS_HINT,
  RESET_HISTORY_STATUS_TONE,
  RESET_HISTORY_STATUSES,
  type ResetHistoryEntry,
  type ResetHistoryStatus,
} from "@/lib/operators/password-reset-history";

type StatusFilter = ResetHistoryStatus | "SEMUA";

const PURGE_DAYS = 90;

/**
 * Riwayat pengajuan "Lupa Password".
 *
 * Mengajukan reset terbuka untuk semua akun tanpa login — halaman ini adalah
 * sisi lainnya: siapa saja yang pernah mengajukan, kapan, dari identitas apa,
 * lolos verifikasi wajah atau tidak, dan foto wajah pemohonnya. Karena isinya
 * data pribadi, aksesnya diatur dua izin terpisah: `password_reset.view` untuk
 * melihat dan `password_reset.delete` untuk menghapus.
 */
export default function RiwayatResetPasswordPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [entries, setEntries] = useState<ResetHistoryEntry[]>([]);
  const [status, setStatus] = useState<StatusFilter>("SEMUA");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error" | "warning";
    message: string;
  } | null>(null);
  const [photo, setPhoto] = useState<{
    entry: ResetHistoryEntry;
    src: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResetHistoryEntry | null>(
    null,
  );
  const [purgeOpen, setPurgeOpen] = useState(false);

  const canDelete = hasPermission(user, "password_reset.delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await getPasswordResetHistory({ status, search }));
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Riwayat tidak dapat dimuat.",
      });
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void load();
  }, [isAuthenticated, load]);

  const openPhoto = async (entry: ResetHistoryEntry) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await getPasswordResetPhoto(entry.id);
      setPhoto({
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
      await deletePasswordResetHistory(deleteTarget.id);
      setDeleteTarget(null);
      setFeedback({
        tone: "success",
        message: `Riwayat pengajuan ${deleteTarget.operatorName} berhasil dihapus.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Riwayat tidak dapat dihapus.",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmPurge = async () => {
    setBusy(true);
    try {
      const result = await purgePasswordResetHistory(PURGE_DAYS);
      setPurgeOpen(false);
      setFeedback({
        tone: result.deleted > 0 ? "success" : "warning",
        message:
          result.deleted > 0
            ? `${result.deleted} riwayat lama berhasil dibersihkan.`
            : `Tidak ada riwayat selesai yang lebih tua dari ${PURGE_DAYS} hari.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Pembersihan riwayat gagal.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-slate-950" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "password_reset")) redirect("/forbidden");

  const withPhoto = entries.filter((entry) => entry.hasPhoto).length;

  return (
    <AppShell contentClassName="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
      <PageHeader
        eyebrow="Keamanan akun"
        title="Riwayat Reset Password"
        description="Setiap pengajuan Lupa Password tercatat di sini lengkap dengan foto verifikasi wajah pemohon, hasil uji liveness, dan status pengiriman link."
        actions={
          <StatusBadge tone={canDelete ? "warning" : "info"}>
            <Icon name={canDelete ? "tools" : "lock"} className="size-3.5" />
            {canDelete ? "Boleh hapus riwayat" : "Hanya baca"}
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
          label="Pengajuan tampil"
          value={String(entries.length)}
          hint="Sesuai filter aktif"
        />
        <SummaryTile
          label="Menyimpan foto"
          value={String(withPhoto)}
          hint="Bukti wajah tersedia"
        />
        <SummaryTile
          label="Berhasil ganti password"
          value={String(
            entries.filter((entry) => entry.status === "Terpakai").length,
          )}
          hint="Status Terpakai"
        />
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Cari akun</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cari nama, username, kode operator, atau identitas yang diketik"
              className="app-input w-full"
            />
          </label>
          <label>
            <span className="sr-only">Filter status</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as StatusFilter)
              }
              className="app-input"
            >
              <option value="SEMUA">Semua status</option>
              {RESET_HISTORY_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
        {canDelete ? (
          <button
            type="button"
            onClick={() => setPurgeOpen(true)}
            disabled={busy}
            className="min-h-11 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 text-xs font-black text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
          >
            Bersihkan riwayat &gt; {PURGE_DAYS} hari
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="app-panel grid min-h-72 place-items-center rounded-3xl text-sm text-slate-400">
          Memuat riwayat reset password...
        </div>
      ) : entries.length === 0 ? (
        <div className="app-panel grid min-h-72 place-items-center rounded-3xl p-6 text-center">
          <div className="space-y-2">
            <p className="text-base font-black text-white">
              Belum ada pengajuan
            </p>
            <p className="mx-auto max-w-md text-sm text-slate-400">
              Riwayat akan terisi begitu ada operator yang memakai tombol Lupa
              Password di halaman login.
            </p>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3">
          {entries.map((entry) => (
            <HistoryCard
              key={entry.id}
              entry={entry}
              busy={busy}
              canDelete={canDelete}
              onOpenPhoto={() => void openPhoto(entry)}
              onDelete={() => setDeleteTarget(entry)}
            />
          ))}
        </ul>
      )}

      {photo ? (
        <Modal
          title={`Foto verifikasi — ${photo.entry.operatorName}`}
          titleId="reset-photo-title"
          onClose={() => setPhoto(null)}
        >
          <div className="space-y-3">
            {/* Foto bukti disimpan sebagai base64 di database cloud, jadi
                ditampilkan lewat data URI — tidak ada permintaan jaringan
                keluar, sesuai batasan CSP Desktop. */}
            {/** biome-ignore lint/performance/noImgElement: sumbernya data URI dari database, bukan aset yang bisa dioptimalkan next/image */}
            <img
              src={photo.src}
              alt={`Wajah pemohon reset password ${photo.entry.operatorName}`}
              className="w-full rounded-2xl border border-white/10"
            />
            <dl className="grid gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm sm:grid-cols-2">
              <DetailRow
                label="Diajukan"
                value={formatTimestamp(photo.entry.requestedAt)}
              />
              <DetailRow
                label="Skor liveness"
                value={formatScore(photo.entry.livenessScore)}
              />
              <DetailRow
                label="Tantangan"
                value={
                  photo.entry.livenessChallenges.join(", ") || "Tidak tercatat"
                }
              />
              <DetailRow label="Status" value={photo.entry.status} />
            </dl>
            <p className="text-xs leading-5 text-slate-500">
              Foto ini bukan bukti identitas hukum. Verifikasi liveness menahan
              foto cetak dan layar diam, bukan rekaman video orang lain — jadi
              periksa juga kewajaran waktu dan identitas yang diketik.
            </p>
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title="Hapus riwayat pengajuan?"
          titleId="reset-delete-title"
          onClose={() => setDeleteTarget(null)}
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-300">
              Riwayat pengajuan{" "}
              <strong className="text-white">
                {deleteTarget.operatorName}
              </strong>{" "}
              beserta foto verifikasinya akan dihapus permanen.
            </p>
            {deleteTarget.status === "Terkirim" ? (
              <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
                Pengajuan ini masih hidup — link resetnya belum dipakai.
                Menghapusnya ikut mematikan link tersebut, dan pemiliknya perlu
                mengajukan Lupa Password sekali lagi.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-rose-500 px-4 text-sm font-black text-white disabled:opacity-50"
              >
                {busy ? "Menghapus..." : "Hapus permanen"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {purgeOpen ? (
        <Modal
          title="Bersihkan riwayat lama?"
          titleId="reset-purge-title"
          onClose={() => setPurgeOpen(false)}
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-300">
              Semua riwayat berstatus Terpakai, Kedaluwarsa, atau Dibatalkan
              yang lebih tua dari {PURGE_DAYS} hari akan dihapus beserta
              fotonya. Pengajuan yang masih berjalan tidak ikut terhapus.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPurgeOpen(false)}
                className="min-h-11 rounded-xl border border-white/15 px-4 text-sm font-bold text-slate-300"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void confirmPurge()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-rose-500 px-4 text-sm font-black text-white disabled:opacity-50"
              >
                {busy ? "Membersihkan..." : "Bersihkan sekarang"}
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
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function HistoryCard({
  entry,
  busy,
  canDelete,
  onOpenPhoto,
  onDelete,
}: {
  entry: ResetHistoryEntry;
  busy: boolean;
  canDelete: boolean;
  onOpenPhoto: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="app-panel rounded-3xl p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-black text-white">
              {entry.operatorName}
            </p>
            <StatusBadge tone={RESET_HISTORY_STATUS_TONE[entry.status]}>
              {entry.status}
            </StatusBadge>
          </div>
          <p className="text-xs text-slate-500">
            {entry.kodeOperator} · @{entry.username} · {entry.maskedEmail}
          </p>
          <p className="text-xs leading-5 text-slate-400">
            {RESET_HISTORY_STATUS_HINT[entry.status]}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {entry.hasPhoto ? (
            <button
              type="button"
              onClick={onOpenPhoto}
              disabled={busy}
              className="min-h-10 rounded-xl bg-sky-400 px-3.5 text-xs font-black text-slate-950 transition hover:bg-sky-300 disabled:opacity-50"
            >
              Lihat foto
            </button>
          ) : (
            <span className="min-h-10 rounded-xl border border-white/10 px-3.5 py-2.5 text-xs font-bold text-slate-500">
              Tanpa foto
            </span>
          )}
          {canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="min-h-10 rounded-xl border border-rose-400/30 px-3.5 text-xs font-black text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-50"
            >
              Hapus
            </button>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid gap-2 rounded-2xl border border-white/10 bg-slate-950/50 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <DetailRow
          label="Diajukan"
          value={formatTimestamp(entry.requestedAt)}
        />
        <DetailRow label="Diketik" value={entry.identifierUsed || "—"} />
        <DetailRow
          label="Skor liveness"
          value={formatScore(entry.livenessScore)}
        />
        <DetailRow
          label="Pengiriman"
          value={entry.deliveryStatus || "Belum dikirim"}
        />
      </dl>

      {entry.deliveryError ? (
        <p className="mt-2 rounded-xl border border-rose-400/25 bg-rose-400/10 p-2.5 text-xs text-rose-100">
          {entry.deliveryError}
        </p>
      ) : null}
      {entry.livenessReason && entry.status !== "Terpakai" ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Catatan verifikasi: {entry.livenessReason}
        </p>
      ) : null}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className="truncate font-semibold text-slate-200">{value}</dd>
    </div>
  );
}

function formatScore(score: number | null) {
  return score == null ? "Tidak dinilai" : `${Math.round(score * 100)}%`;
}

/**
 * Stempel waktu di kolom ini ditulis SQLite dalam UTC ("2026-08-29 10:15:00").
 * `new Date(...)` akan memperlakukannya sebagai waktu lokal, jadi penanda `Z`
 * ditambahkan dulu sebelum diformat ke zona pengguna.
 */
function formatTimestamp(value: string) {
  if (!value) return "—";
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
