"use client";

import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import type { PointerEvent, ReactNode } from "react";
import { useMotionEnabled, useVisualTier } from "@/lib/stores/visual-store";
import { cn } from "@/lib/visual/cn";

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  /** Sudut kemiringan maksimum dalam derajat. */
  maxTilt?: number;
}

const SPRING = { stiffness: 220, damping: 22, mass: 0.6 } as const;

/**
 * Kemiringan 3D halus mengikuti kursor (pseudo-3D, tanpa WebGL).
 *
 * Hanya bereaksi pada penunjuk presisi (mouse/trackpad). Pada layar sentuh
 * efek ini diam karena rotasi yang mengikuti jari justru merusak akurasi
 * ketukan.
 *
 * Struktur elemennya selalu sama, aktif maupun tidak. Saat efek dimatikan
 * kartu hanya berhenti bereaksi — bukan berganti bentuk — sehingga isinya
 * tidak pernah ter-remount ketika hasil deteksi perangkat masuk.
 */
export function TiltCard({ children, className, maxTilt = 6 }: TiltCardProps) {
  const motionEnabled = useMotionEnabled();
  const tier = useVisualTier();
  const enabled = motionEnabled && tier !== "low" && tier !== "off";

  const pointerX = useMotionValue(0.5);
  const pointerY = useMotionValue(0.5);

  const rotateX = useSpring(
    useTransform(pointerY, [0, 1], [maxTilt, -maxTilt]),
    SPRING,
  );
  const rotateY = useSpring(
    useTransform(pointerX, [0, 1], [-maxTilt, maxTilt]),
    SPRING,
  );

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.pointerType !== "mouse") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - bounds.left) / bounds.width);
    pointerY.set((event.clientY - bounds.top) / bounds.height);
  };

  const handlePointerLeave = () => {
    pointerX.set(0.5);
    pointerY.set(0.5);
  };

  return (
    <div
      className={cn("visual-tilt", className)}
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
    >
      <motion.div className="visual-tilt__inner" style={{ rotateX, rotateY }}>
        {children}
      </motion.div>
    </div>
  );
}
