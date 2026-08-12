"use client";

import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface SyncStatus {
  clientId: string;
  pending: number;
  synced: number;
  failed: number;
  conflict: number;
  lastRevision: number;
  lastSyncAt: number | null;
  tableCounts: {
    employees: number;
    idCards: number;
    shifts: number;
    settings: number;
    backups: number;
    corrections: number;
    imports: number;
    attendance: number;
    scanLogs: number;
  };
}

export interface SyncConflict {
  eventId: string;
  domain: string;
  entityKey: string;
  reason: string;
  createdAt: number;
}

export function isDesktopSyncAvailable() {
  return isDesktopRuntime();
}

export async function getSyncStatus() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_get_sync_status");
}

export async function syncNow() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_sync_now");
}

export async function getSyncConflicts() {
  if (!isDesktopRuntime()) return [];
  return invokeDesktop<SyncConflict[]>("desktop_get_sync_conflicts");
}

export async function retryFailedSync(eventId?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<SyncStatus>("desktop_retry_failed_sync", { eventId });
}
