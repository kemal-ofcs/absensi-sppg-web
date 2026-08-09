"use client";

import { useSyncExternalStore } from "react";

const APP_LOGO_KEY = "absensi_sppg_custom_logo";
const APP_LOGO_EVENT = "absensi-sppg:logo-change";

function subscribeToLogo(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_LOGO_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(APP_LOGO_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(APP_LOGO_EVENT, onStoreChange);
  };
}

function getLogoSnapshot() {
  return localStorage.getItem(APP_LOGO_KEY);
}

export function useAppLogo(): string | null {
  return useSyncExternalStore(subscribeToLogo, getLogoSnapshot, () => null);
}

export function saveAppLogo(logoDataUrl: string) {
  localStorage.setItem(APP_LOGO_KEY, logoDataUrl);
  window.dispatchEvent(new Event(APP_LOGO_EVENT));
}

export function resetAppLogo() {
  localStorage.removeItem(APP_LOGO_KEY);
  window.dispatchEvent(new Event(APP_LOGO_EVENT));
}
