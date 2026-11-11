"use client";

// HRIS fase 2 (v37): pengajuan cuti/izin/sakit dan jatah cuti. Command
// `desktop_hr_request*`/`desktop_hr_leave*` terdaftar di biner Desktop DAN
// Mobile (`hr_pengajuan.rs` disalin sync-rust-modules.ts). Pengajuan,
// keputusan, dan penyesuaian lewat SQLite lokal + outbox; lampiran KHUSUS
// CLOUD (Q-51), jadi hanya jalan saat perangkat terhubung ke database.

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  AturanCuti,
  AturanLembur,
  BarisReimburse,
  BayarReimburse,
  JenisPengajuan,
  Klaim,
  PeriodeCuti,
  StatusBayar,
  StatusPengajuan,
} from "@/lib/validations/hr-pengajuan";

type Isian = Record<string, unknown>;
type Hasil<T extends object = object> = { sukses: boolean } & T;

export interface Pengajuan {
  id_pengajuan: string;
  id_karyawan: string;
  id_jenis: string;
  kelompok: string;
  potong_jatah: boolean;
  dampak_gaji: string;
  tanggal_mulai: string;
  tanggal_selesai: string;
  setengah_hari: boolean;
  alasan: string;
  sidik: string;
  diajukan_oleh: string;
  waktu_perangkat: string;
  created_at: string;
  /** Lembur (v38). */
  jam_mulai: string | null;
  jam_selesai: string | null;
  /** Tukar Shift (v38). */
  id_karyawan_tukar: string | null;
  id_shift_asal: number | null;
  id_shift_tukar: number | null;
  /** Reimburse (v39): rupiah yang diajukan. */
  nominal: number | null;
}

export interface BarisDaftarPengajuan {
  pengajuan: Pengajuan;
  nama_karyawan: string | null;
  nama_karyawan_tukar: string | null;
  menit_lembur: number | null;
  nama_jenis: string | null;
  izin_pemutus: string;
  wajib_dokumen: boolean;
  status: StatusPengajuan;
  tanda: string[];
  hari_kerja: number;
  sudah_diketahui: boolean;
  /** Reimburse berlaku: nominal disetujui (kosong = diajukan). */
  nominal_berlaku: number | null;
  /** Hanya Reimburse. */
  status_bayar: StatusBayar | null;
  batas_bulanan: number | null;
}

export interface DaftarPengajuan {
  pengajuan: BarisDaftarPengajuan[];
  jenis: JenisPengajuan[];
  aturan_lembur: AturanLembur;
  mode_reimburse: string;
}

export interface KeputusanRiwayat {
  id_keputusan: string;
  jenis: string;
  sidik: string;
  alasan: string | null;
  oleh: string;
  waktu_perangkat: string;
  diterima_cloud: string | null;
  nominal_disetujui: number | null;
}

export interface PenyesuaianCuti {
  baris: {
    id_penyesuaian: string;
    periode: string;
    jenis: string;
    hari: number;
    nominal: number | null;
    alasan: string;
    dicatat_oleh: string;
    created_at: string;
  };
  dibatalkan: boolean;
  /** Hanya `Diuangkan` (Q-62). */
  status_bayar?: StatusBayar | null;
}

export interface JatahCuti {
  aturan: AturanCuti;
  tanggal_masuk: string | null;
  periode: PeriodeCuti[];
  penyesuaian: PenyesuaianCuti[];
}

export interface AkhirPeriode {
  aturan: AturanCuti;
  aturan_lembur: AturanLembur;
  mode_reimburse: string;
  belum_diproses: Array<{
    id_karyawan: string;
    nama: string;
    periode: PeriodeCuti;
  }>;
  diuangkan: Array<{
    nama: string;
    baris: PenyesuaianCuti["baris"];
    status_bayar: StatusBayar | null;
  }>;
}

export interface RingkasanReimburse {
  mode: string;
  belum_dibayar: Array<{ klaim: Klaim; nama: string | null }>;
  proses_gaji: Array<{ klaim: Klaim; nama: string | null }>;
  riwayat: Array<{
    bayar: BayarReimburse;
    nama: string | null;
    batal: BayarReimburse | null;
    baris: Array<{ baris: BarisReimburse; keterangan: string | null }>;
  }>;
}

export interface LampiranRingkas {
  id_berkas: string;
  urutan: number;
  nama_berkas: string | null;
  mime_type: string;
  diunggah_oleh: string;
  created_at: string;
}

/** Mutasi lokal masuk outbox; picu sinkronisasi setelahnya. */
async function laluSinkron<T>(janji: Promise<T>): Promise<T> {
  const hasil = await janji;
  kickDesktopSync();
  return hasil;
}

const web = <T>(aksi: string, body: { id?: string; draft?: Isian } = {}) =>
  requestWebApi<T>("/api/hris/requests", "POST", { aksi, ...body });

export async function ambilPengajuan(filter: Isian): Promise<DaftarPengajuan> {
  if (isDesktopRuntime())
    return invokeDesktop("desktop_hr_requests", { filter });
  return web("daftar", { draft: filter });
}

export async function ambilRiwayatKeputusan(
  idPengajuan: string,
): Promise<{ keputusan: KeputusanRiwayat[] }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_request_detail", { idPengajuan });
  }
  return web("rincian", { id: idPengajuan });
}

export async function simpanPengajuan(
  draft: Isian,
): Promise<Hasil<{ id_pengajuan: string; hari_kerja: number }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_request_save", { draft }));
  }
  return web("ajukan", { draft });
}

export async function putuskanPengajuan(
  draft: Isian,
): Promise<Hasil<{ id_keputusan: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_request_decide", { draft }));
  }
  return web("putuskan", { draft });
}

export async function simpanJenisPengajuan(
  draft: Isian,
): Promise<Hasil<{ id_jenis: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_request_types_save", { draft }),
    );
  }
  return web("jenis", { draft });
}

export async function simpanAturanCuti(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_leave_settings_save", { draft }),
    );
  }
  return web("aturan", { draft });
}

export async function ambilJatahCuti(idKaryawan: string): Promise<JatahCuti> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_leave_balance", { idKaryawan });
  }
  return web("jatah", { id: idKaryawan });
}

export async function simpanPenyesuaianCuti(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_leave_adjust", { draft }));
  }
  return web("penyesuaian", { draft });
}

export async function batalkanPenyesuaianCuti(draft: Isian): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_leave_adjust_cancel", { draft }),
    );
  }
  return web("batal-penyesuaian", { draft });
}

export async function ambilAkhirPeriode(): Promise<AkhirPeriode> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_hr_leave_periods");
  return web("akhir-periode");
}

export async function prosesAkhirPeriode(
  draft: Isian,
): Promise<Hasil<{ hari: number; nominal: number }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_leave_period_close", { draft }),
    );
  }
  return web("proses-periode", { draft });
}

export async function ambilLampiran(
  idPengajuan: string,
): Promise<{ berkas: LampiranRingkas[] }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_request_files", { idPengajuan });
  }
  return web("lampiran", { id: idPengajuan });
}

export async function ambilIsiLampiran(idBerkas: string): Promise<{
  id_berkas: string;
  nama_berkas: string | null;
  mime_type: string;
  data_base64: string;
}> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_request_file", { idBerkas });
  }
  return web("berkas", { id: idBerkas });
}

export async function tambahLampiran(
  draft: Isian,
): Promise<Hasil<{ id_berkas: string }>> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_request_file_add", { draft });
  }
  return web("tambah-berkas", { draft });
}

export async function hapusLampiran(idBerkas: string): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_request_file_delete", { idBerkas });
  }
  return web("hapus-berkas", { id: idBerkas });
}

// ── HRIS fase 4 (v39): pembayaran terpisah reimbursement dan cuti diuangkan ──

export async function ambilRingkasanReimburse(
  dari: string,
  sampai: string,
): Promise<RingkasanReimburse> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_hr_reimburse_overview", { dari, sampai });
  }
  return web("bayar-ringkasan", { draft: { dari, sampai } });
}

export async function bayarReimburse(
  draft: Isian,
): Promise<Hasil<{ id_bayar: string; total: number }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_hr_reimburse_pay", { draft }));
  }
  return web("bayar", { draft });
}

export async function batalkanBayarReimburse(
  draft: Isian,
): Promise<Hasil<{ id_bayar: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_hr_reimburse_pay_cancel", { draft }),
    );
  }
  return web("batal-bayar", { draft });
}
