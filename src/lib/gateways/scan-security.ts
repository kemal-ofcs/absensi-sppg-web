"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import {
  FACE_THRESHOLD_DEFAULT,
  normalizeFaceMode,
  normalizeFaceThreshold,
} from "@/lib/validations/face-match";
import type {
  ScanSecurityDraft,
  ScanSecuritySettings,
} from "@/lib/validations/scan-security";

export type { ScanSecuritySettings } from "@/lib/validations/scan-security";

function normalize(value: unknown): ScanSecuritySettings {
  const record = (value ?? {}) as Record<string, unknown>;
  const list = (input: unknown) =>
    Array.isArray(input)
      ? input.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  return {
    photoEnabled: record.photoEnabled === true,
    ipRestrictionEnabled: record.ipRestrictionEnabled === true,
    photoRequiredForMe: record.photoRequiredForMe === true,
    ipRestrictionRequiredForMe: record.ipRestrictionRequiredForMe === true,
    faceVerifyEnabled: record.faceVerifyEnabled === true,
    faceMode: normalizeFaceMode(record.faceMode) ?? "pantau",
    faceThreshold:
      normalizeFaceThreshold(record.faceThreshold) ?? FACE_THRESHOLD_DEFAULT,
    faceRequiredForMe: record.faceRequiredForMe === true,
    entries: list(record.entries),
    deviceAddresses: list(record.deviceAddresses),
    canManage: record.canManage === true,
  };
}

/**
 * Pengaturan keamanan absensi: sakelar induk fitur + daftar IP.
 *
 * Membacanya hanya butuh sesi yang sah — halaman scanner memakainya untuk tahu
 * apakah harus menahan scan demi foto. Daftar alamat IP hanya ikut untuk
 * Superadmin; operator biasa menerima daftar kosong.
 */
export async function getScanSecurity(): Promise<ScanSecuritySettings> {
  if (isDesktopRuntime()) {
    return normalize(await invokeDesktop("desktop_get_scan_security"));
  }
  const response = await requestWebApi<{ data: ScanSecuritySettings }>(
    "/api/settings/scan-security",
    "POST",
    {},
  );
  return normalize(response.data);
}

export async function saveScanSecurity(
  input: ScanSecurityDraft,
): Promise<ScanSecuritySettings> {
  const payload = {
    photoEnabled: input.photoEnabled,
    ipRestrictionEnabled: input.ipRestrictionEnabled,
    entries: [...input.entries],
    faceVerifyEnabled: input.faceVerifyEnabled,
    faceMode: input.faceMode,
    faceThreshold: input.faceThreshold,
  };
  if (isDesktopRuntime()) {
    return normalize(
      await invokeDesktop("desktop_update_scan_security", { payload }),
    );
  }
  const response = await requestWebApi<{ data: ScanSecuritySettings }>(
    "/api/settings/scan-security",
    "PUT",
    payload,
  );
  return normalize(response.data);
}
