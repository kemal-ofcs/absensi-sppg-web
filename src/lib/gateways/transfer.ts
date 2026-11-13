"use client";

// HRIS fase 12: berkas transfer gaji ke bank (prd-hris.md §27). KHUSUS CLOUD:
// command `desktop_transfer_*` dan `desktop_payroll_transfer` hanya jalan
// saat perangkat terhubung ke database. Berkasnya dirender di TS (§27.6).

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  JenisPengaturan,
  KolomFormat,
  SusunanTransfer,
} from "@/lib/validations/transfer";

type Isian = Record<string, unknown>;

export interface BankTransfer {
  id_bank: string;
  nama: string;
  kode: string | null;
  alias: string[];
  is_aktif: number;
  is_bawaan: number;
  diubah_oleh: string | null;
  updated_at: string;
}

export interface RekeningDebet {
  id_rekening: string;
  id_bank: string;
  no_rekening: string;
  nama_rekening: string;
  keterangan: string | null;
  is_aktif: number;
  nama_bank: string | null;
  kode_bank: string | null;
  bank_aktif: number | null;
  diubah_oleh: string | null;
  updated_at: string;
}

export interface FormatTransfer {
  id_format: string;
  nama: string;
  id_bank: string | null;
  nama_bank: string | null;
  jenis: "csv" | "txt" | "xlsx";
  pemisah: string | null;
  pakai_judul: number;
  kutip: number;
  desimal: number;
  cakupan: "semua" | "sesama" | "antarbank";
  /** Null = isi tersimpan tidak lagi sah; format tidak bisa dipakai. */
  kolom: KolomFormat[] | null;
  maks_berita: number | null;
  is_aktif: number;
  diubah_oleh: string | null;
  updated_at: string;
}

/**
 * Tanpa izin khusus hanya bank aktif; `unduh` (kedua izin unduh) menambah
 * rekening dan format aktif; `atur` (`payroll.config.manage`) semuanya.
 */
export interface PengaturanTransfer {
  bank: BankTransfer[];
  rekening: RekeningDebet[];
  format: FormatTransfer[];
  atur: boolean;
  unduh: boolean;
}

export interface UnduhanTransfer {
  id: string;
  performed_by: string;
  /** JSON: format, id_format, id_rekening, jumlah_baris, rekening_debet, tanggal_efektif, total. */
  notes: string | null;
  created_at: string;
}

export interface BerkasTransfer {
  run: {
    id: string;
    period_start: string;
    period_end: string;
    status: string;
    total_net_payout: number;
    total_employees: number;
  };
  debet: RekeningDebet;
  /** Null = Excel umum. */
  format: FormatTransfer | null;
  susunan: SusunanTransfer;
  /** Unduhan SEBELUM permintaan ini (peringatan unggahan ganda, §27.4). */
  riwayat: UnduhanTransfer[];
  dicatat: boolean;
}

const web = <T>(
  aksi: string,
  body: { jenis?: JenisPengaturan; id?: string; draft?: Isian } = {},
) => requestWebApi<T>("/api/payroll/transfer", "POST", { aksi, ...body });

export async function ambilPengaturanTransfer(): Promise<PengaturanTransfer> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_transfer_settings");
  return web("pengaturan");
}

/** Simpan atau nonaktifkan (`is_aktif: false`) satu bank, rekening, atau format. */
export async function simpanPengaturanTransfer(
  jenis: JenisPengaturan,
  id: string | null,
  draft: Isian,
): Promise<{ sukses: boolean; id: string }> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_transfer_settings_save", {
      jenis,
      id,
      draft,
    });
  return web("simpan_pengaturan", { jenis, ...(id ? { id } : {}), draft });
}

/**
 * Baris berkas transfer satu run. `draft`: `run_id`, `id_rekening`,
 * `id_format` (kosong = Excel umum), `tanggal_efektif` (kosong = hari ini
 * WIB jam database), `catat` (true saat mengunduh, dicatat `TRANSFER_EXPORT`).
 */
export async function ambilBerkasTransfer(
  draft: Isian,
): Promise<BerkasTransfer> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_payroll_transfer", { draft });
  return web("berkas", { draft });
}
