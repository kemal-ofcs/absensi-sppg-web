"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { BRANDING } from "@/lib/constants/branding";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export async function getAppDisplayName(): Promise<string> {
  if (isDesktopRuntime()) {
    try {
      const result = await invokeDesktop<string>(
        "desktop_get_app_display_name",
      );
      return result?.trim() || BRANDING.appDisplayName;
    } catch {
      return BRANDING.appDisplayName;
    }
  }
  try {
    const response = await requestWebApi<{ data: string }>(
      "/api/settings/app-name",
      "POST",
      {},
    );
    return response.data?.trim() || BRANDING.appDisplayName;
  } catch {
    return BRANDING.appDisplayName;
  }
}

export async function saveAppDisplayName(name: string): Promise<string> {
  const resolved = name.trim() || BRANDING.appDisplayName;
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<string>(
      "desktop_update_app_display_name",
      {
        name: resolved,
      },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result || resolved;
  }
  const response = await requestWebApi<{ data: string }>(
    "/api/settings/app-name",
    "PUT",
    { appDisplayName: resolved },
  );
  return response.data || resolved;
}
