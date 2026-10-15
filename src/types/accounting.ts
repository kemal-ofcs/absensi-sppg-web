/**
 * Bentuk data modul akuntansi (K1). Dibaca dari Rust (`desktop/accounting.rs`)
 * di Desktop/Mobile dan dari `services/accounting.ts` di Web; keduanya wajib
 * mengembalikan kunci yang sama.
 */

import type {
  KelompokAkun,
  SaldoNormal,
  SumberJurnal,
} from "@/lib/validations/accounting";

export interface AkunItem {
  id_akun: string;
  kode: string;
  nama: string;
  kelompok: KelompokAkun;
  saldo_normal: SaldoNormal;
  is_aktif: boolean;
  sistem: boolean;
  punya_jurnal: boolean;
}

export interface JurnalItem {
  id_jurnal: string;
  tanggal: string;
  nomor: string;
  keterangan: string;
  sumber: SumberJurnal;
  id_jurnal_batal: string | null;
  dibuat_oleh: string;
  created_at: string;
  total: number;
  dibatalkan: boolean;
  /** Dua perangkat bisa mendapat seri kembar; nomornya ditandai, datanya tetap utuh. */
  nomor_ganda: boolean;
}

export interface JurnalDetail {
  jurnal: {
    id_jurnal: string;
    tanggal: string;
    nomor: string;
    keterangan: string;
    sumber: SumberJurnal;
    id_sumber: string | null;
    id_jurnal_batal: string | null;
    dibuat_oleh: string;
    created_at: string;
    nomor_pembalik: string | null;
  };
  baris: Array<{
    id_baris: string;
    id_akun: string;
    kode_akun: string;
    nama_akun: string;
    debit: number;
    kredit: number;
    keterangan: string | null;
    urutan: number;
  }>;
}

export interface BukuBesar {
  akun: {
    id_akun: string;
    kode: string;
    nama: string;
    kelompok: KelompokAkun;
    saldo_normal: SaldoNormal;
    is_aktif: number;
  };
  saldo_awal: number;
  total_debit: number;
  total_kredit: number;
  saldo_akhir: number;
  terpotong: boolean;
  baris: Array<{
    id_jurnal: string;
    tanggal: string;
    nomor: string;
    keterangan: string;
    sumber: SumberJurnal;
    debit: number;
    kredit: number;
    saldo: number;
  }>;
}

export interface NeracaSaldo {
  items: Array<{
    id_akun: string;
    kode: string;
    nama: string;
    kelompok: KelompokAkun;
    saldo_normal: SaldoNormal;
    debit: number;
    kredit: number;
  }>;
  total_debit: number;
  total_kredit: number;
}

// ── Laporan keuangan perusahaan (K4a) ──────────────────────────────────────────

export interface BarisLaporanAkun {
  id_akun: string;
  kode: string;
  nama: string;
  saldo: number;
}

export interface LaporanPosisiKeuangan {
  sampai: string;
  aset: BarisLaporanAkun[];
  kewajiban: BarisLaporanAkun[];
  ekuitas: BarisLaporanAkun[];
  /** Pendapatan dikurangi beban sepanjang masa; tutup buku belum ada. */
  laba_berjalan: number;
  total_aset: number;
  total_kewajiban: number;
  total_ekuitas: number;
  /** Bukan nol berarti laporan timpang. */
  selisih: number;
}

export interface LaporanAktivitas {
  dari: string;
  sampai: string;
  pendapatan: BarisLaporanAkun[];
  beban: BarisLaporanAkun[];
  total_pendapatan: number;
  total_beban: number;
  laba_bersih: number;
}

export interface LaporanArusKas {
  dari: string;
  sampai: string;
  akun_kas: Array<{ id_akun: string; kode: string; nama: string }>;
  saldo_awal: number;
  kelompok: Array<{
    sumber: string;
    label: string;
    masuk: number;
    keluar: number;
    bersih: number;
  }>;
  total_masuk: number;
  total_keluar: number;
  saldo_akhir: number;
}

// ── Tutup buku (v45) ────────────────────────────────────────────────────────

export interface TutupBukuItem {
  id_tutup: string;
  sampai_tanggal: string;
  dibuat_oleh: string;
  kode_perangkat: string;
  /** Menurut jam perangkat yang menutup; bisa salah. */
  waktu_perangkat: string;
  /** Jam database cloud saat barisnya diterima; `null` = belum sampai cloud. */
  diterima_cloud: string | null;
  saldo_json: string;
  status: "Aktif" | "Dibuka" | "Digantikan" | "Menunggu";
  alasan_buka: string | null;
  dibuka_oleh: string | null;
  dibuka_pada: string | null;
  created_at: string;
  updated_at: string;
  diputuskan_oleh: string | null;
  diputuskan_pada: string | null;
  catatan_keputusan: string | null;
  /** Hanya di daftar status: saldo berlaku berubah sejak ditutup. */
  perlu_ditinjau?: boolean;
}

export interface StatusTutupBuku {
  /** Tanggal terkunci terakhir, atau `null` bila belum pernah ditutup. */
  batas: string | null;
  /** Versi `Menunggu` ditambah tutup buku berlaku yang perlu ditinjau. */
  perlu_perhatian: number;
  riwayat: TutupBukuItem[];
}

export interface TinjauanTutupBuku {
  tutup: TutupBukuItem;
  /** Versi berlaku bertanggal sama, untuk tutup buku yang `Menunggu`. */
  pembanding: TutupBukuItem | null;
  /**
   * `Menunggu`: sebelum = versi berlaku, sesudah = versi ini.
   * `Aktif`: sebelum = saat ditutup, sesudah = sekarang.
   */
  selisih: Array<{
    id_akun: string;
    kode: string;
    nama: string;
    sebelum: number;
    sesudah: number;
  }>;
  /** Jurnal bertanggal di periode itu yang dicatat sesudah ditutup. */
  jurnal: Array<{
    id_jurnal: string;
    tanggal: string;
    nomor: string;
    keterangan: string;
    sumber: string;
    dibuat_oleh: string;
    created_at: string;
    total: number;
  }>;
}
