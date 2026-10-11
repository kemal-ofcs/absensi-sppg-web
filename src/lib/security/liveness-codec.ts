import {
  isLivenessChallenge,
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
  type LivenessFrame,
} from "@/lib/security/face-liveness";

/**
 * Pembungkus transport untuk frame liveness.
 *
 * Frame mentah dikirim apa adanya (bukan JPEG) supaya server bisa menjalankan
 * ulang analisis piksel yang sama dengan klien. Sebuah JPEG akan memaksa server
 * melakukan decoding gambar — dan tidak ada decoder tanpa dependensi di sini.
 */
export interface LivenessFramePayload {
  challenge: string;
  offsetMs: number;
  width: number;
  height: number;
  /** RGB baris-per-baris, base64. */
  rgb: string;
}

/** Batas atas jumlah frame satu sesi; menahan payload membengkak. */
export const LIVENESS_MAX_FRAMES = 90;

const FRAME_BYTES = LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3;

export function encodeFrameBytes(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

export function decodeFrameBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeLivenessFrames(
  frames: readonly LivenessFrame[],
): LivenessFramePayload[] {
  return frames.map((frame) => ({
    challenge: frame.challenge,
    offsetMs: Math.round(frame.offsetMs),
    width: frame.width,
    height: frame.height,
    rgb: encodeFrameBytes(frame.rgb),
  }));
}

/**
 * Membaca payload klien menjadi frame yang bisa dianalisis.
 *
 * Melempar `Error` berbahasa Indonesia pada bentuk yang tidak valid alih-alih
 * mengembalikan frame setengah jadi: analisis liveness yang berjalan di atas
 * data cacat akan menghasilkan vonis yang tidak berarti.
 */
export function decodeLivenessFrames(value: unknown): LivenessFrame[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Rekaman verifikasi wajah tidak ditemukan.");
  }
  if (value.length > LIVENESS_MAX_FRAMES) {
    throw new Error("Rekaman verifikasi wajah terlalu panjang.");
  }
  return value.map((item) => {
    const entry = (item ?? {}) as Partial<LivenessFramePayload>;
    if (!isLivenessChallenge(entry.challenge)) {
      throw new Error("Tantangan verifikasi tidak dikenal.");
    }
    if (
      entry.width !== LIVENESS_FRAME_WIDTH ||
      entry.height !== LIVENESS_FRAME_HEIGHT ||
      typeof entry.rgb !== "string"
    ) {
      throw new Error("Format rekaman verifikasi tidak valid.");
    }
    let rgb: Uint8Array;
    try {
      rgb = decodeFrameBytes(entry.rgb);
    } catch {
      throw new Error("Rekaman verifikasi tidak dapat dibaca.");
    }
    if (rgb.length !== FRAME_BYTES) {
      throw new Error("Ukuran rekaman verifikasi tidak sesuai.");
    }
    return {
      challenge: entry.challenge,
      offsetMs:
        typeof entry.offsetMs === "number" && Number.isFinite(entry.offsetMs)
          ? entry.offsetMs
          : 0,
      width: LIVENESS_FRAME_WIDTH,
      height: LIVENESS_FRAME_HEIGHT,
      rgb,
    };
  });
}
