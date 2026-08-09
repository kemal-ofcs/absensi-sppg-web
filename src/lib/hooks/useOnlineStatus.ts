"use client";

import { useSyncExternalStore } from "react";

function subscribeToNetworkStatus(onStoreChange: () => void) {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);

  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

function getNetworkSnapshot() {
  return navigator.onLine;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeToNetworkStatus,
    getNetworkSnapshot,
    () => true,
  );
}
