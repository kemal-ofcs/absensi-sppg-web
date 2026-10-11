"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/visual/cn";

interface FadeInProps {
  children: ReactNode;
  className?: string;
  /** Jeda mulai dalam detik, untuk efek berurutan antar kartu. */
  delaySeconds?: number;
}

/**
 * Kemunculan halus untuk blok konten.
 *
 * Sengaja memakai animasi CSS, bukan JavaScript: animasinya berjalan sejak
 * cat pertama tanpa menunggu React, hanya menyentuh `opacity` dan `transform`
 * (dikerjakan compositor), dan tidak pernah mengganti tipe elemen di tengah
 * jalan — pergantian tipe elemen akan me-remount isinya.
 *
 * Penghentian efek diatur di CSS: `prefers-reduced-motion` dan tier visual
 * `off` mematikan animasi ini tanpa perlu render ulang apapun.
 */
export function FadeIn({ children, className, delaySeconds = 0 }: FadeInProps) {
  const style: CSSProperties | undefined =
    delaySeconds > 0 ? { animationDelay: `${delaySeconds}s` } : undefined;

  return (
    <div className={cn("visual-fade-in", className)} style={style}>
      {children}
    </div>
  );
}
