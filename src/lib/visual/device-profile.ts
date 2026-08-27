"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { probeHardware, tierFromProbe, type VisualTier } from "./gpu-tier";

/**
 * Ringkasan kemampuan perangkat yang sedang menjalankan aplikasi.
 *
 * Seluruh nilainya dibaca langsung dari perangkat saat halaman dibuka:
 * tidak ada permintaan jaringan, tidak ada izin yang diminta ke pengguna,
 * dan tidak ada satupun nilai yang dikirim keluar atau ikut sinkronisasi.
 * Informasi ini murni untuk menjelaskan kenapa tier visual tertentu dipilih.
 */

export interface DeviceProfileEntry {
  label: string;
  value: string;
  /** Keterangan singkat, ditampilkan sebagai tooltip. */
  hint?: string;
}

export interface DeviceProfile {
  detectedTier: VisualTier;
  webglAvailable: boolean;
  reducedMotion: boolean;
  entries: DeviceProfileEntry[];
}

interface UserAgentData {
  platform?: string;
}

interface NavigatorWithUaData extends Navigator {
  userAgentData?: UserAgentData;
}

const UNKNOWN = "Tidak terdeteksi";

/** Nama sistem operasi, tanpa menyentuh string user agent yang panjang. */
function readPlatform(): string {
  if (typeof navigator === "undefined") return UNKNOWN;

  const uaData = (navigator as NavigatorWithUaData).userAgentData;
  if (uaData?.platform) return uaData.platform;

  const agent = navigator.userAgent;
  if (agent.includes("Windows NT 10.0")) return "Windows 10 / 11";
  if (agent.includes("Windows")) return "Windows";
  if (agent.includes("Mac OS X")) return "macOS";
  if (agent.includes("Linux")) return "Linux";
  return UNKNOWN;
}

/**
 * Memendekkan nama GPU panjang dari driver menjadi bagian yang berguna.
 * Contoh: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * menjadi "NVIDIA GeForce RTX 3050".
 */
export function shortenGpuName(raw: string): string {
  if (raw === "") return UNKNOWN;

  const angleMatch = raw.match(/^ANGLE\s*\(([^)]*)\)$/i);
  const inner = angleMatch ? angleMatch[1] : raw;
  const segments = inner.split(",").map((part) => part.trim());
  const candidate =
    segments.length > 1 ? (segments[1] ?? segments[0]) : segments[0];

  return (candidate ?? raw)
    .replace(/\s+(Direct3D|OpenGL|Vulkan|D3D)\S*/gi, "")
    .replace(/\s+(vs|ps)_\d+_\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Membaca profil perangkat. Aman dipanggil hanya setelah komponen terpasang. */
export function readDeviceProfile(): DeviceProfile {
  const probe = probeHardware();
  const tier = tierFromProbe(probe);

  const graphics =
    probe.webgl === "webgl2"
      ? "WebGL 2"
      : probe.webgl === "webgl1"
        ? "WebGL 1"
        : "Tidak tersedia";

  const screen =
    typeof window === "undefined"
      ? UNKNOWN
      : `${window.screen.width} x ${window.screen.height}`;

  const pixelRatio =
    typeof window === "undefined"
      ? UNKNOWN
      : `${Math.round(window.devicePixelRatio * 100) / 100}x`;

  const entries: DeviceProfileEntry[] = [
    {
      label: "Mode aplikasi",
      value: isDesktopRuntime() ? "Desktop (Tauri)" : "Web Browser",
      hint: "Menentukan apakah data diambil lewat Rust IPC atau route handler",
    },
    { label: "Sistem operasi", value: readPlatform() },
    {
      label: "Kartu grafis",
      value: shortenGpuName(probe.renderer),
      hint: probe.renderer === "" ? undefined : probe.renderer,
    },
    {
      label: "Vendor grafis",
      value: probe.vendor === "" ? UNKNOWN : probe.vendor,
    },
    { label: "Akselerasi", value: graphics },
    {
      label: "Thread CPU",
      value: probe.cores > 0 ? `${probe.cores} thread` : UNKNOWN,
    },
    {
      label: "Perkiraan RAM",
      value: probe.memoryGb > 0 ? `${probe.memoryGb} GB` : "Tidak dilaporkan",
      hint: "Browser hanya melaporkan angka perkiraan, bukan kapasitas persis",
    },
    { label: "Resolusi layar", value: screen },
    {
      label: "Kerapatan piksel",
      value: pixelRatio,
      hint: "Dipakai membatasi resolusi render agar tidak membebani GPU",
    },
  ];

  return {
    detectedTier: tier,
    webglAvailable: probe.webgl !== "none",
    reducedMotion: prefersReducedMotion(),
    entries,
  };
}
