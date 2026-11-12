"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { bersihkanFotoLama } from "@/lib/gateways/driver";
import { bersihkanPelamar } from "@/lib/gateways/hr-rekrutmen";

const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Masa simpan foto laporan perjalanan 90 hari (PRD §6.3): menghapus foto yang
 * lebih tua dari itu di salinan lokal perangkat dan di cloud. Juga retensi
 * data pelamar rekrutmen (PRD HRIS §22.6, Q-93), khusus cloud. Batasnya jam
 * database, jadi beberapa sesi yang berjalan bersamaan hasilnya sama. Kedua
 * pembersihan terpisah: yang satu gagal tidak menahan yang lain.
 */
export function AutoFotoCleanupRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return;

    const jalankan = async () => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      for (const [nama, kerja] of [
        ["foto lama", bersihkanFotoLama],
        ["data pelamar", bersihkanPelamar],
      ] as const) {
        try {
          await kerja();
        } catch (error) {
          console.warn(
            `[AutoFotoCleanupRunner] Penghapusan ${nama} gagal:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      isRunningRef.current = false;
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
