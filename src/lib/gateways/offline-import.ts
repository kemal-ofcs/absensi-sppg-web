"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { OfflineImportRow } from "@/lib/services/offline-import";

export type { OfflineImportRow } from "@/lib/services/offline-import";

export interface OfflineImportResult {
  sukses: boolean;
  berhasil: number;
  gagal: number;
  results: { sukses: boolean; pesan: string; eventKey?: string }[];
}

export async function getDaftarImport(
  filter: { tanggal?: string; id_karyawan?: string; search?: string } = {},
) {
  if (isDesktopRuntime())
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_imports", {
      filter,
    });
  const result = await requestWebApi<{
    imports: Record<string, unknown>[];
  }>("/api/offline-import/query", "POST", filter);
  return result.imports;
}

export async function prosesImportOffline(rows: OfflineImportRow[]) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<OfflineImportResult>(
      "desktop_import_offline",
      { rows },
    );
    if (result.berhasil > 0)
      void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  return requestWebApi<OfflineImportResult>("/api/offline-import", "POST", {
    rows,
  });
}

export async function hapusImportOffline(eventKey: string) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan: string }>(
      "desktop_delete_import_offline",
      { eventKey },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string }>(
    "/api/operational",
    "DELETE",
    { event_key: eventKey },
  );
}
