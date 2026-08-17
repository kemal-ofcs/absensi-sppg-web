"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { RingkasanAlfa } from "@/lib/services/alfa-audit";

export type { RingkasanAlfa } from "@/lib/services/alfa-audit";

export async function getAutoAlfaSetting(): Promise<boolean> {
  if (isDesktopRuntime()) {
    const res = await invokeDesktop<{ enabled: boolean }>(
      "desktop_get_alfa_settings",
    );
    return res.enabled;
  }
  const response = await requestWebApi<{ enabled: boolean }>(
    "/api/settings/alfa",
    "GET",
  );
  return response.enabled;
}

export async function saveAutoAlfaSetting(
  enabled: boolean,
): Promise<{ sukses: boolean }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ sukses: boolean; enabled: boolean }>(
      "desktop_save_alfa_settings",
      { enabled },
    );
  }
  return requestWebApi<{ sukses: boolean }>("/api/settings/alfa", "POST", {
    enabled,
  });
}

export async function triggerGenerateAlfa(
  simulatedTime?: string,
): Promise<RingkasanAlfa> {
  if (isDesktopRuntime()) {
    return invokeDesktop<RingkasanAlfa>("desktop_trigger_generate_alfa", {
      simulatedTime,
    });
  }
  const response = await requestWebApi<{ ringkasan: RingkasanAlfa }>(
    "/api/alfa/trigger",
    "POST",
    { simulatedTime },
  );
  return response.ringkasan;
}
