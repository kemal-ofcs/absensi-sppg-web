"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { ScannerSafetySettings } from "@/lib/validations/scanner-settings";

export type { ScannerSafetySettings } from "@/lib/validations/scanner-settings";

export async function getScannerSafetySettings() {
  if (isDesktopRuntime()) {
    return invokeDesktop<ScannerSafetySettings>("desktop_get_scanner_settings");
  }
  const response = await requestWebApi<{ data: ScannerSafetySettings }>(
    "/api/settings/scanner",
    "POST",
    {},
  );
  return response.data;
}

export async function saveScannerSafetySettings(
  settings: ScannerSafetySettings,
) {
  if (isDesktopRuntime()) {
    return invokeDesktop<ScannerSafetySettings>(
      "desktop_update_scanner_settings",
      {
        settings,
      },
    );
  }
  const response = await requestWebApi<{ data: ScannerSafetySettings }>(
    "/api/settings/scanner",
    "PUT",
    settings,
  );
  return response.data;
}
