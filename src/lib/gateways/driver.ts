"use client";

import type { z } from "zod";
import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime, isMobileRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  batalBayarDraftSchema,
  bayarUpahDraftSchema,
  daftarTarifDraftSchema,
  FotoSegeraDihapus,
  kendaraanDraftSchema,
  laporanDraftSchema,
  lokasiDraftSchema,
  MasterPerjalanan,
  PembayaranUpahItem,
  PerjalananItem,
  PerjalananSaya,
  perjalananDraftSchema,
  RincianPerjalanan,
} from "@/lib/validations/driver";

// Bentuk kiriman: isian berbawaan (status aktif, radius, muatan) boleh absen.
type DaftarTarifDraft = z.input<typeof daftarTarifDraftSchema>;
type KendaraanDraft = z.input<typeof kendaraanDraftSchema>;
type LokasiDraft = z.input<typeof lokasiDraftSchema>;
type PerjalananDraft = z.input<typeof perjalananDraftSchema>;
type LaporanDraft = z.input<typeof laporanDraftSchema>;
type BayarUpahDraft = z.input<typeof bayarUpahDraftSchema>;
type BatalBayarDraft = z.input<typeof batalBayarDraftSchema>;

// Command `desktop_trip_*` terdaftar di biner Desktop DAN Mobile (`driver.rs`
// disalin oleh sync-rust-modules.ts). Laporan driver (foto + GPS) hanya dari
// aplikasi: Web melayani dispatcher.

type Hasil<T extends object = object> = { sukses: boolean } & T;

const HANYA_APLIKASI =
  "Laporan perjalanan driver hanya bisa dari aplikasi di HP.";

/** Mutasi lokal masuk outbox; picu sinkronisasi setelahnya. Nama command tetap
 * literal di setiap pemanggil supaya `audit:contract` bisa membacanya. */
async function laluSinkron<T>(janji: Promise<T>): Promise<T> {
  const result = await janji;
  kickDesktopSync();
  return result;
}

export async function simpanJenisKendaraan(
  draft: DaftarTarifDraft,
): Promise<Hasil<{ id: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_trip_vehicle_type_save", { draft }),
    );
  }
  return requestWebApi("/api/trips/vehicle-type", "POST", { draft });
}

export async function simpanKategoriTujuan(
  draft: DaftarTarifDraft,
): Promise<Hasil<{ id: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_trip_destination_save", { draft }),
    );
  }
  return requestWebApi("/api/trips/destination", "POST", { draft });
}

export async function simpanKendaraan(
  draft: KendaraanDraft,
): Promise<Hasil<{ id: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_vehicle_save", { draft }));
  }
  return requestWebApi("/api/trips/vehicle", "POST", { draft });
}

export async function simpanLokasi(
  draft: LokasiDraft,
): Promise<Hasil<{ id: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_place_save", { draft }));
  }
  return requestWebApi("/api/trips/place", "POST", { draft });
}

export async function simpanSuratJalan(
  draft: PerjalananDraft,
): Promise<Hasil<{ id_perjalanan: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_save", { draft }));
  }
  return requestWebApi("/api/trips", "POST", { draft });
}

export async function tandaiSuratJalanDicetak(
  idPerjalanan: string,
): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_trip_mark_printed", { idPerjalanan }),
    );
  }
  return requestWebApi("/api/trips/printed", "POST", { idPerjalanan });
}

/** `idKaryawan` kosong = kembali ke aturan bawaan (penutup `Selesai`). */
export async function aturPenerimaUpah(
  idPerjalanan: string,
  idKaryawan: string | null,
): Promise<Hasil> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_trip_wage_recipient", {
        idPerjalanan,
        idKaryawan,
      }),
    );
  }
  return requestWebApi("/api/trips/wage-recipient", "POST", {
    idPerjalanan,
    idKaryawan,
  });
}

/** Satu pembayaran upah per driver. Total dihitung backend dari upah saat ini. */
export async function catatBayarUpah(
  draft: BayarUpahDraft,
): Promise<Hasil<{ id_bayar: string; total: number }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_pay", { draft }));
  }
  return requestWebApi("/api/trips/pay", "POST", { draft });
}

export async function batalBayarUpah(
  draft: BatalBayarDraft,
): Promise<Hasil<{ id_bayar: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_pay_cancel", { draft }));
  }
  return requestWebApi("/api/trips/pay-cancel", "POST", { draft });
}

/** Surat jalan untuk rekap upah (batas lebih besar dari daftar biasa). */
export async function rekapUpah(
  dari: string,
  sampai: string,
): Promise<{ items: PerjalananItem[] }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ items: PerjalananItem[] }>(
      "desktop_trip_wage_recap",
      { dari, sampai },
    );
  }
  return requestWebApi("/api/trips/wage-recap/query", "POST", {
    dari,
    sampai,
  });
}

/** Pembayaran menurut tanggal bayar, beserta pembatalan dan surat jalannya. */
export async function daftarBayarUpah(
  dari: string,
  sampai: string,
): Promise<{ items: PembayaranUpahItem[] }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ items: PembayaranUpahItem[] }>(
      "desktop_trip_payments",
      { dari, sampai },
    );
  }
  return requestWebApi("/api/trips/payments/query", "POST", { dari, sampai });
}

/** Laporan dispatcher: ganti Langsung, setujui/tolak, Tidak Jalan, Dibatalkan, Selesai. */
export async function catatLaporanDispatcher(
  draft: LaporanDraft,
): Promise<Hasil<{ id_laporan: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(
      invokeDesktop("desktop_trip_dispatch_report", { draft }),
    );
  }
  return requestWebApi("/api/trips/report", "POST", { draft });
}

/**
 * Apakah fix GPS yang baru dipakai WebView berasal dari aplikasi pemalsu GPS
 * (`Location.isMock()`, PRD §6.2). `null` = tidak diperiksa: bukan Android,
 * tidak ada fix baru, atau pemeriksaan gagal. Tidak pernah menahan laporan.
 */
export async function periksaLokasiPalsu(): Promise<boolean | null> {
  if (isMobileRuntime()) {
    try {
      const hasil = await invokeDesktop<{ diperiksa: boolean; palsu: boolean }>(
        "mobile_location_is_mock",
      );
      return hasil.diperiksa ? hasil.palsu : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Laporan dari HP driver (foto JPEG base64 + GPS). Hanya ada di aplikasi. */
export async function catatLaporanDriver(
  draft: LaporanDraft,
  foto: { mime_type: string; data_base64: string } | null,
): Promise<Hasil<{ id_laporan: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_report", { draft, foto }));
  }
  throw new Error(HANYA_APLIKASI);
}

// ── Pembacaan layar dispatcher ─────────────────────────────────────────────

export type {
  LaporanBaris,
  MasterPerjalanan,
  MuatanBaris,
  PerjalananItem,
  RincianPerjalanan,
} from "@/lib/validations/driver";

export async function ambilMasterPerjalanan(): Promise<MasterPerjalanan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<MasterPerjalanan>("desktop_trip_master");
  }
  return requestWebApi<MasterPerjalanan>("/api/trips/master/query", "POST");
}

export async function daftarPerjalanan(
  dari: string,
  sampai: string,
): Promise<{ items: PerjalananItem[] }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ items: PerjalananItem[] }>("desktop_trip_list", {
      dari,
      sampai,
    });
  }
  return requestWebApi("/api/trips/query", "POST", { dari, sampai });
}

export async function rincianPerjalanan(
  idPerjalanan: string,
): Promise<RincianPerjalanan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<RincianPerjalanan>("desktop_trip_detail", {
      idPerjalanan,
    });
  }
  return requestWebApi("/api/trips/detail/query", "POST", { idPerjalanan });
}

export type FotoLaporan = { mime_type: string; data_base64: string };

/** `null` = foto belum sampai di cloud, atau perangkat sedang offline. */
export async function ambilFotoLaporan(
  idLaporan: string,
): Promise<FotoLaporan | null> {
  if (isDesktopRuntime()) {
    return invokeDesktop<FotoLaporan | null>("desktop_trip_report_photo", {
      idLaporan,
    });
  }
  const hasil = await requestWebApi<{ foto: FotoLaporan | null }>(
    "/api/trips/photo/query",
    "POST",
    { idLaporan },
  );
  return hasil.foto;
}

export async function simpanPrefixSuratJalan(
  prefix: string,
): Promise<Hasil<{ prefix: string }>> {
  if (isDesktopRuntime()) {
    return laluSinkron(invokeDesktop("desktop_trip_prefix_save", { prefix }));
  }
  return requestWebApi("/api/trips/prefix", "POST", { prefix });
}

// ── Layar driver (hanya aplikasi) ──────────────────────────────────────────

export type { PerjalananSaya } from "@/lib/validations/driver";

/** Perjalanan yang sedang ditugaskan kepada driver yang login. */
export async function daftarPerjalananSaya(
  dari: string,
  sampai: string,
): Promise<PerjalananSaya> {
  if (isDesktopRuntime()) {
    return invokeDesktop<PerjalananSaya>("desktop_trip_mine", { dari, sampai });
  }
  throw new Error(HANYA_APLIKASI);
}

export async function rincianPerjalananSaya(
  idPerjalanan: string,
): Promise<RincianPerjalanan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<RincianPerjalanan>("desktop_trip_my_detail", {
      idPerjalanan,
    });
  }
  throw new Error(HANYA_APLIKASI);
}

// ── Masa simpan foto 90 hari ───────────────────────────────────────────────

export type { FotoSegeraDihapus } from "@/lib/validations/driver";

/** Satu siklus penghapusan foto > 90 hari (dipanggil `AutoFotoCleanupRunner`). */
export async function bersihkanFotoLama(): Promise<{
  lokal?: number;
  cloud: number | null;
}> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_trip_photo_cleanup");
  }
  return requestWebApi("/api/trips/photo-cleanup", "POST", {});
}

/** Foto yang akan terhapus dalam 7 hari, untuk peringatan "unduh dulu". */
export async function fotoSegeraDihapus(): Promise<FotoSegeraDihapus> {
  if (isDesktopRuntime()) {
    return invokeDesktop<FotoSegeraDihapus>("desktop_trip_photo_expiring");
  }
  return requestWebApi<FotoSegeraDihapus>(
    "/api/trips/photo-expiring/query",
    "POST",
  );
}
