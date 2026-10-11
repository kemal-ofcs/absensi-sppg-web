"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import {
  type DatabaseProvider,
  normalizeProvider,
} from "@/lib/validations/database-endpoint";

export type { DatabaseProvider } from "@/lib/validations/database-endpoint";

export interface TursoConnectionStatus {
  connected: boolean;
  url: string;
  latency_ms?: number | null;
  error_message?: string | null;
}

/**
 * Pilihan provider yang menyertai setiap operasi konfigurasi database.
 *
 * Dikirim terpisah dari URL karena backend tidak boleh menebak provider dari
 * bentuk URL: satu salah ketik `http://` pada alamat Turso tidak boleh diam-diam
 * melonggarkan aturan transport.
 */
export interface DatabaseProviderChoice {
  provider?: DatabaseProvider;
  allowInsecureTransport?: boolean;
}

/** Konfigurasi database aktif, tanpa Auth Token. */
export interface DatabaseConfigView {
  configured: boolean;
  databaseUrl: string;
  provider: DatabaseProvider;
  providerLabel: string;
  allowInsecureTransport: boolean;
  /** Vault menyimpan Auth Token; nilainya sendiri tidak pernah keluar. */
  authTokenSaved: boolean;
}

const EMPTY_DATABASE_CONFIG: DatabaseConfigView = {
  configured: false,
  databaseUrl: "",
  provider: "turso",
  providerLabel: "Turso Cloud",
  allowInsecureTransport: false,
  authTokenSaved: false,
};

/**
 * Argumen provider untuk perintah Tauri.
 *
 * `undefined` sengaja dikirim sebagai `null` supaya backend membedakan "tidak
 * dikirim" (warisi pilihan tersimpan) dari "dipilih". Klien lama yang belum
 * mengirim field ini karenanya tidak menurunkan konfigurasi server sendiri
 * menjadi Turso.
 */
function providerArgs(choice: DatabaseProviderChoice) {
  return {
    provider: choice.provider ?? null,
    allowInsecureTransport: choice.allowInsecureTransport ?? null,
  };
}

export async function getTursoUrl(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invokeDesktop<string | null>("desktop_get_turso_url");
  } catch {
    return null;
  }
}

/**
 * Konfigurasi database aktif beserta provider-nya.
 *
 * `getTursoUrl` hanya mengembalikan URL, sehingga halaman Pengaturan tidak punya
 * cara mengetahui bahwa perangkat sedang memakai server LAN dan selalu
 * menampilkan ulang formulir dalam mode Turso.
 */
export async function getDatabaseConfig(): Promise<DatabaseConfigView> {
  if (!isDesktopRuntime()) return EMPTY_DATABASE_CONFIG;
  try {
    const raw = await invokeDesktop<DatabaseConfigView>(
      "desktop_get_database_config",
    );
    return { ...raw, provider: normalizeProvider(raw.provider) };
  } catch {
    return EMPTY_DATABASE_CONFIG;
  }
}

export async function saveTursoConfig(
  databaseUrl: string,
  authToken: string,
  choice: DatabaseProviderChoice = {},
): Promise<string> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Penyimpanan konfigurasi database hanya didukung pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<string>("desktop_save_turso_config", {
    databaseUrl,
    authToken,
    ...providerArgs(choice),
  });
}

export async function testTursoConnection(
  databaseUrl?: string,
  authToken?: string,
  choice: DatabaseProviderChoice = {},
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
    ...providerArgs(choice),
  });
}

export async function clearTursoConfig(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("desktop_clear_turso_config");
}
