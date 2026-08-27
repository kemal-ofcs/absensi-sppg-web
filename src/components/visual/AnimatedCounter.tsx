"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useMotionEnabled } from "@/lib/stores/visual-store";

const numberFormat = new Intl.NumberFormat("id-ID");

interface AnimatedCounterProps {
  value: number;
  className?: string;
  /** Teks yang menempel setelah angka, misalnya " Orang" atau "%". */
  suffix?: string;
  durationSeconds?: number;
}

function render(value: number, suffix: string): string {
  return `${numberFormat.format(Math.round(value))}${suffix}`;
}

/**
 * Angka KPI yang berhitung naik saat data masuk.
 *
 * Nilai antara ditulis langsung ke DOM lewat ref, sehingga satu animasi
 * penuh tidak menghasilkan satupun render ulang React. Saat animasi
 * dimatikan, angka final langsung ditampilkan tanpa transisi.
 */
export function AnimatedCounter({
  value,
  className,
  suffix = "",
  durationSeconds = 0.8,
}: AnimatedCounterProps) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const previousValue = useRef(0);
  const prefersReducedMotion = useReducedMotion();
  const motionEnabled = useMotionEnabled();

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const target = Number.isFinite(value) ? value : 0;

    if (!motionEnabled || prefersReducedMotion) {
      node.textContent = render(target, suffix);
      previousValue.current = target;
      return;
    }

    const controls = animate(previousValue.current, target, {
      duration: durationSeconds,
      ease: "easeOut",
      onUpdate: (latest) => {
        node.textContent = render(latest, suffix);
      },
    });
    previousValue.current = target;

    return () => controls.stop();
  }, [value, suffix, durationSeconds, motionEnabled, prefersReducedMotion]);

  return (
    <span className={className} ref={nodeRef}>
      {render(Number.isFinite(value) ? value : 0, suffix)}
    </span>
  );
}
