export interface ScanTerminalInput {
  qrContent: string;
  lat?: number;
  lng?: number;
  kodeOperator?: string;
  sumberData?:
    | "Scanner"
    | "Koreksi Admin"
    | "Import Offline"
    | "Generate Sistem";
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
}
