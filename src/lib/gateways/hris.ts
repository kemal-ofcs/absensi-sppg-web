"use client";

// HRIS fase 1 (v36). Command `desktop_hr_*` terdaftar di biner Desktop DAN
// Mobile (`hris.rs` disalin sync-rust-modules.ts). Organisasi dan kontrak
// lewat SQLite lokal + outbox; profil dan dokumen KHUSUS CLOUD (Q-30, Q-45),
// jadi hanya jalan saat perangkat terhubung ke database.

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  PengaturanKontrak,
  StatusKerja,
  TandaKontrak,
} from "@/lib/validations/hris";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface MasterOrg {
  nama: string;
  is_aktif: number;
  jumlah: number;
  nama_ganda: boolean;
  created_at?: string;
  updated_at?: string;
}
export interface Cabang extends MasterOrg {
  id_cabang: string;
  alamat: string | null;
}
export interface Divisi extends MasterOrg {
  id_divisi: string;
  nama_lama: string[];
}
export interface Jabatan extends MasterOrg {
  id_jabatan: string;
}
export interface Organisasi {
  cabang: Cabang[];
  divisi: Divisi[];
  jabatan: Jabatan[];
  tanpa_master: Array<{ teks: string; jumlah: number }>;
  atasan_siklus: string[];
  pengaturan: PengaturanKontrak;
}
export interface KontrakBaris {
  id_kontrak: string;
  id_karyawan: string;
  jenis: string;
  id_ref: string | null;
  nomor: string | null;
  tanggal_mulai: string;
  tanggal_selesai: string | null;
  percobaan_selesai: string | null;
  catatan: string | null;
  dicatat_oleh: string;
  created_at: string;
}
export interface RingkasanKontrak {
  id_karyawan: string;
  status: StatusKerja;
  tanda: TandaKontrak[];
}
export interface KontrakKaryawan extends RingkasanKontrak {
  kontrak: KontrakBaris[];
  hari_ini: string;
}
export interface Profil {
  id_karyawan: string;
  pribadi: Record<string, string | null> | null;
  keuangan: Record<string, string | null> | null;
}
export interface JenisDokumen {
  id_jenis: string;
  nama: string;
  is_aktif: number;
}
export interface BerkasRingkas {
  id_berkas: string;
  id_dokumen: string;
  urutan: number;
  nama_berkas: string | null;
  mime_type: string;
  panjang: number;
}
export interface Dokumen {
  id_dokumen: string;
  id_karyawan: string;
  id_jenis: string;
  nama_jenis: string | null;
  nomor: string | null;
  tanggal_terbit: string | null;
  tanggal_kedaluwarsa: string | null;
  catatan: string | null;
  berkas: BerkasRingkas[];
}

/** Mutasi lokal masuk outbox; picu sinkronisasi setelahnya. */
async function laluSinkron<T>(janji: Promise<T>): Promise<T> {
  const hasil = await janji;
  kickDesktopSync();
  return hasil;
}

const baca = <T>(aksi: string, id?: string) =>
  requestWebApi<T>("/api/hris/query", "POST", id ? { aksi, id } : { aksi });
const ubah = <T>(aksi: string, body: { id?: string; draft?: Isian }) =>
  requestWebApi<T>("/api/hris", "POST", { aksi, ...body });

export async function ambilOrganisasi(): Promise<Organisasi> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_org");
  return baca("org");
}

export async function simpanCabang(
  draft: Isian,
): Promise<Hasil<{ id_cabang: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_branch_save", { draft }));
  }
  return ubah("cabang", { draft });
}

export async function simpanDivisi(
  draft: Isian,
): Promise<Hasil<{ id_divisi: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_division_save", { draft }));
  }
  return ubah("divisi", { draft });
}

export async function simpanJabatan(
  draft: Isian,
): Promise<Hasil<{ id_jabatan: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_position_save", { draft }));
  }
  return ubah("jabatan", { draft });
}

export async function simpanPengaturanKontrak(
  draft: PengaturanKontrak,
): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_settings_save", { draft }));
  }
  return ubah("pengaturan", { draft: { ...draft } });
}

export async function ambilKontrakKaryawan(
  idKaryawan: string,
): Promise<KontrakKaryawan> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_contracts", { idKaryawan });
  return baca("kontrak", idKaryawan);
}

export async function ambilRingkasanKontrak(): Promise<{
  karyawan: RingkasanKontrak[];
  hari_ini: string;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_contracts", { idKaryawan: null });
  return baca("kontrak");
}

export async function catatKontrak(
  draft: Isian,
): Promise<Hasil<{ id_kontrak: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_contract_create", { draft }));
  }
  return ubah("kontrak", { draft });
}

export async function batalkanKontrak(
  idKontrak: string,
  alasan: string,
): Promise<Hasil> {
  const draft = { id_kontrak: idKontrak, alasan };
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_contract_cancel", { draft }));
  }
  return ubah("batal-kontrak", { draft });
}

export async function ambilProfil(idKaryawan: string): Promise<Profil> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_profile", { idKaryawan });
  return baca("profil", idKaryawan);
}

export async function simpanDataPribadi(
  idKaryawan: string,
  draft: Isian,
): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_profile_save_personal", {
      idKaryawan,
      draft,
    });
  }
  return ubah("pribadi", { id: idKaryawan, draft });
}

export async function simpanDataKeuangan(
  idKaryawan: string,
  draft: Isian,
): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_profile_save_finance", {
      idKaryawan,
      draft,
    });
  }
  return ubah("keuangan", { id: idKaryawan, draft });
}

export async function ambilJenisDokumen(): Promise<JenisDokumen[]> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_document_types");
  return baca("jenis-dokumen");
}

export async function simpanJenisDokumen(
  draft: Isian,
): Promise<Hasil<{ id_jenis: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_types_save", { draft });
  return ubah("jenis-dokumen", { draft });
}

export async function ambilDokumen(
  idKaryawan: string,
): Promise<{ dokumen: Dokumen[]; jenis: JenisDokumen[] }> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_documents", { idKaryawan });
  return baca("dokumen", idKaryawan);
}

export async function ambilBerkas(idBerkas: string): Promise<{
  id_berkas: string;
  nama_berkas: string | null;
  mime_type: string;
  data_base64: string;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_file", { idBerkas });
  return baca("berkas", idBerkas);
}

export async function simpanDokumen(
  draft: Isian,
): Promise<Hasil<{ id_dokumen: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_save", { draft });
  return ubah("dokumen", { draft });
}

export async function hapusDokumen(idDokumen: string): Promise<Hasil> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_delete", { idDokumen });
  return ubah("hapus-dokumen", { id: idDokumen });
}

export async function tambahBerkas(
  draft: Isian,
): Promise<Hasil<{ id_berkas: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_file_add", { draft });
  return ubah("berkas", { draft });
}

export async function hapusBerkas(idBerkas: string): Promise<Hasil> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_document_file_delete", { idBerkas });
  return ubah("hapus-berkas", { id: idBerkas });
}
