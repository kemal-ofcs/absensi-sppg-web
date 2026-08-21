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
