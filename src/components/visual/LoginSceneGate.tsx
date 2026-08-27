"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useWebglEnabled } from "@/lib/stores/visual-store";
import { isWebGLAvailable } from "@/lib/visual/gpu-tier";

/**
 * Scene 3D dimuat terpisah dari bundel utama dan hanya diunduh ketika
 * perangkat benar-benar akan menampilkannya. Halaman login tetap terbuka
 * seketika pada perangkat yang tidak sanggup — latar aurora CSS di
 * belakangnya sudah menjadi tampilan yang utuh, bukan ruang kosong.
 */
const LoginScene = dynamic(
  () => import("./LoginScene").then((module) => module.LoginScene),
  { ssr: false, loading: () => null },
);

interface LoginSceneGateProps {
  className?: string;
}

export function LoginSceneGate({ className }: LoginSceneGateProps) {
  const webglEnabled = useWebglEnabled();
  const [hardwareSupported, setHardwareSupported] = useState(false);

  useEffect(() => {
    setHardwareSupported(isWebGLAvailable());
  }, []);

  if (!webglEnabled || !hardwareSupported) return null;

  return (
    <div aria-hidden="true" className={className}>
      <LoginScene />
    </div>
  );
}
