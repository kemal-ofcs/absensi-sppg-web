"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface TursoConnectionStatus {
  connected: boolean;
  url: string;
  latency_ms?: number | null;
  error_message?: string | null;
}

export async function getTursoUrl(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invokeDesktop<string | null>("desktop_get_turso_url");
  } catch {
    return null;
  }
}

export async function saveTursoConfig(
  databaseUrl: string,
  authToken: string,
): Promise<string> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Penyimpanan konfigurasi database hanya didukung pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<string>("desktop_save_turso_config", {
    databaseUrl,
    authToken,
  });
}

export async function testTursoConnection(
  databaseUrl?: string,
  authToken?: string,
): Promise<TursoConnectionStatus> {
  if (!isDesktopRuntime()) {
    return {
      connected: false,
      url: databaseUrl ?? "",
      error_message:
        "Pengujian koneksi hanya tersedia pada runtime desktop/mobile.",
    };
  }
  return invokeDesktop<TursoConnectionStatus>("desktop_test_turso_connection", {
    databaseUrl: databaseUrl?.trim() || null,
    authToken: authToken?.trim() || null,
  });
}

export async function clearTursoConfig(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("desktop_clear_turso_config");
}
