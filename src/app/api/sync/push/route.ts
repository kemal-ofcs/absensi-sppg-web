import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
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
    const actor = await requireWebPermission(request, "sync.view");
    const body = await readJsonBody<unknown>(request, 262_144);
    let batch: ReturnType<typeof parseOperationalSyncBatch>;
    try {
      batch = parseOperationalSyncBatch(body);
    } catch {
      throw new ApiRequestError("Batch sinkronisasi tidak valid.", 400);
    }
    await ensureServerDatabaseInitialized();
    const results = [];
    for (const event of batch.events) {
      results.push(
        await processOperationalSyncEvent(getServerDatabase(), actor, event),
      );
    }
    return noStoreJson({ sukses: true, results });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
