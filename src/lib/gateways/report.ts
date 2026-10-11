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
  filter: {
    tanggal?: string;
    tanggal_mulai?: string;
    tanggal_selesai?: string;
    divisi?: string;
  } = {},
) => query<Record<string, unknown>[]>("daily", filter);
export const getRiwayatScan = (
  filter: {
    tanggal?: string;
    tanggal_mulai?: string;
    tanggal_selesai?: string;
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

export async function jalankanAuditKualitasAbsensi() {
  if (isDesktopRuntime()) {
    const res = await invokeDesktop<{
      sukses: boolean;
      pesan: string;
      ringkasan?: Record<string, unknown>;
    }>("desktop_trigger_generate_alfa");
    kickSync();
    return res;
  }
  return requestWebApi("/api/attendance-audit", "POST");
}

function kickSync() {
  void invokeDesktop("desktop_sync_now").catch(() => undefined);
}

export async function editAbsensiHarian(
  idSesi: string,
  patch: {
    jam_masuk?: string;
    jam_pulang?: string;
    status_kehadiran?: string;
    status_absen?: string;
    keterangan?: string;
  },
) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan: string }>(
      "desktop_update_attendance",
      { idSesi, patch },
    );
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string }>(
    "/api/history",
    "PATCH",
    { id_sesi: idSesi, ...patch },
  );
}

export async function hapusAbsensiHarian(idSesi: string) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan: string }>(
      "desktop_delete_attendance",
      { idSesi },
    );
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string }>(
    "/api/history",
    "DELETE",
    { id_sesi: idSesi },
  );
}

export async function hapusLogScan(idLog: number | string) {
  if (isDesktopRuntime()) {
    const result = await invokeDesktop<{ sukses: boolean; pesan: string }>(
      "desktop_delete_log_scan",
      { idLog: Number(idLog) },
    );
    if (result.sukses) kickSync();
    return result;
  }
  return requestWebApi<{ sukses: boolean; pesan: string }>(
    "/api/history",
    "DELETE",
    { id_log: Number(idLog) },
  );
}
