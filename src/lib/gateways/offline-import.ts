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
