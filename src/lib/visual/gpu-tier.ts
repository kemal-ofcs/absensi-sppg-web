/**
 * Deteksi kemampuan grafis perangkat tanpa satupun permintaan jaringan.
 *
 * Aplikasi ini offline-first, sehingga tier kualitas ditentukan dari probe
 * lokal (konteks WebGL, nama renderer, jumlah core, perkiraan RAM) — bukan
 * dari berkas benchmark yang perlu diunduh. Kemampuan GPU tidak pernah
 * ditebak: bila probe gagal, hasilnya turun ke tier aman, bukan naik.
 */

export type VisualTier = "high" | "medium" | "low" | "off";

/** Renderer perangkat lunak: WebGL tersedia, tetapi tanpa akselerasi nyata. */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software|basic render/i;

export interface HardwareProbe {
  webgl: "none" | "webgl1" | "webgl2";
  renderer: string;
  vendor: string;
  cores: number;
  /** Perkiraan RAM dalam GB; 0 bila browser tidak mengekspos nilainya. */
  memoryGb: number;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

function readParameter(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  parameter: number,
): string {
  const value = gl.getParameter(parameter);
  return typeof value === "string" ? value : "";
}

function readAdapter(gl: WebGLRenderingContext | WebGL2RenderingContext): {
  renderer: string;
  vendor: string;
} {
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (!debugInfo) return { renderer: "", vendor: "" };
  return {
    renderer: readParameter(gl, debugInfo.UNMASKED_RENDERER_WEBGL),
    vendor: readParameter(gl, debugInfo.UNMASKED_VENDOR_WEBGL),
  };
}

/**
 * Membuka konteks WebGL sementara, membaca kapabilitasnya, lalu segera
 * melepasnya kembali. Konteks probe tidak boleh dibiarkan hidup karena
 * jumlah konteks WebGL per halaman sangat terbatas.
 */
export function probeHardware(): HardwareProbe {
  const fallback: HardwareProbe = {
    webgl: "none",
    renderer: "",
    vendor: "",
    cores: 0,
    memoryGb: 0,
  };

  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }

  const nav = window.navigator as NavigatorWithMemory;
  const cores =
    typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : 0;
  const memoryGb = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 0;

  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  try {
    canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    gl = gl2 ?? canvas.getContext("webgl");

    if (!gl) return { ...fallback, cores, memoryGb };

    const adapter = readAdapter(gl);
    return {
      webgl: gl2 ? "webgl2" : "webgl1",
      renderer: adapter.renderer,
      vendor: adapter.vendor,
      cores,
      memoryGb,
    };
  } catch {
    return { ...fallback, cores, memoryGb };
  } finally {
    if (gl) {
      const loseContext = gl.getExtension("WEBGL_lose_context");
      loseContext?.loseContext();
    }
    canvas = null;
  }
}

/** Menerjemahkan hasil probe menjadi tier kualitas visual aplikasi. */
export function tierFromProbe(probe: HardwareProbe): VisualTier {
  if (probe.webgl === "none") return "low";
  if (probe.renderer !== "" && SOFTWARE_RENDERER.test(probe.renderer)) {
    return "low";
  }

  const manyCores = probe.cores >= 8;
  const enoughMemory = probe.memoryGb === 0 || probe.memoryGb >= 8;

  if (probe.webgl === "webgl2" && manyCores && enoughMemory) return "high";
  if (probe.cores >= 4) return "medium";
  return "low";
}

/**
 * Tier hasil deteksi otomatis. Dijalankan sekali saat aplikasi start.
 * Kegagalan apapun berakhir di `low`, tidak pernah di `high`.
 */
export function detectVisualTier(): VisualTier {
  try {
    return tierFromProbe(probeHardware());
  } catch {
    return "low";
  }
}

/** Apakah tier ini boleh membuka konteks WebGL untuk scene 3D. */
export function tierAllowsWebgl(tier: VisualTier): boolean {
  return tier === "high" || tier === "medium";
}

/** Guard WebGL nyata, dipakai tepat sebelum sebuah canvas dimount. */
export function isWebGLAvailable(): boolean {
  return probeHardware().webgl !== "none";
}
