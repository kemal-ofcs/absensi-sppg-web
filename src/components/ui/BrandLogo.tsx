"use client";

import Image from "next/image";
import { useAppLogo } from "@/lib/hooks/useAppLogo";

interface BrandLogoProps {
  className?: string;
  size?: number;
}

export function BrandLogo({ className = "", size = 40 }: BrandLogoProps) {
  const customLogo = useAppLogo();

  if (customLogo) {
    return (
      <span
        className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-sky-300/30 bg-slate-900/90 p-1.5 shadow-lg shadow-sky-950/20 ${className}`}
        style={{
          height: size,
          maxHeight: size,
          maxWidth: size > 60 ? size * 2.5 : Math.max(size * 2, 140),
          width: "auto",
        }}
      >
        <Image
          src={customLogo}
          alt="Logo SPPG"
          width={Math.max(size * 2, 80)}
          height={size}
          unoptimized
          className="h-full w-auto max-w-full object-contain rounded-lg"
        />
      </span>
    );
  }

  return (
    <span
      className={`grid shrink-0 place-items-center rounded-2xl border border-white/20 bg-gradient-to-br from-sky-400 via-sky-500 to-blue-700 font-black tracking-[-0.08em] text-white shadow-lg shadow-sky-950/30 ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.28) }}
    >
      SPPG
    </span>
  );
}
