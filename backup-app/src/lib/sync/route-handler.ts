import type { NextRequest } from "next/server";
import { apiError, apiOk } from "@/lib/api/response";
import { authorizeSyncRequest } from "@/lib/sync/security";
import {
  getServerSyncStatus,
  runServerSync,
  SyncEngineError,
} from "@/lib/sync/server-engine";
import type { SyncAction, SyncResult } from "@/lib/sync/types";

export async function handleSyncAction(
  request: NextRequest,
  action: SyncAction,
) {
  const access = await authorizeSyncRequest(request);
  if (access instanceof Response) return access;

  if (access.runtime === "web") {
    return apiOk<SyncResult>({
      status: "success",
      message: "Web runtime sudah memakai Turso sebagai source of truth.",
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      failed: 0,
      tables: [],
    });
  }

  try {
    return apiOk(await runServerSync(action));
  } catch (error) {
    console.error(`[SYNC_ROUTE:${action}]`, error);
    if (error instanceof SyncEngineError) {
      const status =
        error.code === "SYNC_ALREADY_RUNNING"
          ? 409
          : error.code === "SYNC_PARTIAL_FAILURE" ||
              error.code === "SYNC_PULL_ROW_FAILED"
            ? 422
            : 503;
      return apiError(error.message, status, error.code);
    }
    return apiError(
      "Sinkronisasi gagal. Detail tersimpan di log desktop.",
      500,
      "SYNC_FAILED",
    );
  }
}

export async function handleSyncStatus(request: NextRequest) {
  const access = await authorizeSyncRequest(request);
  if (access instanceof Response) return access;

  try {
    return apiOk(await getServerSyncStatus());
  } catch (error) {
    console.error("[SYNC_STATUS_ROUTE]", error);
    return apiError(
      "Status sinkronisasi tidak dapat dibaca.",
      500,
      "SYNC_STATUS_FAILED",
    );
  }
}
