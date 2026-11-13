"use client";

// HRIS fase 7 (v42): pelatihan, peserta, dan sertifikat. KHUSUS CLOUD (Q-87):
// command `desktop_hr_training*` hanya jalan saat perangkat terhubung ke
// database. Sertifikat = dokumen karyawan berjenis Sertifikat (Q-97).
// Fase 11 (v43): rencana dan pagu pelatihan per tahun (prd-hris.md §26).

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  HasilPeserta,
  RencanaRingkas,
  RingkasanAnggaran,
  StatusPelatihan,
  StatusRencana,
} from "@/lib/validations/hr-pelatihan";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface Pelatihan {
  id_pelatihan: string;
  nama: string;
  penyelenggara: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string;
  lokasi: string | null;
  biaya: number;
  keterangan: string | null;
  dibatalkan_pada: string | null;
  alasan_batal: string | null;
  status: StatusPelatihan;
  jumlah_peserta?: number;
  /** Kosong = di luar rencana (dibebankan ke Umum). */
  id_rencana?: string | null;
}

/** Baris `hr_pelatihan_rencana` beserta nama divisinya. */
export interface RencanaPelatihan {
  id_rencana: string;
  tahun: number;
  nama: string;
  id_divisi: string | null;
  nama_divisi: string | null;
  divisi_aktif: number | null;
  bulan: number | null;
  peserta_rencana: number;
  biaya_rencana: number;
  penyelenggara: string | null;
  keterangan: string | null;
  dibatalkan_pada: string | null;
  alasan_batal: string | null;
  status: StatusRencana;
}

export type RencanaTahunan = Omit<RingkasanAnggaran, "rencana"> & {
  rencana: (RencanaRingkas & RencanaPelatihan)[];
  tahun: number;
  hari_ini: string;
};

export interface BerkasSertifikat {
  id_berkas: string;
  id_dokumen: string;
  urutan: number;
  nama_berkas: string | null;
  mime_type: string;
  panjang: number;
}

export interface Peserta {
  id_peserta: string;
  id_karyawan: string;
  nama: string | null;
  divisi: string | null;
  jabatan_status: string | null;
  status_aktif: string | null;
  hasil: HasilPeserta | null;
  catatan: string | null;
  id_dokumen: string | null;
  nomor: string | null;
  tanggal_terbit: string | null;
  tanggal_kedaluwarsa: string | null;
  catatan_sertifikat: string | null;
  berkas: BerkasSertifikat[];
}

export interface RiwayatPelatihan extends Pelatihan {
  hasil: HasilPeserta | null;
  catatan: string | null;
  id_dokumen: string | null;
  nomor: string | null;
  tanggal_kedaluwarsa: string | null;
}

const web = <T>(
  aksi: string,
  body: { id?: string; tahun?: number; draft?: Isian } = {},
) => requestWebApi<T>("/api/hris/training", "POST", { aksi, ...body });

export async function ambilPelatihan(tahun?: number): Promise<{
  pelatihan: Pelatihan[];
  tahun: number;
  hari_ini: string;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_trainings", {
      idPelatihan: null,
      idKaryawan: null,
      tahun: tahun ?? null,
    });
  return web("daftar", tahun ? { tahun } : {});
}

export async function ambilRincianPelatihan(idPelatihan: string): Promise<{
  pelatihan: Pelatihan;
  peserta: Peserta[];
  rencana: RencanaPelatihan | null;
  sertifikat_aktif: boolean;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_trainings", {
      idPelatihan,
      idKaryawan: null,
      tahun: null,
    });
  return web("rincian", { id: idPelatihan });
}

export async function ambilRiwayatPelatihan(
  idKaryawan: string,
): Promise<{ riwayat: RiwayatPelatihan[] }> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_trainings", {
      idPelatihan: null,
      idKaryawan,
      tahun: null,
    });
  return web("riwayat", { id: idKaryawan });
}

/** `draft.aksi` kosong = simpan, `"batal"` = batalkan pelatihan. */
export async function simpanPelatihan(
  draft: Isian,
): Promise<Hasil<{ id_pelatihan: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_save", { draft });
  return web("simpan", { draft });
}

/** `draft.aksi`: `"tambah"` (id_karyawan = daftar id), `"lepas"`, `"hasil"`. */
export async function simpanPeserta(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_participants_save", { draft });
  return web("peserta", { draft });
}

/** `draft.aksi`: kosong = simpan, `"hapus"`, `"hapus_berkas"`. */
export async function simpanSertifikat(
  draft: Isian,
): Promise<Hasil<{ id_dokumen?: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_certificate_save", { draft });
  return web("sertifikat", { draft });
}

export async function ambilBerkasSertifikat(idBerkas: string): Promise<{
  id_berkas: string;
  nama_berkas: string | null;
  mime_type: string;
  data_base64: string;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_certificate_file", { idBerkas });
  return web("berkas", { id: idBerkas });
}

/** Pagu, rencana, dan ringkasan anggaran satu tahun (bawaan tahun berjalan). */
export async function ambilRencanaPelatihan(
  tahun?: number,
): Promise<RencanaTahunan> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_plan", { tahun: tahun ?? null });
  return web("rencana", tahun ? { tahun } : {});
}

/**
 * `draft.aksi`: kosong = simpan rencana, `"batal"` = batalkan rencana,
 * `"pagu"` = simpan pagu (`tahun`, `id_divisi` kosong = Umum, `nominal`),
 * `"hapus_pagu"` = hapus pagu (`tahun`, `id_divisi`).
 */
export async function simpanRencanaPelatihan(
  draft: Isian,
): Promise<Hasil<{ id_rencana?: string; id_anggaran?: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_training_plan_save", { draft });
  return web("rencana_simpan", { draft });
}
