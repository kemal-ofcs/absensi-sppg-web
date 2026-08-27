"use client";

import { useEffect } from "react";
import {
  getSyncStatus,
  isDesktopSyncAvailable,
  requestSyncNow,
  SYNC_COMPLETED_EVENT,
  SYNC_FAILED_EVENT,
  type SyncStatus,
} from "@/lib/gateways/sync-status";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useOnlineStatus } from "@/lib/hooks/useOnlineStatus";
import {
  type SyncPhase,
  useSyncPhase,
  useSyncPulseStore,
} from "@/lib/stores/sync-pulse-store";

/** Lama tanda "baru saja tersinkron" bertahan sebelum kembali tenang. */
const CELEBRATION_MS = 2400;

const PHASE_STYLE: Record<
  SyncPhase,
  { dot: string; pill: string; label: string }
> = {
  unknown: {
    dot: "bg-slate-400",
    pill: "border-white/10 bg-white/[0.04] text-slate-300",
    label: "Memeriksa sinkronisasi",
  },
  idle: {
    dot: "bg-emerald-400",
    pill: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    label: "Tersinkron",
  },
  syncing: {
    dot: "bg-sky-400",
    pill: "border-sky-400/30 bg-sky-400/10 text-sky-200",
    label: "Menyinkronkan",
  },
  success: {
    dot: "bg-emerald-400",
    pill: "border-emerald-400/35 bg-emerald-400/15 text-emerald-100",
    label: "Baru tersinkron",
  },
  offline: {
    dot: "bg-amber-300",
    pill: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    label: "Offline, antre lokal",
  },
  attention: {
    dot: "bg-rose-400",
    pill: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    label: "Perlu perhatian",
  },
};

/**
 * Indikator status sinkronisasi SQLite lokal ke database cloud.
 *
 * Nilainya selalu berasal dari mesin sinkronisasi yang sebenarnya
 * (`SyncStatus`, event `sppg:sync-completed` / `sppg:sync-failed`), bukan
 * animasi dekoratif yang berjalan sendiri. Tanda "berhasil" tidak akan pernah
 * muncul selagi push gagal atau antrean outbox belum kosong.
 *
 * Animasi bukan satu-satunya penyampai keadaan: warna, teks, dan `title`
 * membawa informasi yang sama, sehingga tetap terbaca saat efek visual
 * dimatikan atau pengguna meminta reduced-motion.
 */
export function SyncPulse() {
  const isHydrated = useHydrated();
  const isOnline = useOnlineStatus();
  const phase = useSyncPhase();
  const status = useSyncPulseStore((state) => state.status);
  const celebrating = useSyncPulseStore((state) => state.celebrating);
  const errorMessage = useSyncPulseStore((state) => state.errorMessage);
  const applyStatus = useSyncPulseStore((state) => state.applyStatus);
  const applyError = useSyncPulseStore((state) => state.applyError);
  const setOnline = useSyncPulseStore((state) => state.setOnline);
  const stopCelebrating = useSyncPulseStore((state) => state.stopCelebrating);

  useEffect(() => {
    setOnline(isOnline);
  }, [isOnline, setOnline]);

  // Status awal saat aplikasi dibuka, sebelum siklus pertama selesai.
  useEffect(() => {
    if (!isDesktopSyncAvailable()) return;
    let isCancelled = false;

    getSyncStatus()
      .then((initial) => {
        if (!isCancelled && initial) applyStatus(initial, false);
      })
      .catch(() => {
        // Status awal gagal dibaca bukan kondisi galat bagi pengguna:
        // siklus berikutnya akan mengisinya.
      });

    return () => {
      isCancelled = true;
    };
  }, [applyStatus]);

  useEffect(() => {
    if (!isDesktopSyncAvailable()) return;

    const handleCompleted = (event: Event) => {
      const detail = (event as CustomEvent<SyncStatus>).detail;
      if (!detail) return;
      const worthCelebrating =
        detail.changedRows > 0 && !detail.pushError && detail.pending === 0;
      applyStatus(detail, worthCelebrating);
    };

    const handleFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      applyError(detail?.message ?? "Sinkronisasi gagal tanpa keterangan.");
    };

    window.addEventListener(SYNC_COMPLETED_EVENT, handleCompleted);
    window.addEventListener(SYNC_FAILED_EVENT, handleFailed);

    return () => {
      window.removeEventListener(SYNC_COMPLETED_EVENT, handleCompleted);
      window.removeEventListener(SYNC_FAILED_EVENT, handleFailed);
    };
  }, [applyStatus, applyError]);

  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(stopCelebrating, CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [celebrating, stopCelebrating]);

  // Sebelum hidrasi selesai, markup klien dan hasil prerender wajib sama.
  if (!isHydrated || !isDesktopSyncAvailable()) return null;

  const style = PHASE_STYLE[phase];
  const queued = status ? status.pending + status.failed + status.conflict : 0;
  const detail =
    phase === "attention" && errorMessage
      ? errorMessage
      : queued > 0
        ? `${queued} perubahan menunggu terkirim`
        : "Data lokal sudah sama dengan cloud";

  return (
    <button
      className={`relative grid size-9 shrink-0 place-items-center rounded-full border transition hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${style.pill}`}
      onClick={requestSyncNow}
      title={`${style.label} — ${detail}. Klik untuk sinkronkan sekarang.`}
      aria-label={`${style.label} — ${detail}`}
      type="button"
    >
      <span
        aria-hidden="true"
        className={`visual-sync-dot size-2.5 rounded-full ${style.dot}`}
        data-phase={phase}
      />
      {queued > 0 ? (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[9px] font-bold text-white shadow-sm">
          {queued > 99 ? "99+" : queued}
        </span>
      ) : null}
    </button>
  );
}
