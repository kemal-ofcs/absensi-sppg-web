"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/context/AuthContext";
import { drainTelegramGateway } from "@/lib/gateways/telegram";

const INTERVAL_MS = 60 * 1000;

/**
 * Menjalankan pengirim notifikasi Telegram tiap menit selama aplikasi terbuka.
 *
 * Berjalan untuk SETIAP sesi yang login: apa yang dikirim dan ke grup mana
 * diatur Superadmin, dan pengirimnya sendiri berhenti di langkah pertama bila
 * Telegram belum aktif. Beberapa sesi aman berjalan bersamaan: kejadian dicatat
 * dengan id deterministik dan setiap baris antrean diklaim atomik.
 */
export function AutoTelegramRunner() {
  const { isAuthenticated } = useAuth();
  const isRunningRef = useRef(false);
  const pesanTerakhirRef = useRef("");

  useEffect(() => {
    if (!isAuthenticated) return;

    const jalankan = async () => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      try {
        await drainTelegramGateway();
        pesanTerakhirRef.current = "";
      } catch (error) {
        // Dicatat sekali per pesan berbeda supaya kegagalan yang sama (mis.
        // database belum diatur) tidak memenuhi konsol setiap menit.
        const pesan = error instanceof Error ? error.message : String(error);
        if (pesan !== pesanTerakhirRef.current) {
          pesanTerakhirRef.current = pesan;
          console.warn("[AutoTelegramRunner] Pengiriman gagal:", pesan);
        }
      } finally {
        isRunningRef.current = false;
      }
    };

    const initialTimer = setTimeout(() => void jalankan(), 20_000);
    const intervalTimer = setInterval(() => void jalankan(), INTERVAL_MS);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [isAuthenticated]);

  return null;
}
