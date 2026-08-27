"use client";

import { useSyncExternalStore } from "react";
import { getCompanyProfile } from "@/lib/gateways/company-profile";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";

/**
 * Cermin lokal agar logo langsung tampil saat aplikasi dibuka, sebelum profil
 * perusahaan selesai dibaca.
 *
 * SUMBER KEBENARAN logo adalah `company_profile.logo_url` yang ikut snapshot
 * sinkronisasi. Versi lama menyimpan logo HANYA di `localStorage` dan
 * memprioritaskannya di atas nilai dari database, sehingga logo tidak pernah
 * sampai ke cloud maupun perangkat lain — dan perangkat yang pernah mengunggah
 * logo tidak akan pernah melihat perubahan dari perangkat lain.
 */
const APP_LOGO_CACHE_KEY = "absensi_sppg_custom_logo";
const APP_LOGO_EVENT = "absensi-sppg:logo-change";

const listeners = new Set<() => void>();

let snapshot: string | null = null;
let snapshotLoaded = false;
let refreshInFlight = false;

function emit() {
  for (const listener of listeners) listener();
}

function readCache(): string | null {
  try {
    return localStorage.getItem(APP_LOGO_CACHE_KEY);
  } catch {
    return null;
  }
}

function writeCache(logo: string | null) {
  try {
    if (logo) localStorage.setItem(APP_LOGO_CACHE_KEY, logo);
    else localStorage.removeItem(APP_LOGO_CACHE_KEY);
  } catch {
    // Kuota penyimpanan penuh. Cache boleh gagal — profil tetap sumber kebenaran.
  }
}

function setSnapshot(logo: string | null) {
  snapshotLoaded = true;
  if (snapshot === logo) return;
  snapshot = logo;
  emit();
}

/** Tarik ulang logo dari profil perusahaan (yang sudah tersinkron). */
function refreshFromProfile() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  getCompanyProfile()
    .then((profile) => {
      const next = profile.logo_url?.trim() ? profile.logo_url : null;
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

function subscribeToLogo(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_LOGO_CACHE_KEY) {
      setSnapshot(readCache());
    }
  };
  const handleLocalChange = () => setSnapshot(readCache());

  window.addEventListener("storage", handleStorage);
  window.addEventListener(APP_LOGO_EVENT, handleLocalChange);
  // Snapshot sync bisa membawa logo baru dari perangkat lain.
  window.addEventListener(SYNC_COMPLETED_EVENT, refreshFromProfile);

  refreshFromProfile();

  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(APP_LOGO_EVENT, handleLocalChange);
    window.removeEventListener(SYNC_COMPLETED_EVENT, refreshFromProfile);
  };
}

function getLogoSnapshot(): string | null {
  if (!snapshotLoaded) {
    snapshot = readCache();
    snapshotLoaded = true;
  }
  return snapshot;
}

export function useAppLogo(): string | null {
  return useSyncExternalStore(subscribeToLogo, getLogoSnapshot, () => null);
}

/**
 * Perbarui cermin lokal setelah logo berhasil disimpan ke `company_profile`.
 *
 * Ini BUKAN jalur penyimpanan — pemanggil wajib sudah memanggil
 * `updateCompanyProfile` supaya logo masuk outbox dan terkirim ke cloud.
 */
export function syncAppLogoCache(logoUrl: string | null) {
  writeCache(logoUrl);
  setSnapshot(logoUrl);
  window.dispatchEvent(new Event(APP_LOGO_EVENT));
}
