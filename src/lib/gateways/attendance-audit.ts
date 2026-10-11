"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { HasilAuditAbsensi } from "@/lib/services/attendance-audit";

export type {
  BarisLogAudit,
  HasilAuditAbsensi,
  KeparahanTemuan,
  RingkasanAuditAbsensi,
  TemuanAudit,
} from "@/lib/services/attendance-audit";

/**
 * Ambil ringkasan kualitas absensi satu tanggal kerja.
 *
 * Desktop dan Mobile mendaftarkan `desktop_get_attendance_audit`, jadi gateway
 * ini tidak perlu bercabang `isMobileRuntime()`.
 */
export async function getAuditKualitasAbsensi(
  tanggal?: string,
): Promise<HasilAuditAbsensi> {
  if (isDesktopRuntime()) {
    return invokeDesktop<HasilAuditAbsensi>("desktop_get_attendance_audit", {
      tanggal,
    });
  }
  const response = await requestWebApi<{ audit: HasilAuditAbsensi }>(
    "/api/attendance-audit/query",
    "POST",
    { tanggal },
  );
  return response.audit;
}
