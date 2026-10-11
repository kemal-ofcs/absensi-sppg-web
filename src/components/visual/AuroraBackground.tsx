"use client";

import { useMotionEnabled, useVisualTier } from "@/lib/stores/visual-store";

/**
 * Lapisan latar ambient di belakang seluruh aplikasi.
 *
 * Dibangun murni dari gradien CSS yang dianimasikan lewat `transform`, sehingga
 * seluruh pekerjaan dilakukan compositor GPU tanpa memicu layout atau repaint.
 * Tidak ada konteks WebGL yang dibuka di sini.
 *
 * Pada tier `off`/`low` maupun saat pengguna meminta reduced-motion, lapisan
 * ini berhenti bergerak dan menyisakan gradien statis yang tetap rapi.
 */
export function AuroraBackground() {
  const tier = useVisualTier();
  const motionEnabled = useMotionEnabled();
  const animated = motionEnabled && (tier === "high" || tier === "medium");

  return (
    <div aria-hidden="true" className="visual-aurora" data-animated={animated}>
      <span className="visual-aurora__blob visual-aurora__blob--primary" />
      <span className="visual-aurora__blob visual-aurora__blob--accent" />
      {tier === "high" ? (
        <span className="visual-aurora__blob visual-aurora__blob--gold" />
      ) : null}
      <span className="visual-aurora__grid" />
    </div>
  );
}
