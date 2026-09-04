import type { NextRequest } from "next/server";
import { CURRENT_SCHEMA_VERSION } from "@/lib/db-schema";
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
import {
  processOperationalSyncEvent,
  type SyncBatchRevisions,
} from "@/lib/server/operational/sync-push";
import { parseOperationalSyncBatch } from "@/lib/server/operational/sync-schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await withTransientDatabaseRetry(() =>
      requireWebPermission(request, "sync.view"),
    );
    const body = await readJsonBody<unknown>(request, 25_165_824);
    let batch: ReturnType<typeof parseOperationalSyncBatch>;
    try {
      batch = parseOperationalSyncBatch(body);
    } catch (error) {
      // Log detail event yang gagal agar mudah diagnosis di server
      if (body && typeof body === "object" && "events" in body) {
        const events = (body as Record<string, unknown>).events;
        if (Array.isArray(events)) {
          events.forEach((ev: unknown, idx: number) => {
            if (ev && typeof ev === "object") {
              const e = ev as Record<string, unknown>;
              console.error(
                `[SYNC] Event[${idx}] domain=${e.domain} op=${e.operation} key=${e.entityKey}`,
              );
            }
          });
        }
      }
      console.error("SYNC PUSH VALIDATION ERROR:", error);
      throw new ApiRequestError(
        `Batch sinkronisasi tidak valid: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    // Client dengan skema lebih tua tidak boleh menulis: kolom yang belum
    // dikenalnya tidak ikut payload dan akan terhapus saat baris ditulis ulang.
    // Sebaliknya client lebih baru dibiarkan lewat — itu jalur migrasi normal.
    if (
      batch.schemaVersion !== undefined &&
      batch.schemaVersion < CURRENT_SCHEMA_VERSION
    ) {
      throw new ApiRequestError(
        `Aplikasi perlu diperbarui. Server memakai skema versi ${CURRENT_SCHEMA_VERSION}, ` +
          `sedangkan aplikasi pengirim masih versi ${batch.schemaVersion}.`,
        409,
      );
    }

    const results = await withTransientDatabaseRetry(async () => {
      await ensureServerDatabaseInitialized();
      const eventResults = [];
      // Dibagi ke seluruh batch: event berikutnya untuk entitas yang sama harus
      // memakai revisi hasil event sebelumnya sebagai basis, bukan angka beku
      // dari waktu event dibuat di perangkat.
      const batchRevisions: SyncBatchRevisions = new Map();
      for (const event of batch.events) {
        eventResults.push(
          await processOperationalSyncEvent(
            getServerDatabase(),
            actor,
            event,
            batchRevisions,
          ),
        );
      }
      return eventResults;
    });
    return noStoreJson({ sukses: true, results });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
