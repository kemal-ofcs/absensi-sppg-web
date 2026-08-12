"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { KoreksiInput } from "@/lib/services/correction";

export type { KoreksiInput } from "@/lib/services/correction";

function kickSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export async function getDaftarKoreksi(
  filter: { tanggal?: string; id_karyawan?: string } = {},
) {
  if (isDesktopRuntime())
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_corrections", {
      filter,
    });
  const result = await requestWebApi<{
    corrections: Record<string, unknown>[];
  }>("/api/corrections/query", "POST", filter);
  return result.corrections;
}

export async function prosesKoreksiAdmin(
  input: Omit<KoreksiInput, "kode_operator">,
) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      pesan: string;
      id_referensi?: string;
    }>("desktop_create_correction", { draft: input });
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{
    sukses: boolean;
    pesan: string;
    id_referensi?: string;
  }>("/api/corrections", "POST", input);
}
