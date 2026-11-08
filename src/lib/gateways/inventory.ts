"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  BarangDraft,
  DaftarInventaris,
  DaftarJurnalInventaris,
  DaftarPinjaman,
  DokumenInventaris,
  JurnalInventarisDraft,
  KartuStok,
  KolomDraft,
  MutasiDraft,
  OpnameDraft,
  PenerimaInventaris,
  RekapPengadaan,
  RiwayatOpname,
  RiwayatServis,
  ServisDraft,
  TutupServisDraft,
  UnitDraft,
} from "@/lib/validations/inventory";

export type {
  BarangDraft,
  BarangInventaris,
  BarisKartuStok,
  DaftarInventaris,
  DaftarPinjaman,
  DokumenInventaris,
  KartuStok,
  KolomDraft,
  KolomInventaris,
  MutasiDraft,
  OpnameDraft,
  PenerimaInventaris,
  PinjamanAktif,
  PosisiStok,
  RekapPengadaan,
  RiwayatOpname,
  UnitDraft,
} from "@/lib/validations/inventory";

// Command `desktop_inventory_*` terdaftar di biner Desktop DAN Mobile
// (`inventory.rs` disalin oleh sync-rust-modules.ts), jadi satu cabang
// `isDesktopRuntime()` mencakup keduanya.

export async function getInventaris(): Promise<DaftarInventaris> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DaftarInventaris>("desktop_inventory_list");
  }
  return requestWebApi<DaftarInventaris>("/api/inventory/query", "POST", {});
}

export async function getPenerimaInventaris(): Promise<PenerimaInventaris> {
  if (isDesktopRuntime()) {
    return invokeDesktop<PenerimaInventaris>("desktop_inventory_recipients");
  }
  return requestWebApi<PenerimaInventaris>(
    "/api/inventory/recipients",
    "POST",
    {},
  );
}

export async function simpanBarangInventaris(
  draft: BarangDraft,
): Promise<{ sukses: boolean; id_barang: string; kode_barang: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      id_barang: string;
      kode_barang: string;
    }>("desktop_inventory_save_item", { draft });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/item", "POST", { draft });
}

export async function simpanAwalanKodeInventaris(
  prefixes: string[],
): Promise<{ sukses: boolean; kode_prefix: string[] }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      kode_prefix: string[];
    }>("desktop_inventory_save_code_prefixes", { prefixes });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/code-prefixes", "POST", { prefixes });
}

/** Tambah, ganti nama, atau nonaktifkan kolom tambahan barang. */
export async function simpanKolomInventaris(
  draft: KolomDraft,
): Promise<{ sukses: boolean; id_kolom: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_kolom: string }>(
      "desktop_inventory_save_column",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/column", "POST", { draft });
}

/** Hapus permanen kolom tambahan beserta isinya di semua barang. */
export async function hapusKolomInventaris(
  idKolom: string,
): Promise<{ sukses: boolean; barang_dibersihkan: number }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      barang_dibersihkan: number;
    }>("desktop_inventory_delete_column", { idKolom });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/column/delete", "POST", { idKolom });
}

/** Hapus barang salah input; ditolak bila barangnya punya riwayat stok atau unit. */
export async function hapusBarangInventaris(
  idBarang: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_delete_item",
      { idBarang },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/item/delete", "POST", { idBarang });
}

export async function catatMutasiInventaris(
  draft: MutasiDraft,
): Promise<{ sukses: boolean; id_mutasi: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_mutasi: string }>(
      "desktop_inventory_record_mutation",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/mutation", "POST", { draft });
}

/** Stok aset yang belum bernomor menjadi unit; jumlahnya tidak berubah. */
export async function daftarkanUnitInventaris(
  idBarang: string,
): Promise<{ sukses: boolean; jumlah: number; nomor_dokumen: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      jumlah: number;
      nomor_dokumen: string;
    }>("desktop_inventory_register_units", { idBarang });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/units/register", "POST", { idBarang });
}

export async function simpanUnitInventaris(
  draft: UnitDraft,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_save_unit",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/units/save", "POST", { draft });
}

export async function batalkanMutasiInventaris(
  idMutasi: string,
  alasan: string,
): Promise<{ sukses: boolean; id_mutasi: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_mutasi: string }>(
      "desktop_inventory_cancel_mutation",
      { idMutasi, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/mutation/cancel", "POST", {
    idMutasi,
    alasan,
  });
}

export async function getPinjamanInventaris(): Promise<DaftarPinjaman> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DaftarPinjaman>("desktop_inventory_loans");
  }
  return requestWebApi<DaftarPinjaman>("/api/inventory/loans", "POST", {});
}

export async function catatOpnameInventaris(
  draft: OpnameDraft,
): Promise<{ sukses: boolean; nomor_dokumen: string; jumlah_selisih: number }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      nomor_dokumen: string;
      jumlah_selisih: number;
    }>("desktop_inventory_record_opname", { draft });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/opname", "POST", { draft });
}

export async function getDokumenInventaris(
  idMutasi: string,
): Promise<DokumenInventaris> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DokumenInventaris>("desktop_inventory_document", {
      idMutasi,
    });
  }
  return requestWebApi<DokumenInventaris>("/api/inventory/document", "POST", {
    idMutasi,
  });
}

export async function getRiwayatOpname(): Promise<{
  riwayat: RiwayatOpname[];
}> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ riwayat: RiwayatOpname[] }>(
      "desktop_inventory_opname_history",
    );
  }
  return requestWebApi<{ riwayat: RiwayatOpname[] }>(
    "/api/inventory/opname-history",
    "POST",
    {},
  );
}

export async function getRekapPengadaan(
  dari: string,
  sampai: string,
): Promise<RekapPengadaan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<RekapPengadaan>("desktop_inventory_procurement", {
      dari,
      sampai,
    });
  }
  return requestWebApi<RekapPengadaan>("/api/inventory/procurement", "POST", {
    dari,
    sampai,
  });
}

/** Pengadaan dan hibah yang belum dijurnal (tab "Dari Inventaris" di Keuangan). */
export async function getJurnalInventaris(
  dari: string,
  sampai: string,
): Promise<DaftarJurnalInventaris> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DaftarJurnalInventaris>(
      "desktop_inventory_journal_pending",
      { dari, sampai },
    );
  }
  return requestWebApi<DaftarJurnalInventaris>(
    "/api/inventory/journal/query",
    "POST",
    { dari, sampai },
  );
}

export async function catatJurnalInventaris(
  draft: JurnalInventarisDraft,
): Promise<{ sukses: boolean; dijurnal: number; dibalik: number }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      dijurnal: number;
      dibalik: number;
    }>("desktop_inventory_journal_post", { draft });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/journal", "POST", { draft });
}

/** Membuka servis aset, atau mengubah isian servis yang masih terbuka. */
export async function simpanServis(
  draft: ServisDraft,
): Promise<{ sukses: boolean; id_servis: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_servis: string }>(
      "desktop_inventory_service_save",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/service", "POST", { draft });
}

export async function tutupServis(
  draft: TutupServisDraft,
): Promise<{ sukses: boolean; id_servis: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_servis: string }>(
      "desktop_inventory_service_close",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/service/close", "POST", { draft });
}

export async function batalkanServis(
  idServis: string,
  alasan: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_service_cancel",
      { idServis, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/service/cancel", "POST", {
    idServis,
    alasan,
  });
}

/** Riwayat servis per rentang tanggal dibawa; `idBarang` untuk satu barang. */
export async function getRiwayatServis(
  dari: string,
  sampai: string,
  idBarang: string | null = null,
): Promise<RiwayatServis> {
  if (isDesktopRuntime()) {
    return invokeDesktop<RiwayatServis>("desktop_inventory_service_history", {
      dari,
      sampai,
      idBarang,
    });
  }
  return requestWebApi<RiwayatServis>("/api/inventory/service/query", "POST", {
    dari,
    sampai,
    idBarang,
  });
}

export async function getKartuStok(
  idBarang: string,
  tempat: string | null,
  dari: string,
  sampai: string,
): Promise<KartuStok> {
  if (isDesktopRuntime()) {
    return invokeDesktop<KartuStok>("desktop_inventory_stock_card", {
      idBarang,
      tempat,
      dari,
      sampai,
    });
  }
  return requestWebApi<KartuStok>("/api/inventory/stock-card", "POST", {
    idBarang,
    tempat,
    dari,
    sampai,
  });
}
