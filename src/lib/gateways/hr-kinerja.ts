"use client";

// HRIS fase 6 (v41): penilaian kinerja. Command `desktop_hr_performance*`
// terdaftar di biner Desktop DAN Mobile (`hr_kinerja.rs` disalin
// sync-rust-modules.ts); semua lewat SQLite lokal + outbox. SP dalam periode
// dibaca dari cloud saat terhubung.

import { requestWebApi } from "@/lib/client/api-client";
import { syncNow } from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  BarisNilai,
  Disiplin,
  KeputusanKinerja,
  PengaturanKinerja,
  StatusKinerja,
} from "@/lib/validations/hr-kinerja";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface AspekTemplate {
  id_aspek: string;
  id_template: string;
  nama: string;
  tipe: string;
  bobot: number;
  panduan: string | null;
  urutan: number;
  is_aktif: number;
}

export interface TemplateKinerja {
  id_template: string;
  nama: string;
  keterangan: string | null;
  is_bawaan: number;
  is_aktif: number;
  diubah_oleh: string;
  aspek: AspekTemplate[];
  /** Jabatan yang dipetakan ke template ini. */
  jabatan: string[];
  nama_ganda: boolean;
}

export interface DaftarTemplateKinerja {
  template: TemplateKinerja[];
  jabatan: {
    id_jabatan: string;
    nama: string;
    is_aktif: number;
    id_template: string | null;
  }[];
  pengaturan: PengaturanKinerja;
}

/** Satu penilaian di daftar dan rincian: baris tabel + turunan. */
export interface PenilaianKinerja {
  id_penilaian: string;
  id_karyawan: string;
  id_ref: string | null;
  alasan_koreksi: string | null;
  periode_jenis: string;
  periode_mulai: string;
  periode_selesai: string;
  id_template: string;
  template_nama: string;
  id_jabatan: string | null;
  jabatan_nama: string | null;
  id_penilai: string | null;
  penilai_oleh: string;
  catatan: string | null;
  sidik: string;
  dibuat_oleh: string;
  status: StatusKinerja;
  tanda: string[];
  /** Nilai akhir ×100 keputusan Final yang berlaku. */
  nilai_akhir: number | null;
  nilai_teks: string | null;
  predikat: string | null;
  nama: string | null;
  divisi: string | null;
  atasan_saya: boolean;
  /** Hanya di daftar: nilai ini yang berlaku di antara akar dan koreksinya. */
  berlaku?: boolean;
}

export interface BelumDinilai {
  id_karyawan: string;
  nama: string;
  divisi: string;
  jabatan_nama: string | null;
  /** Kosong = belum bisa dinilai (tanpa template dan tanpa bawaan). */
  id_template: string | null;
  template_nama: string | null;
  atasan_saya: boolean;
}

export interface DaftarKinerja {
  periode: {
    jenis: string;
    mulai: string;
    selesai: string;
    bisa_diajukan: boolean;
  };
  pengaturan: PengaturanKinerja;
  penilaian: PenilaianKinerja[];
  belum_dinilai: BelumDinilai[];
}

export interface SpPeriode {
  id_sp: string;
  tingkat: string;
  tanggal: string;
  berlaku_sampai: string;
  nomor: string | null;
  pelanggaran: string;
}

export interface RincianKinerja {
  penilaian: PenilaianKinerja;
  nilai: BarisNilai[];
  keputusan: KeputusanKinerja[];
  /** Hitungan hidup; kosong bila template tanpa aspek disiplin. */
  disiplin: Disiplin | null;
  disiplin_berubah: boolean;
  riwayat: PenilaianKinerja[];
  id_akar: string;
  id_berlaku: string | null;
  /** Aksi yang terbuka untuk sesi ini (`Simpan`, `Ajukan`, ...). */
  boleh: Record<string, boolean>;
  pengaturan: PengaturanKinerja;
  /** `null` saat perangkat tidak terhubung ke database pusat. */
  sp: SpPeriode[] | null;
  sp_pesan?: string;
}

export interface HasilSimpanKinerja {
  sukses: boolean;
  id_penilaian: string;
  sidik: string;
  disiplin: Disiplin | null;
  status: StatusKinerja;
}

export const PESAN_SINKRON_GAGAL =
  "Data absensi mungkin belum terbaru; angka disiplin dihitung dari data di perangkat ini.";

/** Mutasi lokal masuk outbox; picu sinkronisasi setelahnya. */
async function laluSinkron<T>(janji: Promise<T>): Promise<T> {
  const hasil = await janji;
  kickDesktopSync();
  return hasil;
}

const web = <T>(aksi: string, body: { id?: string; draft?: Isian } = {}) =>
  requestWebApi<T>("/api/hris/performance", "POST", { aksi, ...body });

export async function ambilTemplateKinerja(): Promise<DaftarTemplateKinerja> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_performance_templates");
  }
  return web("templates");
}

export async function simpanTemplateKinerja(
  draft: Isian,
): Promise<Hasil<{ id_template: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_performance_template_save", { draft }),
    );
  }
  return web("simpan-template", { draft });
}

export async function simpanPengaturanKinerja(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_performance_settings_save", { draft }),
    );
  }
  return web("pengaturan", { draft });
}

export async function ambilDaftarKinerja(
  filter: Isian,
): Promise<DaftarKinerja> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_performance_list", { filter });
  }
  return web("daftar", { draft: filter });
}

export async function ambilRincianKinerja(
  idPenilaian: string,
): Promise<RincianKinerja> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_performance_detail", { idPenilaian });
  }
  return web("rincian", { id: idPenilaian });
}

/** Buat, ubah draf, muat ulang template (`muat_ulang`), atau buat koreksi. */
export async function simpanPenilaianKinerja(
  draft: Isian,
): Promise<HasilSimpanKinerja> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_performance_save", { draft }));
  }
  return web("simpan", { draft });
}

/** Kembalikan, Final, atau Batal. Ajukan lewat `ajukanPenilaianKinerja`. */
export async function putuskanPenilaianKinerja(
  draft: Isian,
): Promise<Hasil<{ id_keputusan: string; status: StatusKinerja }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_performance_decide", { draft }),
    );
  }
  return web("putuskan", { draft });
}

export interface HasilAjukan {
  sukses: boolean;
  status?: StatusKinerja;
  /** Ajukan berhenti: angka disiplin berubah, tampilkan lama → baru. */
  disiplin_berubah?: { lama: string | null; baru: string | null };
  /** Sinkron gagal; Ajukan tetap jalan dengan data perangkat. */
  peringatan?: string;
}

/**
 * Ajukan (Q-72, §21.4): simpan ulang draf dengan isian form lengkap supaya
 * disiplin dihitung dari data terbaru; bila `rincian` berubah dari
 * `rincianLama`, berhenti dan penilai menekan Ajukan sekali lagi.
 * Desktop/Mobile menjalankan sinkron lebih dulu; Web selalu membaca cloud.
 */
export async function ajukanPenilaianKinerja(
  draft: Isian,
  rincianLama: string | null,
): Promise<HasilAjukan> {
  const putus = { id_penilaian: draft.id_penilaian, aksi: "Ajukan" };
  let peringatan: string | undefined;
  if (isDesktopRuntime()) {
    try {
      await syncNow();
    } catch {
      peringatan = PESAN_SINKRON_GAGAL;
    }
  }
  const simpan = await simpanPenilaianKinerja(draft);
  const baru = simpan.disiplin?.rincian ?? null;
  if (baru !== rincianLama) {
    return {
      sukses: false,
      disiplin_berubah: { lama: rincianLama, baru },
      peringatan,
    };
  }
  const hasil = await putuskanPenilaianKinerja(putus);
  return { ...hasil, peringatan };
}
