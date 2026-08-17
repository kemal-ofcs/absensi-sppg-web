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
import {
  editAbsensiHarian,
  hapusAbsensiHarian,
  hapusLogScan,
} from "@/lib/services/history-mutation";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "history.edit");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const idSesi = typeof body.id_sesi === "string" ? body.id_sesi.trim() : "";

    if (!idSesi) {
      throw new ApiRequestError("ID Sesi absensi wajib diisi.", 400);
    }

    const patch = {
      jam_masuk:
        typeof body.jam_masuk === "string" ? body.jam_masuk.trim() : undefined,
      jam_pulang:
        typeof body.jam_pulang === "string"
          ? body.jam_pulang.trim()
          : undefined,
      status_kehadiran:
        typeof body.status_kehadiran === "string"
          ? body.status_kehadiran.trim()
          : undefined,
      status_absen:
        typeof body.status_absen === "string"
          ? body.status_absen.trim()
          : undefined,
      keterangan:
        typeof body.keterangan === "string"
          ? body.keterangan.trim()
          : undefined,
    };

    await ensureServerDatabaseInitialized();
    const result = await editAbsensiHarian(idSesi, patch, actor.kode_operator);
    if (!result.sukses) throw new ApiRequestError(result.pesan, 400);

    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "attendance",
      entityKey: idSesi,
      operation: "update",
      payload: { id_sesi: idSesi, ...patch },
      actorOperatorId: actor.id,
    });

    return noStoreJson({ ...result, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "history.delete");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const idLog = body.id_log !== undefined ? Number(body.id_log) : undefined;
    const idSesi =
      typeof body.id_sesi === "string" ? body.id_sesi.trim() : undefined;

    if (!idLog && !idSesi) {
      throw new ApiRequestError(
        "ID Log atau ID Sesi wajib ditentukan untuk penghapusan.",
        400,
      );
    }

    await ensureServerDatabaseInitialized();

    if (idLog) {
      const result = await hapusLogScan(idLog, actor.kode_operator);
      if (!result.sukses) throw new ApiRequestError(result.pesan, 400);

      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "log-scan",
        entityKey: String(idLog),
        operation: "delete",
        payload: { id_log: idLog },
        actorOperatorId: actor.id,
      });

      return noStoreJson({ ...result, revision });
    }

    if (idSesi) {
      const result = await hapusAbsensiHarian(idSesi, actor.kode_operator);
      if (!result.sukses) throw new ApiRequestError(result.pesan, 400);

      const revision = await recordOperationalChange(getServerDatabase(), {
        domain: "attendance",
        entityKey: idSesi,
        operation: "delete",
        payload: { id_sesi: idSesi },
        actorOperatorId: actor.id,
      });

      return noStoreJson({ ...result, revision });
    }

    throw new ApiRequestError("Permintaan tidak valid.", 400);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
