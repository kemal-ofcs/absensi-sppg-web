/**
 * Pengajuan pembelian barang inventaris (v30), cermin
 * `desktop/inventory_pengajuan.rs`. Sidik baris ada di
 * `services/inventory-pengajuan.ts` karena butuh `node:crypto`.
 *
 * Diuji dengan vektor yang sama di kedua bahasa
 * (`inventory-pengajuan.test.ts` ↔ `mod tests` di `inventory_pengajuan.rs`).
 * Pesan galatnya pun wajib identik.
 */

import { z } from "zod";
import {
  type Hasil,
  isValidDate,
  MAKS_HARGA_SATUAN,
  MAKS_JUMLAH,
  MAKS_NILAI_MUTASI,
} from "@/lib/validations/inventory";

export const MAKS_BARIS_PENGAJUAN = 100;
export const MAKS_KEPERLUAN = 200;
export const MAKS_CATATAN_PENGAJUAN = 500;
export const MAKS_SUMBER_DANA = 60;
export const MAKS_NAMA_BARANG = 120;
export const MAKS_SATUAN = 20;
/** Cermin `MAKS_DAFTAR_PENGAJUAN`. */
export const MAKS_DAFTAR_PENGAJUAN = 500;

export const STATUS_PENGAJUAN = [
  "Menunggu",
  "Disetujui",
  "Diterima sebagian",
  "Selesai",
  "Ditolak",
  "Dibatalkan",
] as const;
export type StatusPengajuan = (typeof STATUS_PENGAJUAN)[number];

/** Cermin `format_nomor_pengajuan`. */
export function formatNomorPengajuan(
  tahun: string,
  seri: string,
  nomorUrut: number,
): string {
  return `PGJ/${tahun}/${seri}/${String(nomorUrut).padStart(4, "0")}`;
}

/** Cermin `id_baris_pengajuan`. */
export function idBarisPengajuan(idPengajuan: string, urutan: number): string {
  return `${idPengajuan}-${urutan}`;
}

/** Cermin `id_pengajuan_dari_baris`. */
export function idPengajuanDariBaris(idBaris: string): string | null {
  const pisah = idBaris.lastIndexOf("-");
  if (pisah <= 0) return null;
  const urutan = idBaris.slice(pisah + 1);
  return /^\d+$/.test(urutan) ? idBaris.slice(0, pisah) : null;
}

/** Cermin `nilai_baris`: aturan `NILAI_MUTASI_SQL`. */
export function nilaiBaris(
  jumlah: number,
  hargaSatuan: number,
  desimal: boolean,
): number {
  const kali = jumlah * hargaSatuan;
  return desimal ? Math.floor((kali + 50) / 100) : kali;
}

export interface KeadaanPengajuan {
  dibatalkan: boolean;
  ditolak: boolean;
  disetujui: boolean;
  ditutup: boolean;
  /** Jumlah di-ACC dan jumlah diterima per baris. */
  baris: readonly { jumlah: number; diterima: number }[];
}

/** Cermin `status_pengajuan` (PRD §3.6), diperiksa berurutan. */
export function statusPengajuan(keadaan: KeadaanPengajuan): StatusPengajuan {
  if (keadaan.dibatalkan) return "Dibatalkan";
  if (keadaan.ditolak) return "Ditolak";
  if (!keadaan.disetujui) return "Menunggu";
  const penuh =
    keadaan.baris.length > 0 &&
    keadaan.baris.every((b) => b.diterima >= b.jumlah);
  if (keadaan.ditutup || penuh) return "Selesai";
  if (keadaan.baris.some((b) => b.diterima > 0)) return "Diterima sebagian";
  return "Disetujui";
}

/** Cermin `BarisDraft` (`deny_unknown_fields`). */
const barisDraftSchema = z
  .object({
    id_barang: z.string().max(160).nullable().optional(),
    nama_barang: z.string().max(1000).nullable().optional(),
    satuan: z.string().max(200).nullable().optional(),
    desimal: z.boolean().default(false),
    jumlah: z.number().int().default(0),
    harga_satuan: z.number().int().default(0),
  })
  .strict();

/** Cermin `PengajuanDraft` (`deny_unknown_fields`). */
export const pengajuanDraftSchema = z
  .object({
    id_pengajuan: z.string().max(160).nullable().optional(),
    tanggal: z.string().max(10).default(""),
    keperluan: z.string().max(2000).default(""),
    sumber_dana: z.string().max(400).nullable().optional(),
    catatan: z.string().max(4000).nullable().optional(),
    // Batas longgar penahan beban; pesan batas sebenarnya dari validatePengajuan.
    baris: z.array(barisDraftSchema).max(1000).default([]),
  })
  .strict();
export type PengajuanDraft = z.input<typeof pengajuanDraftSchema>;
export type PengajuanDraftParsed = z.output<typeof pengajuanDraftSchema>;

/** Cermin `KeputusanDraft` (`deny_unknown_fields`). */
export const keputusanDraftSchema = z
  .object({
    id_pengajuan: z.string().max(160).default(""),
    keputusan: z.string().max(20).default(""),
    sidik_baris: z.string().max(200).default(""),
    catatan: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type KeputusanDraft = z.input<typeof keputusanDraftSchema>;

export interface BarisValid {
  id_barang: string | null;
  nama_barang: string;
  satuan: string;
  desimal: boolean;
  jumlah: number;
  harga_satuan: number;
}

export interface PengajuanValid {
  tanggal: string;
  keperluan: string;
  sumber_dana: string | null;
  catatan: string | null;
  /** Barang terdaftar membawa nama, satuan, dan desimal kosong; service mengisinya. */
  baris: BarisValid[];
}

function panjang(value: string): number {
  return Array.from(value).length;
}

function bersih(value: string | null | undefined): string | null {
  const isi = value?.trim();
  return isi ? isi : null;
}

/** Cermin `validate_pengajuan`. */
export function validatePengajuan(
  draft: PengajuanDraftParsed,
  hariIni: string,
): Hasil<PengajuanValid> {
  const tanggal = draft.tanggal.trim();
  if (!isValidDate(tanggal)) {
    return { ok: false, error: "Tanggal pengajuan tidak valid." };
  }
  if (tanggal > hariIni) {
    return {
      ok: false,
      error: "Tanggal pengajuan tidak boleh setelah hari ini.",
    };
  }
  const keperluan = draft.keperluan.trim();
  if (!keperluan) return { ok: false, error: "Keperluan wajib diisi." };
  if (panjang(keperluan) > MAKS_KEPERLUAN) {
    return {
      ok: false,
      error: `Keperluan maksimal ${MAKS_KEPERLUAN} karakter.`,
    };
  }
  const sumber_dana = bersih(draft.sumber_dana);
  if (sumber_dana !== null && panjang(sumber_dana) > MAKS_SUMBER_DANA) {
    return {
      ok: false,
      error: `Sumber dana maksimal ${MAKS_SUMBER_DANA} karakter.`,
    };
  }
  const catatan = bersih(draft.catatan);
  if (catatan !== null && panjang(catatan) > MAKS_CATATAN_PENGAJUAN) {
    return {
      ok: false,
      error: `Catatan maksimal ${MAKS_CATATAN_PENGAJUAN} karakter.`,
    };
  }
  if (draft.baris.length === 0) {
    return { ok: false, error: "Isi minimal satu barang." };
  }
  if (draft.baris.length > MAKS_BARIS_PENGAJUAN) {
    return {
      ok: false,
      error: `Paling banyak ${MAKS_BARIS_PENGAJUAN} barang dalam satu pengajuan.`,
    };
  }

  const baris: BarisValid[] = [];
  const terdaftar = new Map<string, number>();
  let total = 0;
  for (const [indeks, isian] of draft.baris.entries()) {
    const nomor = indeks + 1;
    const id_barang = bersih(isian.id_barang);
    let nama_barang = "";
    let satuan = "";
    let desimal = false;
    if (id_barang !== null) {
      const sebelumnya = terdaftar.get(id_barang);
      if (sebelumnya !== undefined) {
        return {
          ok: false,
          error: `Baris ${nomor}: barang ini sudah ada di baris ${sebelumnya}.`,
        };
      }
      terdaftar.set(id_barang, nomor);
    } else {
      nama_barang = bersih(isian.nama_barang) ?? "";
      if (!nama_barang) {
        return { ok: false, error: `Baris ${nomor}: nama barang wajib diisi.` };
      }
      if (panjang(nama_barang) > MAKS_NAMA_BARANG) {
        return {
          ok: false,
          error: `Baris ${nomor}: nama barang maksimal ${MAKS_NAMA_BARANG} karakter.`,
        };
      }
      satuan = bersih(isian.satuan) ?? "";
      if (!satuan) {
        return { ok: false, error: `Baris ${nomor}: satuan wajib diisi.` };
      }
      if (panjang(satuan) > MAKS_SATUAN) {
        return {
          ok: false,
          error: `Baris ${nomor}: satuan maksimal ${MAKS_SATUAN} karakter.`,
        };
      }
      desimal = isian.desimal;
    }
    if (isian.jumlah < 1 || isian.jumlah > MAKS_JUMLAH) {
      return { ok: false, error: `Baris ${nomor}: jumlah harus lebih dari 0.` };
    }
    if (isian.harga_satuan < 0 || isian.harga_satuan > MAKS_HARGA_SATUAN) {
      return { ok: false, error: `Baris ${nomor}: harga satuan tidak valid.` };
    }
    const kali = isian.jumlah * isian.harga_satuan;
    if (kali > MAKS_NILAI_MUTASI) {
      return {
        ok: false,
        error: `Baris ${nomor}: nilai (jumlah × harga satuan) terlalu besar.`,
      };
    }
    total += kali;
    baris.push({
      id_barang,
      nama_barang,
      satuan,
      desimal,
      jumlah: isian.jumlah,
      harga_satuan: isian.harga_satuan,
    });
  }
  if (total > MAKS_NILAI_MUTASI) {
    return { ok: false, error: "Total pengajuan terlalu besar." };
  }
  return {
    ok: true,
    value: { tanggal, keperluan, sumber_dana, catatan, baris },
  };
}

/** Cermin `validate_alasan`. */
export function validateAlasan(alasan: string, label: string): Hasil<string> {
  const isi = alasan.trim();
  if (!isi) return { ok: false, error: `${label} wajib diisi.` };
  if (panjang(isi) > MAKS_CATATAN_PENGAJUAN) {
    return {
      ok: false,
      error: `${label} maksimal ${MAKS_CATATAN_PENGAJUAN} karakter.`,
    };
  }
  return { ok: true, value: isi };
}

export type KeputusanValid =
  | { keputusan: "ACC"; sidik: string; catatan: string | null }
  | { keputusan: "Tolak"; alasan: string };

/**
 * Cermin `validate_pemutus`: pengaju tidak memutuskan pengajuannya sendiri
 * (pemisahan tugas). Superadmin dikecualikan. Dipakai backend dan untuk
 * menyembunyikan tombol di layar.
 */
export function validatePemutus(
  diajukanOleh: string,
  operator: string,
  superadmin: boolean,
): Hasil<null> {
  if (
    !superadmin &&
    diajukanOleh.trim().toLowerCase() === operator.trim().toLowerCase()
  ) {
    return {
      ok: false,
      error:
        "Pengajuan ini kamu ajukan sendiri. Minta pemegang Keuangan lain untuk memutuskannya.",
    };
  }
  return { ok: true, value: null };
}

/** Cermin `validate_keputusan`. */
export function validateKeputusan(
  draft: z.output<typeof keputusanDraftSchema>,
): Hasil<KeputusanValid> {
  const keputusan = draft.keputusan.trim();
  if (keputusan === "ACC") {
    const sidik = draft.sidik_baris.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sidik)) {
      return {
        ok: false,
        error: "Pengajuan tidak valid. Muat ulang daftarnya.",
      };
    }
    const catatan = bersih(draft.catatan);
    if (catatan !== null && panjang(catatan) > MAKS_CATATAN_PENGAJUAN) {
      return {
        ok: false,
        error: `Catatan persetujuan maksimal ${MAKS_CATATAN_PENGAJUAN} karakter.`,
      };
    }
    return { ok: true, value: { keputusan: "ACC", sidik, catatan } };
  }
  if (keputusan === "Tolak") {
    const alasan = validateAlasan(draft.catatan ?? "", "Alasan penolakan");
    if (!alasan.ok) return alasan;
    return { ok: true, value: { keputusan: "Tolak", alasan: alasan.value } };
  }
  return { ok: false, error: "Keputusan tidak dikenal." };
}

export interface BarisPengajuan {
  id_baris: string;
  urutan: number;
  id_barang: string | null;
  kode_barang: string | null;
  nama_barang: string;
  satuan: string;
  desimal: boolean;
  /** ×100 bila `desimal`. */
  jumlah: number;
  harga_satuan: number;
  nilai: number;
  diterima: number;
  /** Barang yang sudah ada: `id_barang`, atau `brg-<id_baris>` setelah penerimaan pertama barang baru. */
  barang_terdaftar: string | null;
  /** Harga sebenarnya dari penerimaan, dikelompokkan per harga. */
  harga_diterima: { harga_satuan: number; jumlah: number }[];
}

export interface Pengajuan {
  id_pengajuan: string;
  tanggal: string;
  nomor: string;
  nomor_ganda: boolean;
  keperluan: string;
  sumber_dana: string | null;
  catatan: string | null;
  sidik_baris: string;
  diajukan_oleh: string;
  disetujui_pada: string | null;
  disetujui_oleh: string | null;
  catatan_persetujuan: string | null;
  ditolak_pada: string | null;
  ditolak_oleh: string | null;
  alasan_tolak: string | null;
  dibatalkan_pada: string | null;
  dibatalkan_oleh: string | null;
  alasan_batal: string | null;
  ditutup_pada: string | null;
  ditutup_oleh: string | null;
  alasan_tutup: string | null;
  status: StatusPengajuan;
  total: number;
  baris: BarisPengajuan[];
  penerimaan: PenerimaanPengajuan[];
}

export interface DaftarPengajuan {
  pengajuan: Pengajuan[];
  terpotong: boolean;
  hari_ini: string;
}

// Penerimaan (langkah 2)

/** Cermin `MAKS_FOTO_PENERIMAAN`. */
export const MAKS_FOTO_PENERIMAAN = 5;
/** Cermin `MAKS_FOTO_BASE64`: ±450 KB setelah didekode. */
export const MAKS_FOTO_BASE64 = 600_000;
/** WAJIB sama dengan CHECK `inventory_penerimaan_foto.mime_type`. */
export const MIME_FOTO = ["image/jpeg", "image/png", "image/webp"] as const;

/** Cermin `id_barang_baru`. */
export function idBarangBaru(idBaris: string): string {
  return `brg-${idBaris}`;
}

/** Cermin `FotoDraft` (`deny_unknown_fields`). Batas panjang sebenarnya dari validator. */
const fotoDraftSchema = z
  .object({
    mime_type: z.string().max(100).default(""),
    data_base64: z.string().max(4_000_000).default(""),
  })
  .strict();
export type FotoDraft = z.output<typeof fotoDraftSchema>;

/** Cermin `BarisTerimaDraft` (`deny_unknown_fields`). */
const barisTerimaDraftSchema = z
  .object({
    id_baris: z.string().max(200).default(""),
    jumlah: z.number().int().default(0),
    harga_satuan: z.number().int().default(0),
    tempat: z.string().max(400).nullable().optional(),
    kondisi: z.string().max(40).nullable().optional(),
    tanggal_expired: z.string().max(10).nullable().optional(),
    per_unit: z.boolean().default(false),
    tipe: z.string().max(40).nullable().optional(),
    kategori: z.string().max(400).nullable().optional(),
    bisa_expired: z.boolean().default(false),
  })
  .strict();

/** Cermin `PenerimaanDraft` (`deny_unknown_fields`). */
export const penerimaanDraftSchema = z
  .object({
    id_pengajuan: z.string().max(160).default(""),
    tanggal: z.string().max(10).default(""),
    catatan: z.string().max(4000).nullable().optional(),
    baris: z.array(barisTerimaDraftSchema).max(1000).default([]),
    foto: z.array(fotoDraftSchema).max(20).default([]),
  })
  .strict();
export type PenerimaanDraft = z.input<typeof penerimaanDraftSchema>;
export type PenerimaanDraftParsed = z.output<typeof penerimaanDraftSchema>;

export interface BarisAcc {
  id_baris: string;
  urutan: number;
  jumlah: number;
  diterima: number;
}

export interface PenerimaanValid {
  tanggal: string;
  catatan: string | null;
  /** Indeks `draft.baris` yang jumlahnya > 0, berurutan seperti kiriman. */
  dicatat: number[];
}

function base64Sah(isi: string): boolean {
  return (
    isi.length > 0 && isi.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(isi)
  );
}

/** Cermin `validate_foto_penerimaan`. */
export function validateFotoPenerimaan(
  foto: readonly FotoDraft[],
): Hasil<null> {
  if (foto.length === 0) {
    return {
      ok: false,
      error: "Lampirkan minimal satu foto barang yang diterima.",
    };
  }
  if (foto.length > MAKS_FOTO_PENERIMAAN) {
    return { ok: false, error: `Paling banyak ${MAKS_FOTO_PENERIMAAN} foto.` };
  }
  for (const [indeks, item] of foto.entries()) {
    const nomor = indeks + 1;
    if (!(MIME_FOTO as readonly string[]).includes(item.mime_type)) {
      return {
        ok: false,
        error: `Foto ${nomor}: format harus JPEG, PNG, atau WebP.`,
      };
    }
    if (item.data_base64.length > MAKS_FOTO_BASE64) {
      return {
        ok: false,
        error: `Foto ${nomor} terlalu besar. Kompres ulang atau pilih foto lain.`,
      };
    }
    if (!base64Sah(item.data_base64)) {
      return { ok: false, error: `Foto ${nomor} tidak terbaca.` };
    }
  }
  return { ok: true, value: null };
}

/** Cermin `validate_penerimaan`. */
export function validatePenerimaan(
  draft: PenerimaanDraftParsed,
  tanggalAcc: string,
  hariIni: string,
  acc: readonly BarisAcc[],
): Hasil<PenerimaanValid> {
  const tanggal = draft.tanggal.trim();
  if (!isValidDate(tanggal)) {
    return { ok: false, error: "Tanggal terima tidak valid." };
  }
  if (tanggal > hariIni) {
    return { ok: false, error: "Tanggal terima tidak boleh setelah hari ini." };
  }
  if (tanggal < tanggalAcc) {
    return {
      ok: false,
      error: "Tanggal terima tidak boleh sebelum tanggal ACC.",
    };
  }
  const catatan = bersih(draft.catatan);
  if (catatan !== null && panjang(catatan) > MAKS_CATATAN_PENGAJUAN) {
    return {
      ok: false,
      error: `Catatan maksimal ${MAKS_CATATAN_PENGAJUAN} karakter.`,
    };
  }
  const terlihat = new Set<string>();
  const dicatat: number[] = [];
  for (const [indeks, isian] of draft.baris.entries()) {
    const idBaris = isian.id_baris.trim();
    const baris = acc.find((b) => b.id_baris === idBaris);
    if (!baris) {
      return {
        ok: false,
        error: "Barang penerimaan tidak dikenal. Muat ulang daftarnya.",
      };
    }
    if (terlihat.has(idBaris)) {
      return { ok: false, error: `Baris ${baris.urutan}: diisi dua kali.` };
    }
    terlihat.add(idBaris);
    if (isian.jumlah < 0) {
      return {
        ok: false,
        error: `Baris ${baris.urutan}: jumlah diterima tidak valid.`,
      };
    }
    if (isian.jumlah === 0) continue;
    if (isian.jumlah > baris.jumlah - baris.diterima) {
      return {
        ok: false,
        error: `Baris ${baris.urutan}: jumlah diterima melebihi sisa yang di-ACC.`,
      };
    }
    if (isian.harga_satuan < 0 || isian.harga_satuan > MAKS_HARGA_SATUAN) {
      return {
        ok: false,
        error: `Baris ${baris.urutan}: harga satuan tidak valid.`,
      };
    }
    if (isian.jumlah * isian.harga_satuan > MAKS_NILAI_MUTASI) {
      return {
        ok: false,
        error: `Baris ${baris.urutan}: nilai (jumlah × harga satuan) terlalu besar.`,
      };
    }
    dicatat.push(indeks);
  }
  if (dicatat.length === 0) {
    return { ok: false, error: "Isi jumlah diterima minimal satu barang." };
  }
  const foto = validateFotoPenerimaan(draft.foto);
  if (!foto.ok) return foto;
  return { ok: true, value: { tanggal, catatan, dicatat } };
}

export interface PenerimaanPengajuan {
  id_penerimaan: string;
  tanggal: string;
  catatan: string | null;
  jumlah_foto: number;
  dicatat_oleh: string;
}

/** Hasil `receive`: barang dan mutasi baru per baris, untuk cetak label. */
export interface HasilPenerimaan {
  sukses: boolean;
  id_penerimaan: string;
  label: { id_barang: string; jumlah: number; mutasi: string[] }[];
}

export interface FotoPenerimaan {
  mime_type: string;
  data_base64: string;
}
