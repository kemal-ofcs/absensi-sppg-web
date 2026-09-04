"use client";

import { useSyncExternalStore } from "react";
import { BRANDING } from "@/lib/constants/branding";
import { getCompanyProfile } from "@/lib/gateways/company-profile";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";

/**
 * Cermin lokal nama perusahaan untuk tampilan UI tanpa delay.
 *
 * SUMBER KEBENARAN nama adalah `company_profile.company_name` yang ikut
 * snapshot sinkronisasi Turso. Cache localStorage hanya cermin display —
 * bukan sumber kebenaran data bisnis.
 *
 * Pola identik dengan useAppLogo.ts yang sudah teruji.
 */
const COMPANY_NAME_CACHE_KEY = "company_branding_name";
const COMPANY_NAME_EVENT = "company-attendance:branding-change";

const listeners = new Set<() => void>();

let snapshot: string = BRANDING.defaultCompanyName;
let snapshotLoaded = false;
let refreshInFlight = false;

function emit() {
  for (const listener of listeners) listener();
}

function readCache(): string {
  try {
    const cached = localStorage.getItem(COMPANY_NAME_CACHE_KEY);
    return cached?.trim() || BRANDING.defaultCompanyName;
  } catch {
    return BRANDING.defaultCompanyName;
  }
}

function writeCache(name: string | null) {
  try {
    if (name?.trim()) {
      localStorage.setItem(COMPANY_NAME_CACHE_KEY, name.trim());
    } else {
      localStorage.removeItem(COMPANY_NAME_CACHE_KEY);
    }
  } catch {
    // Kuota penyimpanan penuh. Cache boleh gagal — profil tetap sumber kebenaran.
  }
}

function setSnapshot(name: string) {
  snapshotLoaded = true;
  const next = name?.trim() || BRANDING.defaultCompanyName;
  if (snapshot === next) return;
  snapshot = next;
  emit();
}

/** Tarik ulang nama instansi dari profil perusahaan (yang sudah tersinkron). */
function refreshFromProfile() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  getCompanyProfile()
    .then((profile) => {
      const next = profile.company_name?.trim() || BRANDING.defaultCompanyName;
      writeCache(next);
      setSnapshot(next);
    })
    .catch(() => {
      // Offline atau profil belum siap: biarkan cermin lokal yang tampil.
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

function subscribeToCompanyName(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === COMPANY_NAME_CACHE_KEY) {
      setSnapshot(readCache());
    }
  };
  const handleLocalChange = () => setSnapshot(readCache());

  window.addEventListener("storage", handleStorage);
  window.addEventListener(COMPANY_NAME_EVENT, handleLocalChange);
  // Snapshot sync bisa membawa nama baru dari perangkat lain.
  window.addEventListener(SYNC_COMPLETED_EVENT, refreshFromProfile);

  refreshFromProfile();

  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(COMPANY_NAME_EVENT, handleLocalChange);
    window.removeEventListener(SYNC_COMPLETED_EVENT, refreshFromProfile);
  };
}

function getCompanyNameSnapshot(): string {
  if (!snapshotLoaded) {
    snapshot = readCache();
    snapshotLoaded = true;
  }
  return snapshot;
}

/** Hook untuk mendapatkan nama perusahaan secara reaktif (0ms cold start). */
export function useCompanyName(): string {
  return useSyncExternalStore(
    subscribeToCompanyName,
    getCompanyNameSnapshot,
    () => BRANDING.defaultCompanyName,
  );
}

/**
 * Perbarui cermin lokal setelah nama berhasil disimpan ke `company_profile`.
 *
 * Ini BUKAN jalur penyimpanan — pemanggil wajib sudah memanggil
 * `updateCompanyProfile` supaya nama masuk outbox dan terkirim ke cloud.
 * Dipanggil berdampingan dengan `syncAppLogoCache` di handleCompanyProfileSubmit.
 */
export function syncCompanyNameCache(name: string | null) {
  const resolved = name?.trim() || BRANDING.defaultCompanyName;
  writeCache(resolved);
  setSnapshot(resolved);
  window.dispatchEvent(new Event(COMPANY_NAME_EVENT));
}
