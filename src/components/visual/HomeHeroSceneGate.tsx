"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useWebglEnabled } from "@/lib/stores/visual-store";
import { isWebGLAvailable } from "@/lib/visual/gpu-tier";

/**
 * Fallback visual berbasis CSS murni jika tier grafis rendah atau WebGL tidak tersedia.
 * Memastikan estetika tetap premium tanpa membuka konteks WebGL.
 */
function FallbackHologram() {
  return (
    <div
      aria-hidden="true"
      className="relative flex size-full items-center justify-center overflow-hidden"
    >
      <div className="absolute size-48 rounded-full border border-sky-400/20 bg-sky-400/5 animate-pulse" />
      <div className="absolute size-36 rounded-full border border-amber-300/25 bg-gradient-to-tr from-sky-500/10 to-amber-400/10" />
      <div className="absolute size-24 rounded-2xl border border-sky-400/30 bg-slate-900/60 shadow-lg shadow-sky-500/10 backdrop-blur-sm" />
      <div className="size-4 rounded-full bg-gradient-to-tr from-sky-400 to-amber-300 shadow-md shadow-sky-400/50" />
    </div>
  );
}

const HomeHeroScene = dynamic(
  () => import("./HomeHeroScene").then((module) => module.HomeHeroScene),
  {
    ssr: false,
    loading: () => <FallbackHologram />,
  },
);

interface HomeHeroSceneGateProps {
  className?: string;
}

export function HomeHeroSceneGate({ className }: HomeHeroSceneGateProps) {
  const webglEnabled = useWebglEnabled();
  const [hardwareSupported, setHardwareSupported] = useState(false);

  useEffect(() => {
    setHardwareSupported(isWebGLAvailable());
  }, []);

  const canRender3D = webglEnabled && hardwareSupported;

  return (
    <div aria-hidden="true" className={className}>
      {canRender3D ? <HomeHeroScene /> : <FallbackHologram />}
    </div>
  );
}
