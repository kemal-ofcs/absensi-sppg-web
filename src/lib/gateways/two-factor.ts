"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface TwoFactorStatus {
  enabled: boolean;
  confirmedAt: string;
  recoveryRemaining: number;
  requiredByRole: boolean;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function normalizeStatus(value: unknown): TwoFactorStatus {
  const status = record(value);
  return {
    enabled: status.enabled === true,
    confirmedAt: String(status.confirmedAt ?? status.confirmed_at ?? ""),
    recoveryRemaining: Number(
      status.recoveryRemaining ?? status.recovery_remaining ?? 0,
    ),
    requiredByRole:
      status.requiredByRole === true || status.required_by_role === true,
  };
}

/**
 * Verifikasi dua langkah berbasis TOTP.
 *
 * Semua langkah selain `adminDisableTwoFactor` bekerja pada akun pemanggil
 * sendiri; id operatornya diambil dari sesi di sisi server, tidak pernah
 * dikirim dari sini.
 */
export async function getTwoFactorStatus() {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_get_two_factor_status",
    );
    return normalizeStatus(payload.status ?? payload);
  }
  const response = await requestWebApi<{ status: TwoFactorStatus }>(
    "/api/auth/two-factor",
    "POST",
    { step: "status" },
  );
  return normalizeStatus(response.status);
}

/**
 * Terbitkan ulang kode pemulihan password untuk akun yang sedang login.
 *
 * Menerbitkan ulang MENGGANTI seluruh kode lama: daftar yang sebagiannya sudah
 * tercetak di kertas lama tidak boleh tetap berlaku bersamaan dengan yang baru.
 * Hasilnya hanya bisa dibaca sekali — database memegang hash-nya saja.
 */
export async function issueRecoveryCodes(): Promise<string[]> {
  const response = isDesktopRuntime()
    ? await invokeDesktop<{ codes?: unknown }>(
        "desktop_issue_recovery_codes",
        {},
      )
    : await requestWebApi<{ codes?: unknown }>("/api/auth/two-factor", "POST", {
        step: "recovery-codes",
      });
  return Array.isArray(response.codes)
    ? response.codes.map((code) => String(code))
    : [];
}

export async function beginTwoFactorSetup() {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_begin_two_factor_setup",
    );
    const setup = record(payload.setup ?? payload);
    return {
      secret: String(setup.secret ?? ""),
      otpauthUri: String(setup.otpauthUri ?? setup.otpauth_uri ?? ""),
    } satisfies TwoFactorSetup;
  }
  const response = await requestWebApi<{ setup: TwoFactorSetup }>(
    "/api/auth/two-factor",
    "POST",
    { step: "begin" },
  );
  return response.setup;
}

export async function confirmTwoFactorSetup(code: string) {
  if (isDesktopRuntime()) {
    const payload = await invokeDesktop<JsonRecord>(
      "desktop_confirm_two_factor_setup",
      { code },
    );
    const codes = payload.recoveryCodes ?? payload.recovery_codes;
    return {
      recoveryCodes: Array.isArray(codes) ? codes.map(String) : [],
    };
  }
  const response = await requestWebApi<{ recoveryCodes: string[] }>(
    "/api/auth/two-factor",
    "POST",
    { step: "confirm", code },
  );
  return { recoveryCodes: response.recoveryCodes ?? [] };
}

export async function disableTwoFactor(code: string) {
  if (isDesktopRuntime()) {
    await invokeDesktop<JsonRecord>("desktop_disable_two_factor", { code });
    return { sukses: true as const };
  }
  await requestWebApi<{ sukses: true }>("/api/auth/two-factor", "POST", {
    step: "disable",
    code,
  });
  return { sukses: true as const };
}

/** Untuk operator yang kehilangan ponselnya. Butuh izin `operators.manage`. */
export async function adminDisableTwoFactor(operatorId: number) {
  if (isDesktopRuntime()) {
    await invokeDesktop<JsonRecord>("desktop_admin_disable_two_factor", {
      operatorId,
    });
    return { sukses: true as const };
  }
  await requestWebApi<{ sukses: true }>("/api/auth/two-factor", "POST", {
    step: "admin-disable",
    operatorId,
  });
  return { sukses: true as const };
}
