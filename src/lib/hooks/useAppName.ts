"use client";

import { useSyncExternalStore } from "react";
import { BRANDING } from "@/lib/constants/branding";
import { getAppDisplayName } from "@/lib/gateways/app-setting";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";

/**
 * Cermin lokal nama tampilan aplikasi untuk render UI 0ms tanpa delay.
 *
 * SUMBER KEBENARAN nama aplikasi adalah `setting_gex_system` dengan kunci
 * `app_display_name` yang ikut snapshot sinkronisasi Turso. Cache localStorage
 * hanya cermin display instan saat cold-start.
 */
const APP_NAME_CACHE_KEY = "app_branding_display_name";
const APP_NAME_EVENT = "app-attendance:branding-name-change";

const listeners = new Set<() => void>();

let snapshot: string = BRANDING.appDisplayName;
let snapshotLoaded = false;
let refreshInFlight = false;

function emit() {
  for (const listener of listeners) listener();
}

function readCache(): string {
  try {
    const cached = localStorage.getItem(APP_NAME_CACHE_KEY);
    return cached?.trim() || BRANDING.appDisplayName;
  } catch {
    return BRANDING.appDisplayName;
  }
}

function writeCache(name: string | null) {
  try {
    if (name?.trim()) {
      localStorage.setItem(APP_NAME_CACHE_KEY, name.trim());
    } else {
      localStorage.removeItem(APP_NAME_CACHE_KEY);
    }
  } catch {
    // Kuota penyimpanan penuh. Cache boleh gagal — setting DB tetap sumber kebenaran.
  }
}

function setSnapshot(name: string) {
  snapshotLoaded = true;
  const next = name?.trim() || BRANDING.appDisplayName;
  if (snapshot === next) return;
  snapshot = next;
  emit();
}

/** Tarik ulang nama aplikasi dari pengaturan database (yang sudah tersinkron). */
function refreshFromSetting() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  getAppDisplayName()
    .then((name) => {
      const next = name?.trim() || BRANDING.appDisplayName;
      writeCache(next);
      setSnapshot(next);
    })
    .catch(() => {
      // Offline atau setting belum siap: biarkan cermin lokal yang tampil.
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

function subscribeToAppName(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_NAME_CACHE_KEY) {
      setSnapshot(readCache());
    }
  };
  const handleLocalChange = () => setSnapshot(readCache());

  window.addEventListener("storage", handleStorage);
  window.addEventListener(APP_NAME_EVENT, handleLocalChange);
  // Snapshot sync bisa membawa nama aplikasi baru dari perangkat lain.
  window.addEventListener(SYNC_COMPLETED_EVENT, refreshFromSetting);

  refreshFromSetting();

  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(APP_NAME_EVENT, handleLocalChange);
    window.removeEventListener(SYNC_COMPLETED_EVENT, refreshFromSetting);
  };
}

function getAppNameSnapshot(): string {
  if (!snapshotLoaded) {
    snapshot = readCache();
    snapshotLoaded = true;
  }
  return snapshot;
}

/** Hook untuk mendapatkan nama tampilan aplikasi secara reaktif (0ms cold start). */
export function useAppName(): string {
  return useSyncExternalStore(
    subscribeToAppName,
    getAppNameSnapshot,
    () => BRANDING.appDisplayName,
  );
}

/**
 * Perbarui cermin lokal setelah nama berhasil disimpan ke `setting_gex_system`.
 */
export function syncAppNameCache(name: string | null) {
  const resolved = name?.trim() || BRANDING.appDisplayName;
  writeCache(resolved);
  setSnapshot(resolved);
  window.dispatchEvent(new Event(APP_NAME_EVENT));
}
