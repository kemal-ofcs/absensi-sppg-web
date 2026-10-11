"use client";

import { cn } from "@/lib/visual/cn";

interface SkeletonProps {
  className?: string;
}

/**
 * Penanda tempat saat data belum tiba.
 *
 * Dipakai menggantikan angka sementara, karena menampilkan "0" selagi data
 * masih dimuat membuat nilai kosong terbaca seperti hasil yang sebenarnya.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("visual-skeleton block rounded-lg", className)}
    />
  );
}
