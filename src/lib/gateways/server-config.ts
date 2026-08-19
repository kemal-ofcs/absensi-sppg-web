"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export async function getServerUrl(): Promise<string> {
  if (!isDesktopRuntime()) return "https://absensi-sppg-seven.vercel.app";
  try {
    return await invokeDesktop<string>("desktop_get_server_url");
  } catch {
    return "https://absensi-sppg-seven.vercel.app";
  }
}

export async function setServerUrl(url: string): Promise<string> {
  if (!isDesktopRuntime()) return url;
  return invokeDesktop<string>("desktop_set_server_url", { url });
}
