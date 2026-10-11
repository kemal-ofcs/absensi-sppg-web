"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { triggerGenerateAlfa } from "@/lib/gateways/alfa";

const AUTO_ALFA_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function AutoAlfaRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return;

    const runAutoAlfa = async () => {
      // Skip silently if tab is hidden — don't waste CPU/network in background
      if (document.visibilityState !== "visible") return;
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await triggerGenerateAlfa();
      } catch (error) {
        // UX tidak boleh terganggu, tetapi kegagalan diam-diam membuat
        // "Alfa tidak pernah ter-generate" mustahil didiagnosis. Izin yang
        // hilang (`alfa.trigger`) muncul di sini, bukan di layar.
        console.warn("[AutoAlfaRunner] Generate Alfa otomatis gagal:", error);
      } finally {
        isRunningRef.current = false;
      }
    };

    // Initial check 10 seconds after app load (only if tab is visible)
    const initialTimer = setTimeout(() => {
      void runAutoAlfa();
    }, 10_000);

    // Periodic check every 5 minutes
    const intervalTimer = setInterval(() => {
      void runAutoAlfa();
    }, AUTO_ALFA_INTERVAL_MS);

    // When the user switches back to this tab, run immediately if overdue
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runAutoAlfa();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isAuthenticated]);

  return null;
}
