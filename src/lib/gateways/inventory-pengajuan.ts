"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type {
  DaftarPengajuan,
  FotoPenerimaan,
  HasilPenerimaan,
  KeputusanDraft,
  PenerimaanDraft,
  PengajuanDraft,
} from "@/lib/validations/inventory-pengajuan";

export type {
  BarisPengajuan,
  DaftarPengajuan,
  FotoPenerimaan,
  HasilPenerimaan,
  KeputusanDraft,
  PenerimaanDraft,
  PenerimaanPengajuan,
  Pengajuan,
  PengajuanDraft,
  StatusPengajuan,
} from "@/lib/validations/inventory-pengajuan";

// Command `desktop_inventory_request_*` terdaftar di biner Desktop DAN Mobile
// (`inventory_pengajuan.rs` disalin oleh sync-rust-modules.ts).

/** Pengajuan yang masih terbuka, plus yang sudah selesai dalam rentang tanggal. */
export async function getPengajuan(
  dari: string,
  sampai: string,
): Promise<DaftarPengajuan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DaftarPengajuan>("desktop_inventory_request_list", {
      dari,
      sampai,
    });
  }
  return requestWebApi<DaftarPengajuan>(
    "/api/inventory/request/query",
    "POST",
    { dari, sampai },
  );
}

export async function simpanPengajuan(
  draft: PengajuanDraft,
): Promise<{ sukses: boolean; id_pengajuan: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      id_pengajuan: string;
    }>("desktop_inventory_request_save", { draft });
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/request", "POST", { draft });
}

export async function batalkanPengajuan(
  idPengajuan: string,
  alasan: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_request_cancel",
      { idPengajuan, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/request/cancel", "POST", {
    idPengajuan,
    alasan,
  });
}

export async function tutupPengajuan(
  idPengajuan: string,
  alasan: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_request_close",
      { idPengajuan, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/request/close", "POST", {
    idPengajuan,
    alasan,
  });
}

/** ACC atau Tolak. ACC membawa `sidik_baris` yang sedang ditampilkan. */
export async function putuskanPengajuan(
  draft: KeputusanDraft,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_inventory_request_decide",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/inventory/request/decide", "POST", { draft });
}

/** Penerimaan berfoto; mutasi Masuk Pengadaan ditulis di transaksi yang sama. */
export async function catatPenerimaan(
  draft: PenerimaanDraft,
): Promise<HasilPenerimaan> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<HasilPenerimaan>(
      "desktop_inventory_receipt_create",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<HasilPenerimaan>("/api/inventory/receipt", "POST", {
    draft,
  });
}

/** `null` = foto belum terkirim dari perangkat pencatat, atau sedang offline. */
export async function ambilFotoPenerimaan(
  idFoto: string,
): Promise<FotoPenerimaan | null> {
  if (isDesktopRuntime()) {
    return invokeDesktop<FotoPenerimaan | null>(
      "desktop_inventory_receipt_photo",
      { idFoto },
    );
  }
  return requestWebApi<FotoPenerimaan | null>(
    "/api/inventory/receipt/photo",
    "POST",
    { idFoto },
  );
}
