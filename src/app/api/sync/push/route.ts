import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { withTransientDatabaseRetry } from "@/lib/server/database-retry";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { processOperationalSyncEvent } from "@/lib/server/operational/sync-push";
import { parseOperationalSyncBatch } from "@/lib/server/operational/sync-schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await withTransientDatabaseRetry(() =>
      requireWebPermission(request, "sync.view"),
    );
    const body = await readJsonBody<unknown>(request, 262_144);
    let batch: ReturnType<typeof parseOperationalSyncBatch>;
    try {
      batch = parseOperationalSyncBatch(body);
    } catch (error) {
      console.error("SYNC PUSH VALIDATION ERROR:", error);
      throw new ApiRequestError(
        `Batch sinkronisasi tidak valid: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    const results = await withTransientDatabaseRetry(async () => {
      await ensureServerDatabaseInitialized();
      const eventResults = [];
      for (const event of batch.events) {
        eventResults.push(
          await processOperationalSyncEvent(getServerDatabase(), actor, event),
        );
      }
      return eventResults;
    });
    return noStoreJson({ sukses: true, results });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
