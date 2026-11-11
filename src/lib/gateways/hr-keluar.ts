"use client";

// HRIS fase 5 (v40): surat peringatan dan karyawan keluar. KHUSUS CLOUD
// (Q-63): command `desktop_hr_warning*`/`desktop_hr_offboarding*` hanya jalan
// saat perangkat terhubung ke database. Berlakukan/Batalkan mengubah
// `master_data` di cloud, jadi perangkat ditarik ulang sesudahnya.

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  KomponenRincian,
  StatusKeluar,
  StatusSp,
  TingkatSp,
} from "@/lib/validations/hr-keluar";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface SuratPeringatan {
  id_sp: string;
  id_karyawan: string;
  tingkat: TingkatSp;
  tanggal: string;
  masa_bulan: number;
  berlaku_sampai: string;
  nomor: string | null;
  pelanggaran: string;
  harapan: string | null;
  usulan_tingkat: TingkatSp;
  alasan_tingkat: string | null;
  penanda_nama: string;
  penanda_jabatan: string;
  dicatat_oleh: string;
  created_at: string;
  dicabut_oleh: string | null;
  dicabut_pada: string | null;
  alasan_cabut: string | null;
  status: StatusSp;
  nama?: string | null;
  divisi?: string | null;
}

export interface KopSurat {
  company_name: string | null;
  logo_url: string | null;
  address: string | null;
}

export interface DaftarSp {
  sp: SuratPeringatan[];
  usulan?: { tingkat: TingkatSp; sp3_berlaku: boolean };
  masa_bulan?: number;
  penanda_terakhir?: { nama: string; jabatan: string } | null;
  kop?: KopSurat | null;
  hari_ini: string;
}

export interface AlasanKeluar {
  id_alasan: string;
  nama: string;
  pengali_up: number;
  pengali_upmk: number;
  uph: number;
  kompensasi_pkwt: number;
  uang_pisah: number;
  dasar_hukum: string | null;
  is_aktif: number;
}

export interface KeluarRingkas {
  id_keluar: string;
  id_karyawan: string;
  nama: string | null;
  divisi: string | null;
  alasan_nama: string;
  tanggal_pemberitahuan: string | null;
  tanggal_terakhir: string;
  berlaku_oleh: string | null;
  berlaku_pada: string | null;
  dibatalkan_oleh: string | null;
  dibatalkan_pada: string | null;
  alasan_batal: string | null;
  total: number;
  status: StatusKeluar;
}

export interface DaftarKeluar {
  keluar: KeluarRingkas[];
  alasan: AlasanKeluar[];
  hari_ini: string;
}

export interface UsulanRincian {
  komponen: KomponenRincian;
  dasar: string | null;
  usulan: number;
}

export interface RincianTersimpan extends UsulanRincian {
  id_rincian: string;
  nominal: number;
  alasan_ubah: string | null;
  urutan: number;
}

export interface ChecklistKeluar {
  barang: Array<{
    id_mutasi: string;
    nama_barang: string;
    kode_barang: string;
    satuan: string;
    tanggal: string;
    jumlah: number;
    kembali: number;
    desimal: number;
  }>;
  kasbon: Array<{
    id_pinjaman: string;
    tanggal_cair: string | null;
    pokok: number;
    sisa: number;
  }>;
  sisa_kasbon: number;
  klaim: Array<{
    id_klaim: string;
    sumber: string;
    tanggal: string;
    nominal: number;
    keterangan: string;
    status_bayar: string;
  }>;
  pengajuan: Array<{
    id_pengajuan: string;
    tanggal_mulai: string;
    tanggal_selesai: string;
    jenis: string;
  }>;
}

export interface PratinjauKeluar {
  karyawan: {
    id_unik: string;
    nama: string;
    divisi: string | null;
    jabatan_status: string | null;
    status_aktif: string;
    tanggal_daftar: string | null;
    id_keluar: string | null;
  };
  usulan: UsulanRincian[];
  data: {
    tanggal_daftar: string | null;
    usulan_upah_pokok: number;
    sisa_cuti: number;
    upah_harian: number;
    pkwt_mulai: string | null;
    tunjangan_acuan: Array<{
      name: string;
      calc_type: string;
      default_value: number;
    }>;
  };
  checklist: ChecklistKeluar;
  akun: Array<{
    id: number;
    username: string;
    nama_operator: string;
    status: string;
    is_superadmin: number;
  }>;
  alasan: AlasanKeluar;
  hari_ini: string;
}

export interface RincianKeluar extends PratinjauKeluar {
  keluar: KeluarRingkas & {
    id_alasan: string;
    id_sp: string | null;
    keterangan: string | null;
    masa_kerja_mulai: string | null;
    upah_pokok: number;
    usulan_upah_pokok: number;
    alasan_upah: string | null;
    tunjangan_tetap: number;
    kartu_ditarik: number;
    catatan_checklist: string | null;
    checklist_saat_berlaku: string | null;
    dicatat_oleh: string;
    created_at: string;
  };
  rincian: RincianTersimpan[];
}

const web = <T>(aksi: string, body: { id?: string; draft?: Isian } = {}) =>
  requestWebApi<T>("/api/hris/offboarding", "POST", { aksi, ...body });

/** Status karyawan berubah di cloud; tarik ulang supaya perangkat ikut. */
async function laluTarik<T>(janji: Promise<T>): Promise<T> {
  const hasil = await janji;
  kickDesktopSync();
  return hasil;
}

export async function ambilSp(idKaryawan?: string): Promise<DaftarSp> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_warnings", {
      idKaryawan: idKaryawan ?? null,
    });
  }
  return web("sp-daftar", idKaryawan ? { id: idKaryawan } : {});
}

export async function simpanSp(
  draft: Isian,
): Promise<Hasil<{ id_sp: string }>> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_warning_save", { draft });
  }
  return web("sp-simpan", { draft });
}

export async function cabutSp(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_warning_revoke", { draft });
  }
  return web("sp-cabut", { draft });
}

export async function ambilDaftarKeluar(): Promise<DaftarKeluar> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_offboardings");
  return web("daftar");
}

export async function ambilRincianKeluar(
  idKeluar: string,
): Promise<RincianKeluar> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_offboarding", {
      idKeluar,
      idKaryawan: null,
      idAlasan: null,
      tanggalTerakhir: null,
    });
  }
  return web("rincian", { id: idKeluar });
}

export async function ambilPratinjauKeluar(
  idKaryawan: string,
  idAlasan: string,
  tanggalTerakhir: string,
): Promise<PratinjauKeluar> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_offboarding", {
      idKeluar: null,
      idKaryawan,
      idAlasan,
      tanggalTerakhir,
    });
  }
  return web("pratinjau", {
    draft: {
      id_karyawan: idKaryawan,
      id_alasan: idAlasan,
      tanggal_terakhir: tanggalTerakhir,
    },
  });
}

export async function simpanKeluar(
  draft: Isian,
): Promise<Hasil<{ id_keluar: string }>> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_offboarding_save", { draft });
  }
  return web("simpan", { draft });
}

export async function berlakukanKeluar(idKeluar: string): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluTarik(
      invokeDesktop("desktop_hr_offboarding_apply", { idKeluar }),
    );
  }
  return web("berlakukan", { id: idKeluar });
}

export async function batalkanKeluar(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluTarik(invokeDesktop("desktop_hr_offboarding_cancel", { draft }));
  }
  return web("batalkan", { draft });
}

export async function simpanAlasanKeluar(
  draft: Isian,
): Promise<Hasil<{ id_alasan: string }>> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_exit_reasons_save", { draft });
  }
  return web("alasan", { draft });
}
