"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { DashboardMetrics, RekapBulananItem } from "@/lib/services/report";

export type { DashboardMetrics, RekapBulananItem } from "@/lib/services/report";

async function query<T>(kind: string, filter: Record<string, unknown> = {}) {
  if (isDesktopRuntime())
    return invokeDesktop<T>("desktop_get_dashboard_data", { kind, filter });
  const result = await requestWebApi<{ data: T }>(
    "/api/dashboard/query",
    "POST",
    { kind, ...filter },
  );
  return result.data;
}

export const getDashboardMetrics = () => query<DashboardMetrics>("metrics");
export const getRekapHarian = (
  filter: { tanggal?: string; divisi?: string } = {},
) => query<Record<string, unknown>[]>("daily", filter);
export const getRiwayatScan = (
  filter: {
    tanggal?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
) => query<Record<string, unknown>[]>("scan-history", filter);
export const getRekapBulanan = (
  filter: { bulan?: string; tahun?: number; divisi?: string } = {},
) => query<RekapBulananItem[]>("monthly", filter);
export const getTopKaryawanTerajin = (limit = 5) =>
  query<Record<string, unknown>[]>("top", { limit });

export function jalankanAuditKualitasAbsensi() {
  if (isDesktopRuntime()) {
    throw new Error("Generate Alfa wajib dijalankan saat online melalui Web.");
  }
  return requestWebApi("/api/attendance-audit", "POST");
}
