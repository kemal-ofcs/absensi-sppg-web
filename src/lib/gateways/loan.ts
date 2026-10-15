"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type { AksiKeputusan, PinjamanDraft } from "@/lib/validations/loan";
import type { DetailPinjaman, OrangPeminjam, PinjamanItem } from "@/types/loan";

export type { DetailPinjaman, OrangPeminjam, PinjamanItem } from "@/types/loan";

// Command `desktop_loan_*` terdaftar di biner Desktop DAN Mobile (`loan.rs`
// disalin oleh sync-rust-modules.ts), jadi satu cabang `isDesktopRuntime()`
// mencakup keduanya. Keduanya membaca dan menulis SQLite lokal + outbox.
// Nama command ditulis literal di setiap pemanggil supaya `audit:contract`
// bisa mencocokkannya dengan command yang terdaftar.

async function mutasi<T>(
  desktop: () => Promise<T>,
  url: string,
  body: unknown,
): Promise<T> {
  if (isDesktopRuntime()) {
    const result = await desktop();
    kickDesktopSync();
    return result;
  }
  return requestWebApi<T>(url, "POST", body);
}

export async function daftarPinjaman(): Promise<{ items: PinjamanItem[] }> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_loan_list");
  return requestWebApi("/api/loans/query", "POST", {});
}

export async function getPinjaman(idPinjaman: string): Promise<DetailPinjaman> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_loan_detail", { idPinjaman });
  }
  return requestWebApi("/api/loans/detail", "POST", { idPinjaman });
}

export async function daftarPeminjam(): Promise<{ items: OrangPeminjam[] }> {
  if (isDesktopRuntime()) return invokeDesktop("desktop_loan_people");
  return requestWebApi("/api/loans/people", "POST", {});
}

export function simpanPinjaman(
  draft: PinjamanDraft,
): Promise<{ sukses: boolean; id_pinjaman: string }> {
  return mutasi(
    () => invokeDesktop("desktop_loan_save", { draft }),
    "/api/loans/save",
    draft,
  );
}

export function putuskanPinjaman(
  idPinjaman: string,
  aksi: AksiKeputusan,
  idAkunKas: string | null,
): Promise<{ sukses: boolean; status: string }> {
  return mutasi(
    () => invokeDesktop("desktop_loan_decide", { idPinjaman, aksi, idAkunKas }),
    "/api/loans/decide",
    { idPinjaman, aksi, idAkunKas },
  );
}

export function lunasiPinjaman(
  idPinjaman: string,
  jumlah: number,
  idAkunKas: string | null,
): Promise<{ sukses: boolean; id_mutasi: string }> {
  return mutasi(
    () =>
      invokeDesktop("desktop_loan_pay_off", { idPinjaman, jumlah, idAkunKas }),
    "/api/loans/pay-off",
    { idPinjaman, jumlah, idAkunKas },
  );
}

export function tundaCicilan(
  idPinjaman: string,
  periode: string,
  alasan: string | null,
): Promise<{ sukses: boolean; id_tunda: string }> {
  return mutasi(
    () => invokeDesktop("desktop_loan_defer", { idPinjaman, periode, alasan }),
    "/api/loans/defer",
    { idPinjaman, periode, alasan },
  );
}

export function cabutTunda(idTunda: string): Promise<{ sukses: boolean }> {
  return mutasi(
    () => invokeDesktop("desktop_loan_undefer", { idTunda }),
    "/api/loans/undefer",
    { idTunda },
  );
}
