"use client";

import { create } from "zustand";
import {
  detectVisualTier,
  tierAllowsWebgl,
  type VisualTier,
} from "@/lib/visual/gpu-tier";

/**
 * Jembatan state visual antara data aplikasi dan lapisan animasi/3D.
 *
 * Store ini sengaja hanya menyimpan state tampilan. Data bisnis tetap
 * mengalir lewat `@/lib/gateways/*`; tidak ada satupun baris absensi,
 * karyawan, atau payroll yang boleh disimpan di sini.
 *
 * Tier kualitas adalah preferensi PERANGKAT, sehingga disimpan device-local
 * di localStorage dan tidak pernah ikut sinkronisasi ke cloud.
 */

const STORAGE_KEY = "sppg.visual.tier";

export type VisualPreference = VisualTier | "auto";

const VALID_PREFERENCES: readonly VisualPreference[] = [
  "auto",
  "high",
  "medium",
  "low",
  "off",
];

/** Urutan penurunan kualitas otomatis saat perangkat tidak sanggup. */
const DEGRADE_STEP: Record<VisualTier, VisualTier> = {
  high: "medium",
  medium: "low",
  low: "low",
  off: "off",
};

function readStoredPreference(): VisualPreference {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return VALID_PREFERENCES.includes(stored as VisualPreference)
      ? (stored as VisualPreference)
      : "auto";
  } catch {
    return "auto";
  }
}

function persistPreference(preference: VisualPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Penyimpanan lokal bisa ditolak (mode privat / kebijakan perangkat).
    // Preferensi tetap berlaku untuk sesi ini, cukup tidak persisten.
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface VisualState {
  /** True setelah deteksi perangkat selesai di klien. */
  ready: boolean;
  /** Hasil deteksi otomatis kemampuan perangkat. */
  detected: VisualTier;
  /** Pilihan pengguna; "auto" berarti mengikuti hasil deteksi. */
  preference: VisualPreference;
  reducedMotion: boolean;
  initialize: () => void;
  setPreference: (preference: VisualPreference) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
  /** Menurunkan satu tingkat kualitas saat frame rate tidak tercapai. */
  degrade: () => void;
  reset: () => void;
}

export const useVisualStore = create<VisualState>()((set, get) => ({
  ready: false,
  detected: "low",
  preference: "auto",
  reducedMotion: false,

  initialize: () => {
    if (get().ready) return;
    set({
      ready: true,
      detected: detectVisualTier(),
      preference: readStoredPreference(),
      reducedMotion: prefersReducedMotion(),
    });
  },

  setPreference: (preference) => {
    persistPreference(preference);
    set({ preference });
  },

  setReducedMotion: (reducedMotion) => set({ reducedMotion }),

  degrade: () => {
    const state = get();
    const current = resolveTier(state.detected, state.preference);
    const next = DEGRADE_STEP[current];
    if (next === current) return;
    persistPreference(next);
    set({ preference: next });
  },

  reset: () => set({ preference: "auto" }),
}));

function resolveTier(
  detected: VisualTier,
  preference: VisualPreference,
): VisualTier {
  return preference === "auto" ? detected : preference;
}

/** Tier efektif yang berlaku sekarang (deteksi atau pilihan pengguna). */
export function useVisualTier(): VisualTier {
  return useVisualStore((state) =>
    resolveTier(state.detected, state.preference),
  );
}

/** Animasi UI (Motion/CSS) boleh berjalan. */
export function useMotionEnabled(): boolean {
  return useVisualStore(
    (state) =>
      state.ready &&
      !state.reducedMotion &&
      resolveTier(state.detected, state.preference) !== "off",
  );
}

/** Scene WebGL boleh dimount pada perangkat ini. */
export function useWebglEnabled(): boolean {
  return useVisualStore(
    (state) =>
      state.ready &&
      !state.reducedMotion &&
      tierAllowsWebgl(resolveTier(state.detected, state.preference)),
  );
}
