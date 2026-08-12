"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { PenugasanBackupInput } from "@/lib/services/backup";

export type { PenugasanBackupInput } from "@/lib/services/backup";

function kickSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export async function getDaftarBackup(
  filter: { tanggal?: string; status_tugas?: string } = {},
) {
  if (isDesktopRuntime())
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_backups", {
      filter,
    });
  const result = await requestWebApi<{ backups: Record<string, unknown>[] }>(
    "/api/backups/query",
    "POST",
    filter,
  );
  return result.backups;
}

export async function buatPenugasanBackup(
  input: Omit<PenugasanBackupInput, "kode_operator">,
) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{
      sukses: boolean;
      pesan: string;
      id_backup?: string;
    }>("desktop_create_backup", { draft: input });
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string; id_backup?: string }>(
    "/api/backups",
    "POST",
    input,
  );
}

export async function batalkanPenugasanBackup(idBackup: string) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan: string }>(
      "desktop_cancel_backup",
      { idBackup },
    );
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string }>(
    "/api/backups",
    "DELETE",
    { id_backup: idBackup },
  );
}
