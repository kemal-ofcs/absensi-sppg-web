"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { LicenseKind, LicenseStatus } from "@/lib/license/types";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Lisensi offline Ed25519. Desktop dan Mobile selalu menegakkannya
 * (`license.rs`). Web hanya menegakkannya pada build self-hosted
 * (`server/license.ts`); pada deployment milik pemilik aplikasi server
 * menjawab `null`, dan seluruh UI lisensi tidak pernah tampil.
 *
 * Bentuk datanya ada di `lib/license/types.ts`.
 */
export type {
  LicenseKind,
  LicensePayload,
  LicenseReadOnlyReason,
  LicenseState,
  LicenseStatus,
} from "@/lib/license/types";

/** Penerbit lisensi, disebut di layar aktivasi. Padanan `LICENSE_ISSUER` di `license.rs`. */
export const LICENSE_ISSUER = "Kemal Office Studio";

export const LICENSE_KIND_LABEL: Record<LicenseKind, string> = {
  beli_putus: "Beli putus",
  sewa: "Sewa",
};

/** Status yang tidak mengizinkan login sama sekali. */
export function isLicenseBlocking(status: LicenseStatus | null): boolean {
  return (
    status !== null && status.state !== "active" && status.state !== "read_only"
  );
}

/**
 * Kata untuk benda yang diikat lisensi di build ini. Di Web yang diikat adalah
 * server (lewat kode instance database), bukan perangkat yang sedang dipakai.
 */
export function licenseTargetNoun(): "perangkat" | "server" {
  return isDesktopRuntime() ? "perangkat" : "server";
}

export async function getLicenseStatus(): Promise<LicenseStatus | null> {
  if (!isDesktopRuntime()) {
    const response = await requestWebApi<{ status: LicenseStatus | null }>(
      "/api/license/status",
      "POST",
    );
    return response.status;
  }
  return invokeDesktop<LicenseStatus>("desktop_get_license_status");
}

/**
 * Pasang lisensi dari teks `LIS1.…`. Tanpa sesi hanya bila lisensi saat ini
 * tidak aktif penuh; mengganti lisensi yang masih aktif menuntut Superadmin.
 */
export async function installLicense(license: string): Promise<LicenseStatus> {
  if (!isDesktopRuntime()) {
    const response = await requestWebApi<{ status: LicenseStatus }>(
      "/api/license/install",
      "POST",
      { license: license.trim() },
    );
    return response.status;
  }
  return invokeDesktop<LicenseStatus>("desktop_install_license", {
    license: license.trim(),
  });
}
