import { apiPost } from "@/lib/api/request";
import type {
  SyncAction,
  SyncResult,
  SyncStatusResult,
} from "@/lib/sync/types";

const syncHeaders = { "X-Hybrid-Starter-Sync": "1" };

async function runSync(action: SyncAction): Promise<SyncResult> {
  return apiPost<SyncResult>(
    `/api/sync/${action}`,
    {},
    { headers: syncHeaders },
  );
}

export function getSyncStatus() {
  return apiPost<SyncStatusResult>(
    "/api/sync/status",
    {},
    {
      headers: syncHeaders,
    },
  );
}

export function runFullSync() {
  return runSync("full");
}

export function runPushSync() {
  return runSync("push");
}

export function runPullSync() {
  return runSync("pull");
}
