"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { isDesktopSyncAvailable, syncNow } from "@/lib/gateways/sync-status";

const AUTO_SYNC_INTERVAL_MS = 30 * 1000; // 30 detik untuk sync background real-time

export function AutoSyncRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);
  const lastSyncTimeRef = useRef(0);

  useEffect(() => {
    if (!isAuthenticated || !isDesktopSyncAvailable()) return;

    const runAutoSync = async () => {
      if (document.visibilityState !== "visible") return;
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        const result = await syncNow();
        lastSyncTimeRef.current = Date.now();
        if (result) {
          window.dispatchEvent(
            new CustomEvent("sppg:sync-completed", { detail: result }),
          );
        }
      } catch {
        // Silently catch background errors agar tidak mengganggu aktivitas user
      } finally {
        isRunningRef.current = false;
      }
    };

    // Initial sync 3 detik setelah aplikasi terbuka
    const initialTimer = setTimeout(() => {
      void runAutoSync();
    }, 3_000);

    // Periodic sync setiap 30 detik
    const intervalTimer = setInterval(() => {
      void runAutoSync();
    }, AUTO_SYNC_INTERVAL_MS);

    // Sinkronisasi instan saat user kembali ke window/tab (dithrottle min 15 detik)
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastSyncTimeRef.current >= 15_000
      ) {
        void runAutoSync();
      }
    };
    const onFocus = () => {
      if (Date.now() - lastSyncTimeRef.current >= 15_000) {
        void runAutoSync();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [isAuthenticated]);

  return null;
}
