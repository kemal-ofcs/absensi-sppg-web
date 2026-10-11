"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useVisualStore } from "@/lib/stores/visual-store";
import {
  type DeviceProfile,
  readDeviceProfile,
} from "@/lib/visual/device-profile";
import type { VisualTier } from "@/lib/visual/gpu-tier";

const TIER_LABEL: Record<VisualTier, string> = {
  high: "Tinggi",
  medium: "Sedang",
  low: "Rendah",
  off: "Mati",
};

const TIER_TONE: Record<VisualTier, string> = {
  high: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  medium: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  low: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  off: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};

/** Menjelaskan dengan kalimat biasa kenapa tier tertentu yang dipilih. */
function explainTier(profile: DeviceProfile): string {
  if (!profile.webglAvailable) {
    return "Perangkat ini tidak menyediakan akselerasi WebGL, jadi efek 3D dimatikan dan aplikasi memakai animasi ringan saja.";
  }
  if (profile.reducedMotion) {
    return "Sistem operasi meminta pengurangan gerak, jadi animasi dihentikan mengikuti preferensi aksesibilitas Anda.";
  }
  switch (profile.detectedTier) {
    case "high":
      return "Perangkat ini sanggup menjalankan seluruh efek, termasuk scene 3D pada halaman login.";
    case "medium":
      return "Perangkat ini menjalankan efek ringan tanpa bayangan dan partikel berat agar tetap lancar.";
    default:
      return "Kemampuan grafis perangkat ini terbatas, jadi efek 3D dilewati supaya aplikasi tetap responsif.";
  }
}

/**
 * Kartu hasil pembacaan perangkat.
 *
 * Aplikasi tidak pernah menebak kemampuan perangkat: nilai di bawah ini
 * dibaca langsung dari mesin yang sedang dipakai, dan hasilnyalah yang
 * menentukan tier visual bawaan. Seluruh pembacaan bersifat lokal.
 */
export function DeviceProfileCard() {
  const isHydrated = useHydrated();
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const detected = useVisualStore((state) => state.detected);

  const refresh = useCallback(() => {
    setProfile(readDeviceProfile());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isHydrated || !profile) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
        <p className="text-xs text-slate-400">Membaca kemampuan perangkat...</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-200">
            Perangkat terdeteksi otomatis
          </p>
          <p className="mt-1 max-w-xl text-[11px] leading-5 text-slate-400">
            {explainTier(profile)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${TIER_TONE[detected]}`}
          >
            Tier {TIER_LABEL[detected]}
          </span>
          <button
            className="grid size-8 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            onClick={refresh}
            title="Periksa ulang perangkat"
            type="button"
          >
            <Icon className="size-4" name="refresh" />
          </button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {profile.entries.map((entry) => (
          <div
            className="flex items-center justify-between gap-3 border-b border-white/5 py-2 last:border-b-0"
            key={entry.label}
            title={entry.hint}
          >
            <dt className="shrink-0 text-[11px] text-slate-400">
              {entry.label}
            </dt>
            <dd className="min-w-0 truncate text-right text-[11px] font-bold text-slate-100">
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-[10px] leading-4 text-slate-500">
        Dibaca langsung dari perangkat ini tanpa koneksi internet, dan tidak
        ikut disinkronkan ke cloud.
      </p>
    </div>
  );
}
