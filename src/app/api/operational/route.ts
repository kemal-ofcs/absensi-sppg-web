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
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import { hapusKoreksiAdmin } from "@/lib/services/correction";
import { hapusImportOffline } from "@/lib/services/history-mutation";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "operational.delete");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const idReferensi =
      typeof body.id_referensi === "string"
        ? body.id_referensi.trim()
        : undefined;
    const eventKey =
      typeof body.event_key === "string" ? body.event_key.trim() : undefined;

    if (!idReferensi && !eventKey) {
      throw new ApiRequestError(
        "ID Referensi Koreksi atau Event Key Import wajib ditentukan.",
        400,
      );
    }

    await ensureServerDatabaseInitialized();

    if (idReferensi) {
      const result = await hapusKoreksiAdmin(idReferensi, actor.kode_operator);
      if (!result.sukses) throw new ApiRequestError(result.pesan, 400);

      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "correction",
        entityKey: idReferensi,
        operation: "delete",
        payload: { id_referensi: idReferensi },
        actorOperatorId: actor.id,
      });

      return noStoreJson({ ...result, revision });
    }

    if (eventKey) {
      const result = await hapusImportOffline(eventKey, actor.kode_operator);
      if (!result.sukses) throw new ApiRequestError(result.pesan, 400);

      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "offline-import",
        entityKey: eventKey,
        operation: "delete",
        payload: { event_key: eventKey },
        actorOperatorId: actor.id,
      });

      return noStoreJson({ ...result, revision });
    }

    throw new ApiRequestError("Permintaan tidak valid.", 400);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
