"use client";

import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  useVisualStore,
  useVisualTier,
  type VisualPreference,
} from "@/lib/stores/visual-store";

const OPTIONS: ReadonlyArray<{
  value: VisualPreference;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "Otomatis",
    hint: "Mengikuti hasil deteksi kemampuan perangkat ini",
  },
  { value: "high", label: "Tinggi", hint: "Seluruh efek, termasuk scene 3D" },
  {
    value: "medium",
    label: "Sedang",
    hint: "Efek ringan, tanpa partikel berat",
  },
  { value: "low", label: "Rendah", hint: "Tanpa 3D, animasi seperlunya" },
  { value: "off", label: "Mati", hint: "Tampilan statis sepenuhnya" },
];

const TIER_LABEL: Record<string, string> = {
  high: "Tinggi",
  medium: "Sedang",
  low: "Rendah",
  off: "Mati",
};

/**
 * Pengaturan kualitas efek visual.
 *
 * Nilainya disimpan device-local di localStorage dan sengaja TIDAK ikut
 * sinkronisasi: kemampuan GPU berbeda di setiap perangkat, sehingga laptop
 * kantor tidak boleh mendikte kualitas render perangkat lain.
 */
export function VisualTierControl() {
  const isHydrated = useHydrated();
  const preference = useVisualStore((state) => state.preference);
  const detected = useVisualStore((state) => state.detected);
  const setPreference = useVisualStore((state) => state.setPreference);
  const activeTier = useVisualTier();

  return (
    <div className="app-panel rounded-2xl p-5 space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-bold text-white">Efek Visual</h3>
        <p className="text-xs text-slate-400">
          Mengatur seberapa banyak animasi dan efek 3D yang dijalankan di
          perangkat ini. Pengaturan ini hanya berlaku lokal, tidak ikut
          disinkronkan.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((option) => {
          const isActive = preference === option.value;
          return (
            <button
              className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                isActive
                  ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                  : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-600 hover:text-white"
              }`}
              key={option.value}
              onClick={() => setPreference(option.value)}
              title={option.hint}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] font-mono text-slate-500">
        {isHydrated
          ? `Deteksi perangkat: ${TIER_LABEL[detected] ?? detected} · Tier aktif: ${
              TIER_LABEL[activeTier] ?? activeTier
            }`
          : "Memeriksa kemampuan perangkat..."}
      </p>
    </div>
  );
}
