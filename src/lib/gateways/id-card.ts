"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { IdCardUpdateInput } from "@/lib/services/idcard";

export type { IdCardUpdateInput } from "@/lib/services/idcard";
export async function getDaftarIdCard(
  filter: { status?: string; search?: string } = {},
) {
  if (isDesktopRuntime())
    return invokeDesktop<Record<string, unknown>[]>("desktop_get_id_cards", {
      filter,
    });
  const result = await requestWebApi<{ data: Record<string, unknown>[] }>(
    "/api/id-cards/query",
    "POST",
    filter,
  );
  return result.data;
}
export async function updateStatusIdCard(draft: IdCardUpdateInput) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: true }>(
      "desktop_update_id_card",
      { draft },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  return requestWebApi<{ sukses: true }>("/api/id-cards", "PUT", draft);
}
