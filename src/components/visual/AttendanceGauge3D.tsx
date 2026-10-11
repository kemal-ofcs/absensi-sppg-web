"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useVisualStore, useVisualTier } from "@/lib/stores/visual-store";

interface AttendanceGauge3DProps {
  hadir: number;
  terlambat: number;
  sakitIzin: number;
  alfa: number;
  total: number;
  persentase: number;
}

interface SegmentData {
  key: string;
  label: string;
  count: number;
  color: string;
  startAngle: number;
  endAngle: number;
}

function ContextCleanup() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    return () => {
      try {
        gl.dispose();
        gl.forceContextLoss();
      } catch {
        // Ignored if context already lost
      }
    };
  }, [gl]);

  return null;
}

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
    } else {
      slowSeconds.current = Math.max(0, slowSeconds.current - delta);
    }
  });

  return null;
}

function RingSegment({
  segment,
  innerRadius,
  outerRadius,
  depth,
  isHovered,
  onHover,
}: {
  segment: SegmentData;
  innerRadius: number;
  outerRadius: number;
  depth: number;
  isHovered: boolean;
  onHover: (key: string | null) => void;
}) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    const { startAngle, endAngle } = segment;
    const diff = endAngle - startAngle;

    if (diff <= 0.001) return null;

    // Outer arc
    s.absarc(0, 0, outerRadius, startAngle, endAngle, false);
    // Inner arc
    s.absarc(0, 0, innerRadius, endAngle, startAngle, true);
    s.closePath();
    return s;
  }, [segment, innerRadius, outerRadius]);

  const extrudeSettings = useMemo(
    () => ({
      depth: isHovered ? depth * 1.35 : depth,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.04,
      bevelThickness: 0.04,
    }),
    [depth, isHovered],
  );

  const geometry = useMemo(() => {
    if (!shape) return null;
    return new THREE.ExtrudeGeometry(shape, extrudeSettings);
  }, [shape, extrudeSettings]);

  useEffect(() => {
    return () => {
      if (geometry) geometry.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh
      geometry={geometry}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(segment.key);
      }}
      onPointerOut={() => onHover(null)}
      position={[0, 0, isHovered ? 0.08 : 0]}
    >
      <meshStandardMaterial
        color={segment.color}
        emissive={segment.color}
        emissiveIntensity={isHovered ? 0.45 : 0.15}
        roughness={0.25}
        metalness={0.4}
      />
    </mesh>
  );
}

function Scene({
  hadir,
  terlambat,
  sakitIzin,
  alfa,
  total,
  hoveredKey,
  setHoveredKey,
}: AttendanceGauge3DProps & {
  hoveredKey: string | null;
  setHoveredKey: (key: string | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const { invalidate } = useThree();

  const totalSafe = Math.max(total, 1);
  const segments: SegmentData[] = useMemo(() => {
    const raw = [
      {
        key: "hadir",
        label: "Tepat Waktu",
        count: Math.max(0, hadir - terlambat),
        color: "#0ea5e9",
      },
      {
        key: "terlambat",
        label: "Terlambat",
        count: terlambat,
        color: "#f59e0b",
      },
      {
        key: "sakitIzin",
        label: "Sakit / Izin",
        count: sakitIzin,
        color: "#8b5cf6",
      },
      {
        key: "alfa",
        label: "Alfa",
        count: alfa,
        color: "#f43f5e",
      },
    ];

    let currentAngle = 0;
    const items: SegmentData[] = [];

    const activeTotal = raw.reduce((sum, item) => sum + item.count, 0);
    const denominator = activeTotal > 0 ? activeTotal : totalSafe;

    for (const item of raw) {
      const proportion = item.count > 0 ? item.count / denominator : 0;
      const angleLength = proportion * (Math.PI * 2);
      const startAngle = currentAngle;
      const endAngle = currentAngle + angleLength;
      currentAngle = endAngle;

      items.push({
        ...item,
        startAngle,
        endAngle,
      });
    }

    return items;
  }, [hadir, terlambat, sakitIzin, alfa, totalSafe]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    // Subtle float
    groupRef.current.rotation.z += delta * 0.08;
    invalidate();
  });

  return (
    <>
      <ContextCleanup />
      <AdaptiveQuality />

      <ambientLight intensity={1.2} />
      <directionalLight position={[4, 6, 8]} intensity={1.8} />
      <directionalLight position={[-4, -6, -4]} intensity={0.6} />

      <group
        ref={groupRef}
        rotation={[-Math.PI / 4.2, Math.PI / 6, 0]}
        scale={0.9}
      >
        {segments.map((seg) => (
          <RingSegment
            key={seg.key}
            segment={seg}
            innerRadius={1.2}
            outerRadius={2.0}
            depth={0.45}
            isHovered={hoveredKey === seg.key}
            onHover={(key) => {
              setHoveredKey(key);
              invalidate();
            }}
          />
        ))}
      </group>
    </>
  );
}

export function AttendanceGauge3D(props: AttendanceGauge3DProps) {
  const tier = useVisualTier();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const activeSegment = useMemo(() => {
    if (!hoveredKey) return null;
    const map: Record<string, { label: string; count: number; color: string }> =
      {
        hadir: {
          label: "Tepat Waktu",
          count: Math.max(0, props.hadir - props.terlambat),
          color: "text-sky-400",
        },
        terlambat: {
          label: "Terlambat",
          count: props.terlambat,
          color: "text-amber-400",
        },
        sakitIzin: {
          label: "Sakit / Izin",
          count: props.sakitIzin,
          color: "text-purple-400",
        },
        alfa: {
          label: "Alfa",
          count: props.alfa,
          color: "text-rose-400",
        },
      };
    return map[hoveredKey] || null;
  }, [hoveredKey, props.hadir, props.terlambat, props.sakitIzin, props.alfa]);

  return (
    <div className="relative flex h-[240px] w-full items-center justify-center">
      <Canvas
        camera={{ position: [0, 0, 5.5], fov: 45 }}
        dpr={tier === "high" ? [1, 1.5] : [1, 1]}
        frameloop="demand"
        gl={{
          antialias: tier === "high",
          alpha: true,
          powerPreference: "high-performance",
        }}
        className="size-full select-none"
      >
        <Scene
          {...props}
          hoveredKey={hoveredKey}
          setHoveredKey={setHoveredKey}
        />
      </Canvas>

      {/* Central HUD info overlay */}
      <div className="pointer-events-none absolute flex flex-col items-center justify-center text-center">
        {activeSegment ? (
          <div className="animate-in fade-in zoom-in-95 duration-150">
            <span
              className={`text-xs font-black uppercase tracking-wider ${activeSegment.color}`}
            >
              {activeSegment.label}
            </span>
            <div className="font-mono text-2xl font-black text-white">
              {activeSegment.count}{" "}
              <span className="text-xs font-normal text-slate-400">Org</span>
            </div>
          </div>
        ) : (
          <div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Tingkat Hadir
            </span>
            <div className="font-mono text-3xl font-black text-white">
              {props.persentase}
              <span className="text-base text-sky-400">%</span>
            </div>
            <span className="text-[10px] font-medium text-slate-400">
              {props.hadir} dari {props.total} Karyawan
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
