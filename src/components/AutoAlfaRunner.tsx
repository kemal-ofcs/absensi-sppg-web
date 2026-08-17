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
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await triggerGenerateAlfa();
      } catch {
        // Silently catch background errors so user UX is never interrupted
      } finally {
        isRunningRef.current = false;
      }
    };

    // Initial check 10 seconds after app load
    const initialTimer = setTimeout(() => {
      void runAutoAlfa();
    }, 10000);

    // Periodic check every 5 minutes
    const intervalTimer = setInterval(() => {
      void runAutoAlfa();
    }, AUTO_ALFA_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [isAuthenticated]);

  return null;
}
