"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { ShiftInput } from "@/lib/services/shift";

function kickDesktopSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export type { ShiftInput } from "@/lib/services/shift";

export async function getDaftarShift() {
  if (isDesktopRuntime()) {
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_shifts");
  }
  const response = await requestWebApi<{
    shifts: Record<string, unknown>[];
  }>("/api/shifts/query", "POST");
  return response.shifts;
}

export async function tambahShift(draft: ShiftInput) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true; id_shift: number }>(
      "desktop_create_shift",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true; id_shift: number }>(
    "/api/shifts",
    "POST",
    { draft },
  );
}

export async function updateShift(shiftId: number, draft: Partial<ShiftInput>) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true }>(
      "desktop_update_shift",
      {
        shiftId,
        draft,
      },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: true }>("/api/shifts", "PATCH", {
    shiftId,
    draft,
  });
}

export async function hapusShift(shiftId: number) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan?: string }>(
      "desktop_delete_shift",
      { shiftId },
    );
    if (result.sukses) kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan?: string }>(
    "/api/shifts",
    "DELETE",
    { shiftId },
  );
}
