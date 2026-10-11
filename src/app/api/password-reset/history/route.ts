import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  deletePasswordResetHistory,
  purgePasswordResetHistory,
} from "@/lib/server/auth/password-reset-audit";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

interface HistoryDeleteBody {
  requestId?: unknown;
  /** Bila diisi, hapus massal riwayat selesai yang lebih tua dari N hari. */
  olderThanDays?: unknown;
}

/**
 * Penghapusan riwayat reset password.
 *
 * Izin `password_reset.delete` masuk daftar mutasi sensitif: menghapus baris
 * ini menghilangkan satu-satunya jejak siapa yang pernah mengajukan pemulihan
 * beserta foto wajahnya.
 */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "password_reset.delete");
    const body = await readJsonBody<HistoryDeleteBody>(request);
    const database = getServerDatabase();

    if (body.olderThanDays !== undefined) {
      const result = await purgePasswordResetHistory(
        database,
        Number(body.olderThanDays),
      );
      return noStoreJson({ sukses: true, ...result });
    }

    const result = await deletePasswordResetHistory(
      database,
      typeof body.requestId === "string" ? body.requestId : "",
    );
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
