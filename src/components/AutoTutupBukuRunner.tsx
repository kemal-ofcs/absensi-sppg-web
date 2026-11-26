"use client";

import { useEffect, useRef } from "react";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { jalankanPemberitahuanTutupBuku } from "@/lib/gateways/accounting";

const INTERVAL_MS = 30 * 60 * 1000;

/**
 * Memeriksa tiap 30 menit apakah saldo periode yang sudah ditutup berubah,
 * lalu mencatatnya ke antrean Telegram Keuangan. Pengirimannya tetap oleh
 * `AutoTelegramRunner`.
 *
 * Hanya di sesi pemegang `accounting.view`, karena pemeriksaannya menghitung
 * neraca. Backend yang memutuskan apakah Telegram siap dan menjaga agar tidak
 * ganda (id deterministik).
 */
export function AutoTutupBukuRunner() {
  const { isAuthenticated, user } = useAuth();
  const boleh = isAuthenticated && hasPermission(user, "accounting.view");
  const isRunningRef = useRef(false);
  const pesanTerakhirRef = useRef("");

  useEffect(() => {
    if (!boleh) return;

    const jalankan = async () => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await jalankanPemberitahuanTutupBuku();
        pesanTerakhirRef.current = "";
      } catch (error) {
        // Dicatat sekali per pesan berbeda, tidak ke layar.
        const pesan = error instanceof Error ? error.message : String(error);
        if (pesan !== pesanTerakhirRef.current) {
          pesanTerakhirRef.current = pesan;
          console.warn("[AutoTutupBukuRunner] Pemeriksaan gagal:", pesan);
        }
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
  }, [boleh]);

  return null;
}
