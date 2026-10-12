/**
 * Verifikasi wajah 1:1 di atas scan QR: kartu menyatakan "saya Budi", wajah
 * di kamera memastikan orangnya memang Budi.
 *
 * Kembar dengan `face_match.rs` (Desktop/Mobile) dan diuji dengan vektor yang
 * sama di `face-match.test.ts` ↔ `face_match::tests`. Vektor wajah dihitung di
 * perangkat (`client/face-engine.ts`); yang diputuskan di sini — dan di Rust —
 * hanya perbandingannya, terhadap vektor terdaftar yang dibaca dari database,
 * tidak pernah dari payload scan.
 *
 * Vektornya disimpan int8: 1024 angka × 1 byte, ±1,4 KB base64 per orang,
 * karena tabelnya ikut snapshot ke setiap perangkat. Kemiripan kosinus tidak
 * peduli skala, jadi faktor skala kuantisasi tidak perlu disimpan.
 */

/** Model yang menghasilkan vektor. Vektor dari model lain tidak sebanding. */
export const FACE_MODEL_ID = "human-faceres-v1";
export const FACE_VECTOR_DIM = 1024;

export const SCAN_FACE_VERIFY_ENABLED_KEY = "scan_face_verify_enabled";
export const SCAN_FACE_MODE_KEY = "scan_face_mode";
export const SCAN_FACE_THRESHOLD_KEY = "scan_face_threshold";

/**
 * Titik awal, bukan angka keramat: kamera dan cahaya di tiap sekolah berbeda,
 * jadi Superadmin mengkalibrasinya dari skor yang tampil di Foto Absensi.
 */
export const FACE_THRESHOLD_DEFAULT = 0.55;
export const FACE_THRESHOLD_MIN = 0.3;
export const FACE_THRESHOLD_MAX = 0.95;

export const FACE_MODES = ["pantau", "tolak"] as const;
export type FaceMode = (typeof FACE_MODES)[number];

export const FACE_VERDICTS = [
  "Cocok",
  "Tidak Cocok",
  "Belum Terdaftar",
  "Tidak Diperiksa",
] as const;
export type FaceVerdict = (typeof FACE_VERDICTS)[number];

export const FACE_TEMPLATE_SOURCES = ["kamera", "foto_profil"] as const;
export type FaceTemplateSource = (typeof FACE_TEMPLATE_SOURCES)[number];

export interface FaceVector {
  model: string;
  vektor: string;
}

/** Vektor float dari model → int8 base64. `null` bila tidak bisa dipakai. */
export function quantizeFaceVector(values: ArrayLike<number>): string | null {
  if (values.length !== FACE_VECTOR_DIM) return null;
  let maxAbs = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) return null;
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  if (maxAbs === 0) return null;
  let binary = "";
  for (let i = 0; i < values.length; i++) {
    const q = Math.max(
      -127,
      Math.min(127, Math.round((values[i] / maxAbs) * 127)),
    );
    binary += String.fromCharCode(q & 0xff);
  }
  return btoa(binary);
}

export function decodeFaceVector(encoded: string): Int8Array | null {
  let binary: string;
  try {
    binary = atob(encoded.trim());
  } catch {
    return null;
  }
  if (binary.length !== FACE_VECTOR_DIM) return null;
  const out = new Int8Array(FACE_VECTOR_DIM);
  for (let i = 0; i < FACE_VECTOR_DIM; i++) {
    out[i] = (binary.charCodeAt(i) << 24) >> 24;
  }
  return out;
}

/**
 * Kemiripan kosinus, dibulatkan 4 desimal dengan `floor(x + 0.5)` — bukan
 * `Math.round`, yang membulatkan setengah negatif berbeda dari `f64::round`.
 */
export function faceSimilarity(a: Int8Array, b: Int8Array) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.floor((dot / Math.sqrt(normA * normB)) * 10000 + 0.5) / 10000;
}

export function faceVerdict(
  probe: FaceVector | null,
  reference: FaceVector | null,
  threshold: number,
): { vonis: FaceVerdict; skor: number | null } {
  const probeVector =
    probe && probe.model === FACE_MODEL_ID
      ? decodeFaceVector(probe.vektor)
      : null;
  if (!probeVector) return { vonis: "Tidak Diperiksa", skor: null };
  const referenceVector =
    reference && reference.model === FACE_MODEL_ID
      ? decodeFaceVector(reference.vektor)
      : null;
  if (!referenceVector) return { vonis: "Belum Terdaftar", skor: null };
  const skor = faceSimilarity(probeVector, referenceVector);
  return { vonis: skor >= threshold ? "Cocok" : "Tidak Cocok", skor };
}

/**
 * Hanya "Tidak Cocok" yang bisa menolak, dan hanya pada mode `tolak`. Wajah
 * yang belum terdaftar atau tidak terbaca tetap lolos: kamera murah atau model
 * yang gagal dimuat tidak boleh menahan siswa di gerbang.
 */
export function faceScanRejected(mode: FaceMode, vonis: FaceVerdict) {
  return mode === "tolak" && vonis === "Tidak Cocok";
}

/** `null` bila bukan angka dalam rentang yang diizinkan. */
export function normalizeFaceThreshold(raw: unknown): number | null {
  const value =
    typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (
    !Number.isFinite(value) ||
    String(raw ?? "").trim() === "" ||
    value < FACE_THRESHOLD_MIN ||
    value > FACE_THRESHOLD_MAX
  ) {
    return null;
  }
  return value;
}

export function normalizeFaceMode(raw: unknown): FaceMode | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (FACE_MODES as readonly string[]).includes(value)
    ? (value as FaceMode)
    : null;
}

export const FACE_TEMPLATE_MAX_SAMPLES = 20;

export interface FaceTemplateDraft {
  idUnik: string;
  model: string;
  vektor: string;
  jumlahSampel: number;
  sumber: FaceTemplateSource;
}

/**
 * Aturan simpan, kembar dengan `validate_template` di `face_match.rs`.
 * `null` berarti sah; selain itu pesan untuk pengguna.
 */
export function validateFaceTemplate(draft: FaceTemplateDraft): string | null {
  if (!draft.idUnik.trim()) return "Karyawan wajib dipilih.";
  if (draft.model !== FACE_MODEL_ID) {
    return "Model wajah tidak dikenal. Muat ulang aplikasi.";
  }
  if (!decodeFaceVector(draft.vektor)) return "Data wajah tidak valid.";
  if (
    !Number.isInteger(draft.jumlahSampel) ||
    draft.jumlahSampel < 1 ||
    draft.jumlahSampel > FACE_TEMPLATE_MAX_SAMPLES
  ) {
    return "Jumlah sampel wajah tidak valid.";
  }
  if (!(FACE_TEMPLATE_SOURCES as readonly string[]).includes(draft.sumber)) {
    return "Sumber pendaftaran wajah tidak dikenal.";
  }
  return null;
}

/**
 * Satu karyawan beserta status pendaftaran wajahnya. Vektornya sengaja tidak
 * ikut. `sumber === null` berarti belum terdaftar.
 */
export interface FaceTemplateStatus {
  idUnik: string;
  nama: string;
  /** `master_data.jabatan_status`. */
  jabatan: string;
  divisi: string;
  /** Model berbeda dari `FACE_MODEL_ID` = wajib didaftarkan ulang. */
  model: string | null;
  jumlahSampel: number;
  sumber: FaceTemplateSource | null;
  dibuatOleh: string | null;
  updatedAt: string | null;
}

export function toFaceTemplateStatus(
  row: Record<string, unknown>,
): FaceTemplateStatus {
  const text = (value: unknown) => (value == null ? null : String(value));
  const sumber = text(row.sumber);
  return {
    idUnik: String(row.id_unik ?? ""),
    nama: String(row.nama ?? ""),
    jabatan: String(row.jabatan ?? ""),
    divisi: String(row.divisi ?? ""),
    model: text(row.model),
    jumlahSampel: Number(row.jumlah_sampel ?? 0),
    sumber: sumber === "kamera" || sumber === "foto_profil" ? sumber : null,
    dibuatOleh: text(row.dibuat_oleh),
    updatedAt: text(row.updated_at),
  };
}
