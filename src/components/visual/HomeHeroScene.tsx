"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group, Mesh, Points } from "three";
import { useVisualStore, useVisualTier } from "@/lib/stores/visual-store";

/**
 * 3D Holographic Attendance Core & Orbital Gyroscope untuk Hero Home.
 *
 * Seluruh geometri dibangkitkan secara prosedural murni di memori tanpa
 * aset .glb eksternal, tanpa font/tekstur remote, dan tanpa request jaringan
 * (100% offline-first).
 *
 * Memiliki manajemen siklus hidup WebGL defensif:
 * - Pembersihan konteks WebGL otomatis pada unmount (gl.dispose + forceContextLoss).
 * - Pemantauan frame rate adaptif (auto-degrade tier jika perangkat lag > 3 detik).
 * - Penghentian render loop seketika saat tab/window disembunyikan.
 */

interface SceneColors {
  primary: string;
  accent: string;
  highlight: string;
}

const FALLBACK_COLORS: SceneColors = {
  primary: "#38bdf8",
  accent: "#f6c453",
  highlight: "#0284c7",
};

function readThemeColors(): SceneColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  try {
    const styles = window.getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue("--app-primary").trim();
    const accent = styles.getPropertyValue("--app-gold").trim();
    const highlight = styles.getPropertyValue("--app-primary-strong").trim();
    return {
      primary: primary === "" ? FALLBACK_COLORS.primary : primary,
      accent: accent === "" ? FALLBACK_COLORS.accent : accent,
      highlight: highlight === "" ? FALLBACK_COLORS.highlight : highlight,
    };
  } catch {
    return FALLBACK_COLORS;
  }
}

/** Membangkitkan titik-titik partikel data telemetry yang melayang di sekitar inti. */
function buildDataStreamPoints(count: number): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() * 0.4 - 0.2);
    const radius = 1.4 + Math.random() * 1.6;
    const height = (Math.random() - 0.5) * 2.2;

    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = height;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  return positions;
}

/** Pembersihan eksplisit konteks WebGL saat komponen di-unmount. */
function ContextCleanup() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    return () => {
      try {
        gl.dispose();
        gl.forceContextLoss();
      } catch {
        // Konteks mungkin sudah dilepas oleh browser sebelumnya.
      }
    };
  }, [gl]);

  return null;
}

/** Menurunkan tier grafis jika framerate drop berturut-turut lebih dari 3 detik. */
function AdaptiveQuality() {
  const degrade = useVisualStore((state) => state.degrade);
  const slowSeconds = useRef(0);

  useFrame((_, delta) => {
    if (delta > 1) return;
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

interface CoreElementsProps {
  colors: SceneColors;
  particleCount: number;
}

function HolographicCore({ colors, particleCount }: CoreElementsProps) {
  const mainGroupRef = useRef<Group>(null);
  const innerMeshRef = useRef<Mesh>(null);
  const ring1Ref = useRef<Mesh>(null);
  const ring2Ref = useRef<Mesh>(null);
  const ring3Ref = useRef<Mesh>(null);
  const particlesRef = useRef<Points>(null);

  const particlePositions = useMemo(
    () => buildDataStreamPoints(particleCount),
    [particleCount],
  );

  useFrame((state, delta) => {
    const group = mainGroupRef.current;
    if (!group) return;

    // Rotasi dasar konstan
    const time = state.clock.getElapsedTime();

    // Lerp halus mengikuti pergerakan kursor pengguna (pointer parallax)
    const targetRotX = state.pointer.y * 0.35 + Math.sin(time * 0.4) * 0.1;
    const targetRotY = state.pointer.x * 0.45 + time * 0.15;

    group.rotation.x += (targetRotX - group.rotation.x) * 0.05;
    group.rotation.y += (targetRotY - group.rotation.y) * 0.05;

    // Animasi komponen internal
    if (innerMeshRef.current) {
      innerMeshRef.current.rotation.y -= delta * 0.3;
      innerMeshRef.current.rotation.x += delta * 0.2;
      const pulse = 1 + Math.sin(time * 2) * 0.05;
      innerMeshRef.current.scale.set(pulse, pulse, pulse);
    }

    if (ring1Ref.current) {
      ring1Ref.current.rotation.z += delta * 0.25;
      ring1Ref.current.rotation.x += delta * 0.1;
    }

    if (ring2Ref.current) {
      ring2Ref.current.rotation.y += delta * 0.35;
      ring2Ref.current.rotation.z -= delta * 0.15;
    }

    if (ring3Ref.current) {
      ring3Ref.current.rotation.x -= delta * 0.2;
      ring3Ref.current.rotation.y += delta * 0.15;
    }

    if (particlesRef.current) {
      particlesRef.current.rotation.y += delta * 0.08;
    }
  });

  return (
    <group ref={mainGroupRef}>
      {/* 1. Inti Polihedron Hologram */}
      <mesh ref={innerMeshRef}>
        <icosahedronGeometry args={[0.85, 1]} />
        <meshBasicMaterial
          color={colors.primary}
          opacity={0.35}
          transparent
          wireframe
        />
      </mesh>

      {/* Inti Bagian Dalam Bercahaya */}
      <mesh>
        <sphereGeometry args={[0.42, 16, 16]} />
        <meshBasicMaterial color={colors.accent} opacity={0.6} transparent />
      </mesh>

      {/* 2. Cincin Orbital 1: Ekuatorial Utama (Primary Sky) */}
      <mesh ref={ring1Ref} rotation={[0.4, 0.2, 0]}>
        <torusGeometry args={[1.5, 0.012, 16, 80]} />
        <meshBasicMaterial color={colors.primary} opacity={0.8} transparent />
      </mesh>

      {/* 3. Cincin Orbital 2: Aksial Emas (Accent Gold) */}
      <mesh ref={ring2Ref} rotation={[-0.6, 0.5, 0.4]}>
        <torusGeometry args={[1.85, 0.01, 16, 80]} />
        <meshBasicMaterial color={colors.accent} opacity={0.7} transparent />
      </mesh>

      {/* 4. Cincin Orbital 3: Polar Luar (Highlight) */}
      <mesh ref={ring3Ref} rotation={[1.1, -0.3, 0.6]}>
        <torusGeometry args={[2.2, 0.008, 16, 96]} />
        <meshBasicMaterial color={colors.highlight} opacity={0.5} transparent />
      </mesh>

      {/* 5. Aliran Partikel Telemetry Presensi */}
      <points ref={particlesRef}>
        <bufferGeometry>
          <bufferAttribute
            args={[particlePositions, 3]}
            attach="attributes-position"
          />
        </bufferGeometry>
        <pointsMaterial
          color={colors.primary}
          depthWrite={false}
          opacity={0.85}
          size={0.045}
          sizeAttenuation
          transparent
        />
      </points>
    </group>
  );
}

export function HomeHeroScene() {
  const tier = useVisualTier();
  const [colors, setColors] = useState<SceneColors>(FALLBACK_COLORS);
  const [frameloop, setFrameloop] = useState<"always" | "never">("always");

  useEffect(() => {
    setColors(readThemeColors());
  }, []);

  // Jeda render saat dokumen tidak terlihat untuk menghemat daya & siklus GPU
  useEffect(() => {
    const handleVisibility = () => {
      setFrameloop(document.visibilityState === "hidden" ? "never" : "always");
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const particleCount = tier === "high" ? 180 : 70;

  return (
    <Canvas
      camera={{ position: [0, 0, 5.2], fov: 42 }}
      dpr={[1, tier === "high" ? 2 : 1.5]}
      frameloop={frameloop}
      gl={{
        alpha: true,
        antialias: tier === "high",
        powerPreference: "high-performance",
      }}
      style={{ pointerEvents: "none", width: "100%", height: "100%" }}
    >
      <ContextCleanup />
      <AdaptiveQuality />
      <HolographicCore colors={colors} particleCount={particleCount} />
    </Canvas>
  );
}
