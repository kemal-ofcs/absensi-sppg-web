"use client";

import { create } from "zustand";
import type { SyncStatus } from "@/lib/gateways/sync-status";

/**
 * Jembatan antara mesin sinkronisasi dan lapisan visual.
 *
 * Store ini hanya menyimpan cukup informasi untuk menggambarkan KEADAAN
 * sinkronisasi — bukan data absensi, karyawan, atau payroll. Sumber
 * kebenarannya tetap `@/lib/gateways/sync-status`; di sini isinya sekadar
 * cerminan status terakhir supaya beberapa komponen bisa menampilkannya
 * tanpa masing-masing memasang listener sendiri.
 */

export type SyncPhase =
  | "unknown"
  | "idle"
  | "syncing"
  | "success"
  | "offline"
  | "attention";

interface SyncPulseState {
  status: SyncStatus | null;
  online: boolean;
  /** Benar sesaat setelah siklus yang benar-benar membawa perubahan. */
  celebrating: boolean;
  errorMessage: string | null;
  applyStatus: (status: SyncStatus, celebrate: boolean) => void;
  applyError: (message: string) => void;
  setOnline: (online: boolean) => void;
  stopCelebrating: () => void;
}

export const useSyncPulseStore = create<SyncPulseState>()((set) => ({
  status: null,
  online: true,
  celebrating: false,
  errorMessage: null,

  applyStatus: (status, celebrate) =>
    set({
      status,
      celebrating: celebrate,
      // Status baru yang bersih menghapus pesan galat siklus sebelumnya.
      errorMessage: status.pushError ?? null,
    }),

  applyError: (message) => set({ errorMessage: message, celebrating: false }),

  setOnline: (online) => set({ online }),

  stopCelebrating: () => set({ celebrating: false }),
}));

/**
 * Menerjemahkan status mentah menjadi satu fase yang bisa ditampilkan.
 *
 * Urutan pemeriksaannya disengaja: keadaan yang butuh perhatian selalu
 * menang atas keadaan "berhasil". Indikator TIDAK BOLEH menampilkan sukses
 * selagi push gagal atau antrean outbox belum kosong — indikator yang
 * berbohong soal keadaan data lebih berbahaya daripada tidak ada indikator.
 */
export function deriveSyncPhase(state: {
  status: SyncStatus | null;
  online: boolean;
  celebrating: boolean;
  errorMessage: string | null;
}): SyncPhase {
  if (!state.online) return "offline";
  if (!state.status) return state.errorMessage ? "attention" : "unknown";

  const { status } = state;
  if (
    state.errorMessage !== null ||
    status.pushError ||
    status.failed > 0 ||
    status.conflict > 0
  ) {
    return "attention";
  }
  if (status.pending > 0) return "syncing";
  if (state.celebrating) return "success";
  return "idle";
}

export function useSyncPhase(): SyncPhase {
  return useSyncPulseStore(deriveSyncPhase);
}
