/**
 * Nilai sah kolom `absensi_harian.sumber` dan `log_scan.sumber_data`.
 *
 * Ini satu-satunya tempat daftar itu dieja. Daftarnya WAJIB identik dengan CHECK
 * constraint di DDL cloud (`turso.rs`); SQLite lokal tidak memilikinya, jadi
 * nilai di luar daftar akan tersimpan mulus di perangkat lalu ditolak permanen
 * saat push — event-nya macet di outbox tanpa pernah bisa berhasil.
 *
 * Sebelumnya daftar ini dieja ulang di tiga berkas dan ketiganya sudah berbeda:
 * dua di antaranya kehilangan `"Import Manual"` yang justru diizinkan database.
 */
export const ATTENDANCE_SOURCE_VALUES = [
  "Scanner",
  "Koreksi Admin",
  "Import Offline",
  "Import Manual",
  "Generate Sistem",
] as const;

export type AttendanceSource = (typeof ATTENDANCE_SOURCE_VALUES)[number];

export interface ScanTerminalInput {
  qrContent: string;
  lat?: number;
  lng?: number;
  kodeOperator?: string;
  sumberData?: AttendanceSource;
  /**
   * Foto bukti absensi, base64 murni tanpa awalan data URL.
   *
   * Wajib ketika role operator terminal menyalakan sakelar "Wajib foto bukti"
   * di halaman Master Operator. Alamat IP TIDAK ada di sini dengan sengaja:
   * pada Web ia dibaca server dari header proxy, dan pada Desktop/Mobile dari
   * perangkat itu sendiri — nilai kiriman klien bisa dikarang.
   */
  fotoBase64?: string;
  fotoMime?: "image/jpeg" | "image/png" | "image/webp";
}

export interface ScanResult {
  sukses: boolean;
  status: "Berhasil" | "Ditolak" | "Perlu Verifikasi" | "Error";
  jenisScan: string;
  idKaryawan: string;
  nama: string;
  divisi: string;
  pesan: string;
  catatanSistem?: string;
  keterangan?: string;
  menitTerlambat?: number;
  menitDatangAwal?: number;
  jamKerja?: number;
  lembur?: number;
  jamKerjaKurang?: number;
  shiftEfektif?: number;
  modeTugas?: "NORMAL" | "PENGGANTI";
  idSesi?: string;
  revision?: number;
}
