"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getSyncStatus,
  isDesktopSyncAvailable,
  SYNC_COMPLETED_EVENT,
  SYNC_FAILED_EVENT,
  SYNC_REQUEST_EVENT,
  type SyncStatus,
  syncNow,
} from "@/lib/gateways/sync-status";

/** Ada antrean outbox yang menunggu terkirim: percepat siklus. */
const PENDING_INTERVAL_MS = 12_000;
/** Idle dan jendela terlihat: kadensi normal. */
const IDLE_INTERVAL_MS = 30_000;
/**
 * Jendela tersembunyi/minimize. Versi lama menghentikan sync sepenuhnya saat
 * tidak terlihat, sehingga terminal scanner yang di-minimize berhenti mengirim
 * absensi sama sekali. Sekarang tetap jalan, hanya lebih jarang.
 */
const HIDDEN_INTERVAL_MS = 90_000;
/** Backoff eksponensial saat gagal beruntun, dibatasi 5 menit. */
const BACKOFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** Jeda minimal antar siklus untuk pemicu manual (fokus, visibilitas, online). */
const TRIGGER_THROTTLE_MS = 5_000;
/** Sync pertama setelah aplikasi siap. */
const INITIAL_DELAY_MS = 1_500;

function dispatch(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function AutoSyncRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);
  const rerunRequestedRef = useRef(false);
  const lastRunAtRef = useRef(0);
  const failureStreakRef = useRef(0);
  const lastStatusRef = useRef<SyncStatus | null>(null);
  /**
   * Perangkat memakai Mode Database Lokal.
   *
   * Disemai sekali saat mount lewat `getSyncStatus()` — pembacaan lokal murni
   * yang tidak menyentuh jaringan — karena penjagaan `navigator.onLine` di
   * bawah harus sudah tahu jawabannya SEBELUM siklus pertama. Mengandalkan
   * hasil siklus saja tidak cukup: di mode lokal yang benar-benar terputus,
   * siklus pertama itulah yang justru dilewatkan.
   */
  const localModeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !isDesktopSyncAvailable()) return;

    stoppedRef.current = false;

    const nextDelay = () => {
      if (failureStreakRef.current > 0) {
        const index = Math.min(
          failureStreakRef.current - 1,
          BACKOFF_STEPS_MS.length - 1,
        );
        return BACKOFF_STEPS_MS[index];
      }
      if (document.visibilityState !== "visible") return HIDDEN_INTERVAL_MS;
      const status = lastStatusRef.current;
      if (status && status.pending + status.failed + status.conflict > 0) {
        return PENDING_INTERVAL_MS;
      }
      return IDLE_INTERVAL_MS;
    };

    const schedule = (delayMs: number) => {
      if (stoppedRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void runCycle();
      }, delayMs);
    };

    const runCycle = async () => {
      if (stoppedRef.current) return;
      // Sudah ada siklus berjalan: tandai supaya langsung diulang setelah selesai,
      // jangan menumpuk request paralel ke Rust.
      if (isRunningRef.current) {
        rerunRequestedRef.current = true;
        return;
      }
      // Offline menurut browser: tidak perlu membuang satu round-trip yang pasti
      // gagal. Event "online" akan membangunkan siklus berikutnya seketika.
      //
      // TIDAK berlaku di Mode Database Lokal. Di sana "cloud"-nya adalah berkas
      // hub di perangkat yang sama, jadi push adalah operasi berkas — bukan
      // jaringan — dan mesin yang benar-benar terputus justru kasus penggunaan
      // utamanya. Melewatkan siklus di sana membuat outbox tidak pernah
      // terkuras, hub tertinggal, lalu ekspor cadangan dan promosi ke cloud
      // (keduanya membaca hub) kehilangan data tanpa satu pun pesan error.
      if (
        !localModeRef.current &&
        typeof navigator !== "undefined" &&
        navigator.onLine === false
      ) {
        schedule(nextDelay());
        return;
      }

      isRunningRef.current = true;
      try {
        const result = await syncNow();
        lastRunAtRef.current = Date.now();
        failureStreakRef.current = 0;
        if (result) {
          const previous = lastStatusRef.current;
          lastStatusRef.current = result;
          // Provider bisa berubah tanpa aplikasi ditutup (Superadmin mengganti
          // konfigurasi database), jadi bendera ini disegarkan tiap siklus.
          localModeRef.current = result.localMode === true;
          // Hanya kabarkan bila ada yang benar-benar berubah. Banyak halaman
          // memuat ulang datanya pada event ini; memancarkannya setiap 30 detik
          // walau tidak ada perubahan berarti refetch sia-sia terus menerus.
          const queueChanged =
            !previous ||
            previous.pending !== result.pending ||
            previous.failed !== result.failed ||
            previous.conflict !== result.conflict;
          if (!previous || result.changedRows > 0 || queueChanged) {
            dispatch(SYNC_COMPLETED_EVENT, result);
          }
          // Push gagal tapi pull berhasil: siklus "berhasil sebagian".
          if (result.pushError) {
            dispatch(SYNC_FAILED_EVENT, {
              message: result.pushError,
              partial: true,
            });
          }
        }
      } catch (error) {
        lastRunAtRef.current = Date.now();
        failureStreakRef.current += 1;
        dispatch(SYNC_FAILED_EVENT, {
          message:
            error instanceof Error
              ? error.message
              : "Sinkronisasi gagal tanpa keterangan.",
          partial: false,
          attempt: failureStreakRef.current,
        });
      } finally {
        isRunningRef.current = false;
        if (rerunRequestedRef.current) {
          rerunRequestedRef.current = false;
          schedule(0);
        } else {
          schedule(nextDelay());
        }
      }
    };

    /** Pemicu di luar jadwal, dengan throttle agar tidak beruntun. */
    const trigger = (force = false) => {
      if (!force && Date.now() - lastRunAtRef.current < TRIGGER_THROTTLE_MS) {
        return;
      }
      schedule(0);
    };

    const onVisibilityChange = () => {
      // Kembali terlihat: sync segera. Menjadi tersembunyi: jadwal ulang dengan
      // kadensi latar, jangan biarkan timer cepat terus berjalan.
      if (document.visibilityState === "visible") trigger();
      else schedule(nextDelay());
    };
    const onFocus = () => trigger();
    const onOnline = () => {
      // Jaringan pulih: reset backoff supaya tidak menunggu sisa jeda panjang.
      failureStreakRef.current = 0;
      trigger(true);
    };
    const onSyncRequest = () => trigger(true);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener(SYNC_REQUEST_EVENT, onSyncRequest);

    // Baca status sekali sebelum siklus pertama: murni pembacaan lokal, tidak
    // menyentuh jaringan, dan inilah yang membuat perangkat mode lokal yang
    // terputus tetap menjalankan siklusnya.
    void getSyncStatus()
      .then((status) => {
        if (stoppedRef.current || !status) return;
        lastStatusRef.current = status;
        localModeRef.current = status.localMode === true;
      })
      .catch(() => {
        // Operator tanpa izin `sync.view` tidak bisa membaca status. Biarkan
        // bendera tetap false: perilakunya kembali seperti semula, bukan gagal.
      });

    schedule(INITIAL_DELAY_MS);

    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(SYNC_REQUEST_EVENT, onSyncRequest);
    };
  }, [isAuthenticated]);

  return null;
}
