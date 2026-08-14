export type SyncAction = "push" | "pull" | "full";

export type SyncStatus = "idle" | "syncing" | "success" | "error";

export interface SyncResult {
  status: SyncStatus;
  message: string;
  runId?: string;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  failed: number;
  tables: SyncTableRunSummary[];
}

export interface SyncTableRunSummary {
  table: string;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  failed: number;
}

export interface SyncTableQueueSummary {
  table: string;
  pending: number;
  failed: number;
}

export interface SyncRunSummary {
  id: string;
  action: SyncAction;
  status: "running" | "success" | "error";
  uploaded: number;
  downloaded: number;
  conflicts: number;
  failed: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface SyncStatusResult {
  available: boolean;
  configured: boolean;
  message: string;
  pending: number;
  failed: number;
  tables: SyncTableQueueSummary[];
  lastRun: SyncRunSummary | null;
}
