"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { IdCardTemplateConfig } from "@/types/id-card";

export type { IdCardTemplateConfig } from "@/types/id-card";

export async function getIdCardTemplate(
  id = "default_template",
): Promise<IdCardTemplateConfig> {
  if (isDesktopRuntime()) {
    return invokeDesktop<IdCardTemplateConfig>("desktop_get_id_card_template", {
      id,
    });
  }
  const response = await requestWebApi<{ data: IdCardTemplateConfig }>(
    "/api/id-cards/templates/query",
    "POST",
    { id },
  );
  return response.data;
}

export async function saveIdCardTemplate(
  template: IdCardTemplateConfig,
): Promise<IdCardTemplateConfig> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<IdCardTemplateConfig>(
      "desktop_save_id_card_template",
      { template },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  const response = await requestWebApi<{ data: IdCardTemplateConfig }>(
    "/api/id-cards/templates",
    "PUT",
    template,
  );
  return response.data;
}
