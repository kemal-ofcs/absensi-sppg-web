"use client";

import { useEffect } from "react";
import { useVisualStore, useVisualTier } from "@/lib/stores/visual-store";

/**
 * Menyalakan lapisan visual sekali per sesi: deteksi kemampuan perangkat,
 * pemantauan `prefers-reduced-motion`, dan penandaan tier pada elemen <html>
 * agar CSS dapat menurunkan efek tanpa perlu ikut merender ulang React.
 *
 * Komponen ini tidak merender apapun.
 */
export function VisualProvider() {
  const initialize = useVisualStore((state) => state.initialize);
  const setReducedMotion = useVisualStore((state) => state.setReducedMotion);
  const ready = useVisualStore((state) => state.ready);
  const tier = useVisualTier();

  // Deteksi perangkat: sekali saja, setelah komponen benar-benar terpasang.
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Perubahan preferensi aksesibilitas sistem diikuti secara langsung.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
    };
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, [setReducedMotion]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.visualTier = tier;
  }, [ready, tier]);

  return null;
}
