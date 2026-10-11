"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { HolidayWhitelistInput } from "@/lib/services/holiday-whitelist";
import type { HolidayWhitelistEntry } from "@/lib/validations/holiday-whitelist";

function kickDesktopSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export type { HolidayWhitelistInput } from "@/lib/services/holiday-whitelist";
export type { HolidayWhitelistEntry } from "@/lib/validations/holiday-whitelist";

export async function getHolidayWhitelist(): Promise<HolidayWhitelistEntry[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<HolidayWhitelistEntry[]>(
      "desktop_get_holiday_whitelist",
    );
  }
  const response = await requestWebApi<{ whitelist: HolidayWhitelistEntry[] }>(
    "/api/holidays/whitelist/query",
    "POST",
    {},
  );
  return response.whitelist;
}

export async function tambahHolidayWhitelist(
  draft: HolidayWhitelistInput,
): Promise<{ sukses: boolean; id: string }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; id: string }>(
      "desktop_create_holiday_whitelist",
      { draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; id: string }>(
    "/api/holidays/whitelist",
    "POST",
    { draft },
  );
}

export async function updateHolidayWhitelist(
  whitelistId: string,
  draft: HolidayWhitelistInput,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_update_holiday_whitelist",
      { whitelistId, draft },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean }>(
    "/api/holidays/whitelist",
    "PATCH",
    { whitelistId, draft },
  );
}

export async function hapusHolidayWhitelist(
  whitelistId: string,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean }>(
      "desktop_delete_holiday_whitelist",
      { whitelistId },
    );
    kickDesktopSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean }>(
    "/api/holidays/whitelist",
    "DELETE",
    { whitelistId },
  );
}
