"use client";

import type { Human } from "@vladmandic/human";
import {
  FACE_MODEL_ID,
  FACE_VECTOR_DIM,
  type FaceVector,
  quantizeFaceVector,
} from "@/lib/validations/face-match";

/**
 * Pengenal wajah di perangkat: `@vladmandic/human` (MIT) dengan backend WebGL.
 *
 * Tiga model dibundel di `public/models/wajah/` (blazeface, facemesh, faceres;
 * ±9 MB) supaya tetap offline — tidak ada CDN. Backend WebGL dipilih karena
 * tidak butuh WASM, jadi CSP Desktop cukup `connect-src 'self'` untuk membaca
 * berkas model dari bundelnya sendiri, tanpa `wasm-unsafe-eval`.
 *
 * Model dimuat sekali per halaman, dan kegagalannya TIDAK menahan absensi:
 * pemanggil menerima `null`, scan tetap dikirim, vonisnya `Tidak Diperiksa`.
 * Model yang ganti versi wajib ganti `FACE_MODEL_ID`, karena vektornya tidak
 * sebanding dengan vektor yang sudah terdaftar.
 */

const MODEL_PATH = "/models/wajah/";
/** Wajah di bawah keyakinan ini dianggap tidak terbaca, bukan wajah orang lain. */
const MIN_FACE_SCORE = 0.6;

let engine: Promise<Human> | null = null;

export function loadFaceEngine(): Promise<Human> {
  engine ??= (async () => {
    const { Human } = await import("@vladmandic/human");
    const human = new Human({
      backend: "webgl",
      modelBasePath: MODEL_PATH,
      debug: false,
      warmup: "none",
      // Setiap scan adalah orang yang berbeda; hasil frame sebelumnya tidak
      // boleh dipakai ulang.
      cacheSensitivity: 0,
      face: {
        enabled: true,
        detector: {
          modelPath: "blazeface.json",
          rotation: true,
          maxDetected: 1,
          minConfidence: 0.5,
        },
        mesh: { enabled: true, modelPath: "facemesh.json" },
        attention: { enabled: false },
        iris: { enabled: false },
        description: { enabled: true, modelPath: "faceres.json" },
        emotion: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false },
        gear: { enabled: false },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    });
    await human.load();
    return human;
  })().catch((error) => {
    // Gagal sekali tidak boleh membuat semua percobaan berikutnya ikut gagal.
    engine = null;
    throw error;
  });
  return engine;
}

type FaceSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

/** Vektor mentah wajah terbesar di gambar, atau `null` bila tidak terbaca. */
export async function readFaceEmbedding(
  source: FaceSource,
): Promise<number[] | null> {
  const human = await loadFaceEngine();
  const result = await human.detect(source);
  const face = [...result.face].sort(
    (a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3],
  )[0];
  if (!face || face.faceScore < MIN_FACE_SCORE) return null;
  const embedding = face.embedding;
  return embedding && embedding.length === FACE_VECTOR_DIM
    ? Array.from(embedding)
    : null;
}

/** Rata-rata beberapa sampel setelah masing-masing dinormalkan panjangnya. */
export function averageEmbeddings(samples: readonly number[][]): number[] {
  const sum = new Array<number>(FACE_VECTOR_DIM).fill(0);
  for (const sample of samples) {
    const norm = Math.hypot(...sample) || 1;
    for (let i = 0; i < FACE_VECTOR_DIM; i++) sum[i] += sample[i] / norm;
  }
  return sum.map((value) => value / Math.max(samples.length, 1));
}

export function toFaceVector(embedding: readonly number[]): FaceVector | null {
  const vektor = quantizeFaceVector(embedding);
  return vektor ? { model: FACE_MODEL_ID, vektor } : null;
}

/**
 * Vektor untuk dikirim bersama scan. Tidak pernah melempar dan dibatasi
 * waktu: wajah yang tidak terbaca atau perangkat yang lambat hanya membuat
 * scan dikirim tanpa vektor (`Tidak Diperiksa`), bukan menahan antrean.
 */
export async function scanFaceVector(
  source: FaceSource,
  timeoutMs = 4000,
): Promise<FaceVector | null> {
  try {
    const embedding = await Promise.race([
      readFaceEmbedding(source),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    return embedding ? toFaceVector(embedding) : null;
  } catch {
    return null;
  }
}
