"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { getCurrentCoordinates } from "@/lib/client/geolocation";
import type { ScanResult, ScanTerminalInput } from "@/lib/contracts/scanner";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export type { ScanTerminalInput } from "@/lib/contracts/scanner";
export { getCurrentCoordinates };

export async function submitTerminalScan(input: ScanTerminalInput) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<ScanResult>("desktop_submit_qr_scan", {
      input,
    });
    void invokeDesktop("desktop_sync_now").catch(() => undefined);
    return result;
  }
  return requestWebApi<ScanResult>("/api/scanner", "POST", input);
}
