"use client";

import { useSyncExternalStore } from "react";
import { getCompanyProfile } from "@/lib/gateways/company-profile";

const APP_LOGO_KEY = "absensi_sppg_custom_logo";
const APP_LOGO_EVENT = "absensi-sppg:logo-change";

let cachedProfileLogo: string | null = null;
let hasAttemptedFetch = false;

function subscribeToLogo(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_LOGO_KEY) {
      onStoreChange();
    }
  };

  const handleCustomEvent = () => {
    onStoreChange();
  };

  const handleSyncCompleted = () => {
    getCompanyProfile()
      .then((profile) => {
        if (profile.logo_url && profile.logo_url !== cachedProfileLogo) {
          cachedProfileLogo = profile.logo_url;
          onStoreChange();
        }
      })
      .catch(() => undefined);
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(APP_LOGO_EVENT, handleCustomEvent);
  window.addEventListener("sppg:sync-completed", handleSyncCompleted);

  // Initial fetch from company profile if localStorage is empty
  if (!hasAttemptedFetch && !localStorage.getItem(APP_LOGO_KEY)) {
    hasAttemptedFetch = true;
    getCompanyProfile()
      .then((profile) => {
        if (profile.logo_url) {
          cachedProfileLogo = profile.logo_url;
          onStoreChange();
        }
      })
      .catch(() => undefined);
  }

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(APP_LOGO_EVENT, handleCustomEvent);
    window.removeEventListener("sppg:sync-completed", handleSyncCompleted);
  };
}

function getLogoSnapshot(): string | null {
  const custom = localStorage.getItem(APP_LOGO_KEY);
  if (custom) return custom;
  return cachedProfileLogo;
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
