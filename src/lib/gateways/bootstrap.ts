"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export type BootstrapStatus = {
  configured: boolean;
  required: boolean;
  serverOrigin: string;
};

export type BootstrapDraft = {
  kodeOperator: string;
  namaOperator: string;
  username: string;
  password: string;
  databaseUrl?: string;
  authToken?: string;
};

export async function getBootstrapStatus(): Promise<BootstrapStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<BootstrapStatus>("desktop_get_bootstrap_status");
}

export async function bootstrapSuperadmin(
  draft: BootstrapDraft,
): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("Bootstrap hanya tersedia pada aplikasi desktop/mobile.");
  }
  await invokeDesktop<void>("desktop_bootstrap_superadmin", {
    draft: {
      kode_operator: draft.kodeOperator,
      nama_operator: draft.namaOperator,
      username: draft.username,
      password: draft.password,
    },
    databaseUrl: draft.databaseUrl?.trim() || null,
    authToken: draft.authToken?.trim() || null,
  });
}

export type DatabaseCheckResult = {
  reachable: boolean;
  serverOrigin: string;
  latencyMs: number | null;
  emptyDatabase: boolean;
  schemaReady: boolean;
  missingTables: string[];
  tableCount: number;
  bootstrapClaimed: boolean;
  superadminExists: boolean;
  superadminCount: number;
  superadminUsername: string | null;
  operatorCount: number;
  karyawanCount: number;
  attendanceCount: number;
  companyName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type DatabaseCredentials = {
  databaseUrl?: string;
  authToken?: string;
};

/**
 * Pemeriksaan read-only database cloud sebelum Superadmin dibuat.
 * Tidak menulis apa pun sehingga salah input URL tidak mencemari database lain.
 */
export async function checkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Pemeriksaan database hanya tersedia pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>(
    "desktop_check_bootstrap_database",
    {
      databaseUrl: credentials.databaseUrl?.trim() || null,
      authToken: credentials.authToken?.trim() || null,
    },
  );
}

/** Memakai database yang sudah punya Superadmin aktif tanpa membuat akun baru. */
export async function linkBootstrapDatabase(
  credentials: DatabaseCredentials = {},
): Promise<DatabaseCheckResult> {
  if (!isDesktopRuntime()) {
    throw new Error(
      "Konfigurasi database hanya tersedia pada aplikasi desktop/mobile.",
    );
  }
  return invokeDesktop<DatabaseCheckResult>("desktop_link_bootstrap_database", {
    databaseUrl: credentials.databaseUrl?.trim() || null,
    authToken: credentials.authToken?.trim() || null,
  });
}
