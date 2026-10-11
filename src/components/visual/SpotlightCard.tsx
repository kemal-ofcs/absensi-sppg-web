"use client";

import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import type { PointerEvent, ReactNode } from "react";
import { useMotionEnabled } from "@/lib/stores/visual-store";
import { cn } from "@/lib/visual/cn";

interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  /** Radius sorotan dalam piksel. */
  radius?: number;
  /** Warna sorotan; default memakai token tema aplikasi. */
  glow?: string;
}

/**
 * Kartu dengan sorotan lembut yang mengikuti kursor.
 *
 * Posisi kursor disimpan sebagai motion value, bukan React state, sehingga
 * gerakan mouse tidak memicu satupun render ulang — hanya satu properti
 * `background` yang diperbarui di luar siklus React.
 */
export function SpotlightCard({
  children,
  className,
  radius = 320,
  glow = "var(--visual-spotlight)",
}: SpotlightCardProps) {
  const pointerX = useMotionValue(-radius);
  const pointerY = useMotionValue(-radius);
  const prefersReducedMotion = useReducedMotion();
  const motionEnabled = useMotionEnabled();
  const interactive = motionEnabled && !prefersReducedMotion;

  const background = useMotionTemplate`radial-gradient(${radius}px circle at ${pointerX}px ${pointerY}px, ${glow}, transparent 72%)`;

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerX.set(event.clientX - bounds.left);
    pointerY.set(event.clientY - bounds.top);
  };

  const handlePointerLeave = () => {
    pointerX.set(-radius);
    pointerY.set(-radius);
  };

  return (
    <div
      className={cn("visual-spotlight-card group", className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {interactive ? (
        <motion.span
          aria-hidden="true"
          className="visual-spotlight-card__glow"
          style={{ background }}
        />
      ) : null}
      <div className="visual-spotlight-card__content">{children}</div>
    </div>
  );
}
