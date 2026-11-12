"use client";

// HRIS fase 7 (v42): rekrutmen. KHUSUS CLOUD (Q-86): command
// `desktop_hr_vacanc*`/`desktop_hr_applicant*` hanya jalan saat perangkat
// terhubung ke database. Jadikan karyawan menulis karyawan + kontrak ke SQLite
// lokal di Desktop/Mobile, jadi sesudahnya outbox didorong (atau, bila
// karyawannya sudah ada di cloud, perangkat menarik dulu).

import { requestWebApi } from "@/lib/client/api-client";
import { syncNow } from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type { StatusLowongan, Tahap } from "@/lib/validations/hr-rekrutmen";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface Lowongan {
  id_lowongan: string;
  judul: string;
  id_jabatan: string | null;
  id_divisi: string | null;
  id_cabang: string | null;
  jabatan_nama: string | null;
  divisi_nama: string | null;
  cabang_nama: string | null;
  jumlah: number;
  tanggal_buka: string;
  tanggal_tutup: string | null;
  keterangan: string | null;
  ditutup_pada: string | null;
  tanggal_ditutup: string | null;
  tutup_efektif: string | null;
  tanggal_hapus: string | null;
  pelamar_dihapus: number;
  status: StatusLowongan;
  jumlah_pelamar: number;
  jadi_karyawan: number;
  lewat_kuota: boolean;
  menggantung: number;
  hitungan: Record<string, number>;
}

export interface Pelamar {
  id_pelamar: string;
  id_lowongan: string;
  nama: string;
  no_hp: string | null;
  email: string | null;
  lp: "L" | "P" | null;
  tanggal_lahir: string | null;
  alamat: string | null;
  pendidikan: string | null;
  sumber: string | null;
  tanggal_lamaran: string;
  catatan: string | null;
  id_karyawan: string | null;
  dijadikan_oleh: string | null;
  dijadikan_pada: string | null;
  status: Tahap | null;
  jumlah_berkas: number;
  karyawan_ada: number;
  mungkin_ganda?: boolean;
}

export interface TahapPelamar {
  id_tahap: string;
  urutan: number;
  tahap: Tahap;
  tanggal: string;
  catatan: string | null;
  oleh: string;
  created_at: string;
  dibatalkan_oleh: string | null;
  dibatalkan_pada: string | null;
  alasan_batal: string | null;
}

export interface BerkasRingkas {
  id_berkas: string;
  urutan: number;
  nama_berkas: string | null;
  mime_type: string;
  panjang: number;
}

export interface IsiBerkas {
  id_berkas: string;
  nama_berkas: string | null;
  mime_type: string;
  data_base64: string;
}

export interface HasilJadikan {
  sukses: boolean;
  id_unik: string;
  token_absensi?: string;
  id_kontrak?: string;
  lanjutan?: boolean;
  /** Karyawannya sudah ada; tidak ada yang ditulis ulang. */
  sudah_ada?: "perangkat" | "cloud";
}

const web = <T>(aksi: string, body: { id?: string; draft?: Isian } = {}) =>
  requestWebApi<T>("/api/hris/recruitment", "POST", { aksi, ...body });

export async function ambilLowongan(): Promise<{
  lowongan: Lowongan[];
  hari_ini: string;
}> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_vacancies");
  return web("daftar");
}

export async function simpanLowongan(
  draft: Isian,
): Promise<Hasil<{ id_lowongan: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_vacancy_save", { draft });
  return web("simpan-lowongan", { draft });
}

export async function ambilPelamar(idLowongan: string): Promise<{
  lowongan: Lowongan;
  pelamar: Pelamar[];
  hari_ini: string;
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicants", {
      idLowongan,
      idPelamar: null,
    });
  return web("pelamar", { id: idLowongan });
}

export async function ambilRincianPelamar(idPelamar: string): Promise<{
  pelamar: Pelamar;
  tahap: TahapPelamar[];
  berkas: BerkasRingkas[];
}> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicants", {
      idLowongan: null,
      idPelamar,
    });
  return web("rincian", { id: idPelamar });
}

export async function simpanPelamar(
  draft: Isian,
): Promise<Hasil<{ id_pelamar: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicant_save", { draft });
  return web("simpan-pelamar", { draft });
}

/** `draft.aksi` kosong = catat tahap, `"batal"` = batalkan tahap terakhir. */
export async function catatTahap(
  draft: Isian,
): Promise<Hasil<{ status: Tahap | null }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicant_stage", { draft });
  return web("tahap", { draft });
}

export async function ambilBerkasPelamar(idBerkas: string): Promise<IsiBerkas> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicant_file", { idBerkas });
  return web("berkas", { id: idBerkas });
}

/** `draft.aksi` kosong = tambah berkas, `"hapus"` = hapus. */
export async function simpanBerkasPelamar(
  draft: Isian,
): Promise<Hasil<{ id_berkas?: string }>> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicant_file_save", { draft });
  return web("simpan-berkas", { draft });
}

/**
 * Jadikan karyawan (juga Lanjutkan). Desktop/Mobile: sesudah menulis, outbox
 * didorong; bila karyawannya ternyata sudah ada di cloud, perangkat menarik
 * dulu supaya muncul tanpa ditulis ulang.
 */
export async function jadikanKaryawan(draft: Isian): Promise<HasilJadikan> {
  if (isDesktopRuntime()) {
    const hasil = await invokeDesktop<HasilJadikan>(
      "desktop_hr_applicant_hire",
      { draft },
    );
    if (hasil.sudah_ada === "cloud") await syncNow();
    else kickDesktopSync();
    return hasil;
  }
  return web("jadikan", { draft });
}

export async function hapusPelamar(idPelamar: string): Promise<Hasil> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_applicant_delete", {
      draft: { id_pelamar: idPelamar },
    });
  return web("hapus", { id: idPelamar });
}

/** Retensi data pelamar (Q-93), dipanggil runner pembersihan sesi. */
export async function bersihkanPelamar(): Promise<{ dihapus: number }> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_recruit_cleanup");
  return web("bersihkan");
}
