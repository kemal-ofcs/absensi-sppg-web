"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop, kickDesktopSync } from "@/lib/runtime/desktop-commands";
import type { BayarDraft, DaftarCicilan } from "@/lib/validations/cicilan";

export type {
  BayarCicilan,
  BayarDraft,
  DaftarCicilan,
  KontrakCicilan,
  StatusCicilan,
  SyaratDraft,
  SyaratPengajuan,
} from "@/lib/validations/cicilan";

// Command `desktop_installment_*` terdaftar di biner Desktop DAN Mobile
// (`cicilan.rs` disalin oleh sync-rust-modules.ts).

export async function getCicilan(): Promise<DaftarCicilan> {
  if (isDesktopRuntime()) {
    return invokeDesktop<DaftarCicilan>("desktop_installment_list");
  }
  return requestWebApi<DaftarCicilan>("/api/installment/query", "POST", {});
}

/** ACC ulang membawa `sidik_syarat` yang sedang ditampilkan. */
export async function accUlangCicilan(
  idCicilan: string,
  sidikSyarat: string,
): Promise<{ sukses: boolean }> {
  const draft = { id_cicilan: idCicilan, sidik_syarat: sidikSyarat };
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_installment_reapprove",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/installment/reapprove", "POST", { draft });
}

export async function tutupCicilan(
  idCicilan: string,
  alasan: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_installment_close",
      { idCicilan, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/installment/close", "POST", {
    idCicilan,
    alasan,
  });
}

export async function catatBayarCicilan(
  draft: BayarDraft,
): Promise<{ sukses: boolean; id_bayar: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_bayar: string }>(
      "desktop_installment_payment",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/installment/payment", "POST", { draft });
}

export async function batalBayarCicilan(
  idBayar: string,
  alasan: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_installment_payment_cancel",
      { idBayar, alasan },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi("/api/installment/payment-cancel", "POST", {
    idBayar,
    alasan,
  });
}
