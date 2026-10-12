/**
 * Bentuk data foto bukti absensi.
 *
 * Dipisah dari layanan servernya supaya komponen klien dan gateway bisa
 * mengimpor tipe ini tanpa ikut menarik `@libsql/client` atau `server-only`.
 *
 * Daftar TIDAK PERNAH membawa `base64`: satu foto sekitar 40 KB, sehingga 200
 * baris akan menjadi balasan puluhan megabyte. Fotonya diambil satu per satu
 * lewat `getAttendancePhoto`, persis seperti riwayat "Lupa Password".
 */

import { FACE_VERDICTS, type FaceVerdict } from "@/lib/validations/face-match";

export interface AttendancePhotoEntry {
  idFoto: string;
  idSesi: string;
  tanggalKerja: string;
  idKaryawan: string;
  nama: string;
  divisi: string;
  jenisScan: string;
  timestampScan: string;
  sumberData: string;
  kodeOperator: string;
  /** Alamat IP perangkat yang melakukan scan, apa adanya saat scan terjadi. */
  ipPerangkat: string;
  /** `client_id` perangkat Desktop/Mobile, atau "web" untuk scan lewat browser. */
  clientId: string;
  fotoMime: string;
  ukuranBase64: number;
  createdAt: string;
  /** `null` = scan ini tidak diperiksa wajahnya (fitur mati, atau foto lama). */
  wajahVonis: FaceVerdict | null;
  wajahSkor: number | null;
}

export interface AttendancePhotoFilter {
  tanggalMulai?: string;
  tanggalSelesai?: string;
  /** Cocokkan nama, ID karyawan, divisi, atau kode operator. */
  search?: string;
  /** Hanya foto dengan vonis wajah ini, mis. "Tidak Cocok" untuk ditinjau. */
  wajahVonis?: FaceVerdict | "";
  limit?: number;
}

export function toFaceVerdict(value: unknown): FaceVerdict | null {
  return (FACE_VERDICTS as readonly unknown[]).includes(value)
    ? (value as FaceVerdict)
    : null;
}

export function toFaceScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface AttendancePhotoImage {
  mime: string;
  base64: string;
}

/** Batas baris satu permintaan; sama dengan clamp di sisi Rust. */
export const ATTENDANCE_PHOTO_MAX_LIMIT = 500;

export function attendancePhotoLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), ATTENDANCE_PHOTO_MAX_LIMIT);
}
