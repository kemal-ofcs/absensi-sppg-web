"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { HariLiburInput, HariLiburRecord } from "@/lib/services/holiday";

function kickDesktopSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export type { HariLiburInput, HariLiburRecord } from "@/lib/services/holiday";

export async function getDaftarHariLibur(): Promise<HariLiburRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<HariLiburRecord[]>("desktop_get_holidays");
  }
  const response = await requestWebApi<{ holidays: HariLiburRecord[] }>(
    "/api/holidays",
    "GET",
  );
  return response.holidays;
}

export async function tambahHariLibur(
  draft: HariLiburInput,
): Promise<{ sukses: boolean; id_libur: number }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id_libur: number }>(
      "desktop_create_holiday",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; id_libur: number }>(
    "/api/holidays",
    "POST",
    { draft },
  );
}

export async function updateHariLibur(
  holidayId: number,
  draft: Partial<HariLiburInput>,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_update_holiday",
      {
        holidayId,
        draft,
      },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean }>("/api/holidays", "PATCH", {
    holidayId,
    draft,
  });
}

export async function hapusHariLibur(
  holidayId: number,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_delete_holiday",
      { holidayId },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean }>("/api/holidays", "DELETE", {
    holidayId,
  });
}
