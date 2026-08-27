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
