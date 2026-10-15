/**
 * Bentuk data kasbon karyawan (K2). Dibaca dari Rust (`desktop/loan.rs`) di
 * Desktop/Mobile dan dari `services/loan.ts` di Web; keduanya wajib
 * mengembalikan kunci yang sama.
 */

import type { StatusPinjaman } from "@/lib/validations/loan";

export interface PinjamanItem {
  id_pinjaman: string;
  id_karyawan: string;
  nama_karyawan: string;
  pokok: number;
  cicilan: number;
  mulai_potong: string;
  keterangan: string | null;
  status: StatusPinjaman;
  tanggal_pengajuan: string;
  tanggal_cair: string | null;
  /** Angsuran gaji + pelunasan tunai yang sudah tercatat. */
  terbayar: number;
  /** Pokok − terbayar. Negatif berarti terpotong lebih dari pokoknya. */
  sisa: number;
  /** Potongan di proses gaji yang dibuat tetapi belum dibayar. */
  potongan_tertunda: number;
  lebih_potong: boolean;
  /** Bulan (`YYYY-MM`) yang cicilannya ditunda. */
  tunda: string[];
}

export interface DetailPinjaman {
  pinjaman: {
    id_pinjaman: string;
    id_karyawan: string;
    nama_karyawan: string;
    pokok: number;
    cicilan: number;
    mulai_potong: string;
    keterangan: string | null;
    status: StatusPinjaman;
    tanggal_pengajuan: string;
    diajukan_oleh: string;
    diputuskan_oleh: string | null;
    tanggal_cair: string | null;
    id_akun_kas: string | null;
    created_at: string;
    updated_at: string;
  };
  mutasi: Array<{
    id_mutasi: string;
    jenis: "Pencairan" | "Angsuran Gaji" | "Pelunasan Tunai" | "Pembatalan";
    jumlah: number;
    tanggal: string;
    id_ref: string | null;
    id_jurnal: string | null;
    dicatat_oleh: string;
    created_at: string;
  }>;
  tunda: Array<{
    id_tunda: string;
    periode: string;
    alasan: string | null;
    dibuat_oleh: string;
  }>;
}

export interface OrangPeminjam {
  id_karyawan: string;
  nama: string;
  divisi: string;
}
