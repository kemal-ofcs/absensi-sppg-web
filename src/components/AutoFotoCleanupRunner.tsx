"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { bersihkanFotoLama } from "@/lib/gateways/driver";

const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Masa simpan foto laporan perjalanan 90 hari (PRD §6.3): menghapus foto yang
 * lebih tua dari itu di salinan lokal perangkat dan di cloud. Batasnya jam
 * database, jadi beberapa sesi yang berjalan bersamaan hasilnya sama.
 */
export function AutoFotoCleanupRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return;

    const jalankan = async () => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await bersihkanFotoLama();
      } catch (error) {
        console.warn(
          "[AutoFotoCleanupRunner] Penghapusan foto lama gagal:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        isRunningRef.current = false;
      }
    };

    const initialTimer = setTimeout(() => void jalankan(), 60_000);
    const intervalTimer = setInterval(() => void jalankan(), INTERVAL_MS);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [isAuthenticated]);

  return null;
}
