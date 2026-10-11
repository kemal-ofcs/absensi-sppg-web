"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { useVisualTier } from "@/lib/stores/visual-store";
import { isWebGLAvailable } from "@/lib/visual/gpu-tier";

interface AttendanceGaugeProps {
  hadir: number;
  terlambat: number;
  sakitIzin: number;
  alfa: number;
  total: number;
  persentase: number;
}

const AttendanceGauge3D = dynamic(
  () =>
    import("./AttendanceGauge3D").then((mod) => ({
      default: mod.AttendanceGauge3D,
    })),
  { ssr: false },
);

function SvgDonutFallback({
  hadir,
  terlambat,
  sakitIzin,
  alfa,
  total,
  persentase,
}: AttendanceGaugeProps) {
  const tepatWaktu = Math.max(0, hadir - terlambat);
  const totalSafe = Math.max(total, 1);
  const activeTotal = tepatWaktu + terlambat + sakitIzin + alfa;
  const denominator = activeTotal > 0 ? activeTotal : totalSafe;

  const radius = 64;
  const strokeWidth = 14;
  const circumference = 2 * Math.PI * radius;

  const slices = useMemo(() => {
    const data = [
      {
        key: "hadir",
        label: "Tepat Waktu",
        count: tepatWaktu,
        color: "#0ea5e9",
        textColor: "text-sky-400",
      },
      {
        key: "terlambat",
        label: "Terlambat",
        count: terlambat,
        color: "#f59e0b",
        textColor: "text-amber-400",
      },
      {
        key: "sakitIzin",
        label: "Sakit / Izin",
        count: sakitIzin,
        color: "#8b5cf6",
        textColor: "text-purple-400",
      },
      {
        key: "alfa",
        label: "Alfa",
        count: alfa,
        color: "#f43f5e",
        textColor: "text-rose-400",
      },
    ];

    let accumulatedPercent = 0;
    return data.map((item) => {
      const pct = item.count > 0 ? item.count / denominator : 0;
      const strokeDasharray = `${pct * circumference} ${circumference}`;
      const strokeDashoffset = -(accumulatedPercent * circumference);
      accumulatedPercent += pct;

      return {
        ...item,
        pct: Math.round(pct * 100),
        strokeDasharray,
        strokeDashoffset,
      };
    });
  }, [tepatWaktu, terlambat, sakitIzin, alfa, denominator, circumference]);

  return (
    <div className="relative flex h-[240px] w-full items-center justify-center">
      <svg
        viewBox="0 0 160 160"
        className="size-48 -rotate-90 transform select-none"
        aria-label="Distribusi Kehadiran Hari Ini"
      >
        {/* Background Track */}
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.06)"
          strokeWidth={strokeWidth}
        />
        {/* Segments */}
        {slices.map((slice) =>
          slice.count > 0 ? (
            <circle
              key={slice.key}
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={strokeWidth}
              strokeDasharray={slice.strokeDasharray}
              strokeDashoffset={slice.strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-300"
              style={{ opacity: 0.95 }}
            />
          ) : null,
        )}
      </svg>

      {/* Central HUD info */}
      <div className="pointer-events-none absolute flex flex-col items-center justify-center text-center">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Tingkat Hadir
          </span>
          <div className="font-mono text-3xl font-black text-white">
            {persentase}
            <span className="text-base text-sky-400">%</span>
          </div>
          <span className="text-[10px] font-medium text-slate-400">
            {hadir} dari {total} Karyawan
          </span>
        </div>
      </div>
    </div>
  );
}

export function AttendanceGaugeGate(props: AttendanceGaugeProps) {
  const isHydrated = useHydrated();
  const tier = useVisualTier();
  const webglSupported = useMemo(
    () => (typeof window !== "undefined" ? isWebGLAvailable() : false),
    [],
  );

  if (!isHydrated) {
    return (
      <div className="flex h-[240px] w-full items-center justify-center">
        <div className="size-16 animate-pulse rounded-full border-4 border-sky-400/20" />
      </div>
    );
  }

  // Gunakan 3D jika tier high/medium dan WebGL aktif, selain itu gunakan 2D SVG
  if ((tier === "high" || tier === "medium") && webglSupported) {
    return <AttendanceGauge3D {...props} />;
  }

  return <SvgDonutFallback {...props} />;
}
