"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { BRANDING } from "@/lib/constants/branding";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { IdCardElement, IdCardTemplateConfig } from "@/types/id-card";

export type { IdCardTemplateConfig } from "@/types/id-card";

function normalizeIdCardTemplate(raw: unknown): IdCardTemplateConfig {
  if (!raw || typeof raw !== "object") {
    return {
      id: "default_template",
      name: BRANDING.defaultTemplateName,
      orientation: "landscape",
      frontBgUrl: undefined,
      backBgUrl: undefined,
      elements: [],
      isActive: true,
    };
  }
  const r = raw as Record<string, unknown>;

  let elements: IdCardElement[] = [];
  const rawElements = r.elements ?? r.elements_json;
  if (Array.isArray(rawElements)) {
    elements = rawElements as IdCardElement[];
  } else if (typeof rawElements === "string" && rawElements.trim()) {
    try {
      let parsed: unknown = rawElements;
      while (typeof parsed === "string" && parsed.trim()) {
        parsed = JSON.parse(parsed);
      }
      if (Array.isArray(parsed)) {
        elements = parsed as IdCardElement[];
      }
    } catch {
      elements = [];
    }
  }

  const frontBgUrl =
    typeof r.frontBgUrl === "string" && r.frontBgUrl.trim()
      ? r.frontBgUrl
      : typeof r.front_bg_url === "string" && r.front_bg_url.trim()
        ? r.front_bg_url
        : undefined;

  const backBgUrl =
    typeof r.backBgUrl === "string" && r.backBgUrl.trim()
      ? r.backBgUrl
      : typeof r.back_bg_url === "string" && r.back_bg_url.trim()
        ? r.back_bg_url
        : undefined;

  const orientation =
    r.orientation === "portrait"
      ? ("portrait" as const)
      : ("landscape" as const);

  const isActive =
    r.isActive !== undefined
      ? Boolean(r.isActive)
      : r.is_active !== undefined
        ? Boolean(r.is_active)
        : true;

  return {
    id: String(r.id || "default_template"),
    name: String(r.name || BRANDING.defaultTemplateName),
    orientation,
    frontBgUrl,
    backBgUrl,
    elements,
    isActive,
  };
}

export async function getIdCardTemplate(
  id = "default_template",
): Promise<IdCardTemplateConfig> {
  if (isDesktopRuntime()) {
    const raw = await invokeDesktop<unknown>("desktop_get_id_card_template", {
      id,
    });
    return normalizeIdCardTemplate(raw);
  }
  const response = await requestWebApi<{ data: unknown }>(
    "/api/id-cards/templates/query",
    "POST",
    { id },
  );
  return normalizeIdCardTemplate(response.data);
}

export async function saveIdCardTemplate(
  template: IdCardTemplateConfig,
): Promise<IdCardTemplateConfig> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<unknown>(
      "desktop_save_id_card_template",
      { template },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return normalizeIdCardTemplate(result);
  }
  const response = await requestWebApi<{ data: unknown }>(
    "/api/id-cards/templates",
    "PUT",
    template,
  );
  return normalizeIdCardTemplate(response.data);
}
