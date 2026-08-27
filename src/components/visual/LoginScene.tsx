"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";
import { useVisualStore, useVisualTier } from "@/lib/stores/visual-store";

/**
 * Konstelasi data untuk latar halaman login.
 *
 * Seluruh geometri dibangkitkan secara prosedural di dalam kode — tidak ada
 * berkas `.glb`, tekstur, atau shader eksternal yang dimuat, sehingga scene
 * ini tidak melakukan satupun permintaan jaringan dan tidak membutuhkan
 * pelonggaran CSP.
 *
 * Scene hanya dimount lewat `Scene3DGate`, yang memastikan tier perangkat
 * memadai dan WebGL benar-benar tersedia.
 */

interface SceneColors {
  primary: string;
  accent: string;
}

const FALLBACK_COLORS: SceneColors = {
  primary: "#38bdf8",
  accent: "#f6c453",
};

function readThemeColors(): SceneColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  try {
    const styles = window.getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue("--app-primary").trim();
    const accent = styles.getPropertyValue("--app-gold").trim();
    return {
      primary: primary === "" ? FALLBACK_COLORS.primary : primary,
      accent: accent === "" ? FALLBACK_COLORS.accent : accent,
    };
  } catch {
    return FALLBACK_COLORS;
  }
}

/** Titik-titik tersebar merata pada permukaan bola (spiral Fibonacci). */
function buildSpherePoints(count: number, radius: number): Float32Array {
  const positions = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / Math.max(count - 1, 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = goldenAngle * index;
    const jitter = 0.92 + ((index % 7) / 7) * 0.16;

    positions[index * 3] = Math.cos(theta) * ringRadius * radius * jitter;
    positions[index * 3 + 1] = y * radius * jitter;
    positions[index * 3 + 2] = Math.sin(theta) * ringRadius * radius * jitter;
  }

  return positions;
}

/**
 * Melepas konteks WebGL secara eksplisit saat scene dilepas.
 * Konteks WebGL jumlahnya terbatas per halaman dan tidak dibersihkan
 * secepat objek JavaScript biasa.
 */
function ContextCleanup() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    return () => {
      try {
        gl.dispose();
        gl.forceContextLoss();
      } catch {
        // Konteks bisa saja sudah hilang lebih dulu; tidak ada yang perlu dibersihkan.
      }
    };
  }, [gl]);

  return null;
}

/**
 * Menurunkan tier perangkat bila frame rate tertinggal cukup lama.
 * Ambangnya sengaja longgar agar lonjakan sesaat tidak memicu penurunan.
 */
function AdaptiveQuality() {
  const degrade = useVisualStore((state) => state.degrade);
  const slowSeconds = useRef(0);

  useFrame((_, delta) => {
    if (delta > 1) return; // lompatan besar: tab baru aktif kembali
    if (delta > 1 / 30) {
      slowSeconds.current += delta;
      if (slowSeconds.current > 3) {
        slowSeconds.current = 0;
        degrade();
      }
      return;
    }
    slowSeconds.current = Math.max(slowSeconds.current - delta, 0);
  });

  return null;
}

interface ConstellationProps {
  colors: SceneColors;
  pointCount: number;
}

function Constellation({ colors, pointCount }: ConstellationProps) {
  const groupRef = useRef<Group>(null);
  const positions = useMemo(
    () => buildSpherePoints(pointCount, 2.1),
    [pointCount],
  );

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;
    group.rotation.y += delta * 0.09;
    group.rotation.x = Math.sin(group.rotation.y * 0.35) * 0.12;
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute args={[positions, 3]} attach="attributes-position" />
        </bufferGeometry>
        <pointsMaterial
          color={colors.primary}
          depthWrite={false}
          opacity={0.85}
          size={0.035}
          sizeAttenuation
          transparent
        />
      </points>

      <mesh>
        <icosahedronGeometry args={[1.45, 1]} />
        <meshBasicMaterial
          color={colors.primary}
          opacity={0.14}
          transparent
          wireframe
        />
      </mesh>

      <mesh rotation={[0.6, 0.2, 0.4]}>
        <torusGeometry args={[2.6, 0.006, 3, 96]} />
        <meshBasicMaterial color={colors.accent} opacity={0.5} transparent />
      </mesh>
    </group>
  );
}

export function LoginScene() {
  const tier = useVisualTier();
  const [colors, setColors] = useState<SceneColors>(FALLBACK_COLORS);
  const [frameloop, setFrameloop] = useState<"always" | "never">("always");

  useEffect(() => {
    setColors(readThemeColors());
  }, []);

  // Render loop berhenti total saat jendela tidak terlihat: tidak ada alasan
  // membakar GPU dan baterai untuk latar yang tidak dilihat siapapun.
  useEffect(() => {
    const handleVisibility = () => {
      setFrameloop(document.visibilityState === "hidden" ? "never" : "always");
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const pointCount = tier === "high" ? 1400 : 600;

  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 45 }}
      dpr={[1, tier === "high" ? 2 : 1.5]}
      frameloop={frameloop}
      gl={{
        alpha: true,
        antialias: tier === "high",
        powerPreference: "high-performance",
      }}
      style={{ pointerEvents: "none" }}
    >
      <ContextCleanup />
      <AdaptiveQuality />
      <Constellation colors={colors} pointCount={pointCount} />
    </Canvas>
  );
}
