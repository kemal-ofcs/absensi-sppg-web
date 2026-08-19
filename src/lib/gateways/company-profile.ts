"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  CompanyProfile,
  CompanyProfileInput,
} from "@/types/company-profile";

export type {
  CompanyProfile,
  CompanyProfileInput,
} from "@/types/company-profile";

export async function getCompanyProfile(): Promise<CompanyProfile> {
  if (isDesktopRuntime()) {
    return invokeDesktop<CompanyProfile>("desktop_get_company_profile");
  }
  const response = await requestWebApi<{ data: CompanyProfile }>(
    "/api/settings/company-profile/query",
    "POST",
    {},
  );
  return response.data;
}

export async function updateCompanyProfile(
  input: CompanyProfileInput,
): Promise<CompanyProfile> {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<CompanyProfile>(
      "desktop_update_company_profile",
      { profile: input },
    );
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  const response = await requestWebApi<{ data: CompanyProfile }>(
    "/api/settings/company-profile",
    "PUT",
    input,
  );
  return response.data;
}
