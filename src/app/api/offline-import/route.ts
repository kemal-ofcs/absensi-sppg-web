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
  type OfflineImportRow,
  prosesImportOffline,
} from "@/lib/services/offline-import";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "corrections.manage");
    const body = await readJsonBody<{ rows?: unknown }>(request, 512 * 1024);
    if (
      !Array.isArray(body.rows) ||
      body.rows.length === 0 ||
      body.rows.length > 500
    ) {
      throw new ApiRequestError("Import harus berisi 1 sampai 500 baris.", 400);
    }
    const rows = body.rows.map((value) => {
      const row = (value ?? {}) as Record<string, unknown>;
      const field = (key: string) =>
        typeof row[key] === "string" ? row[key].trim() : undefined;
      return {
        tanggal: field("tanggal") ?? "",
        id_unik: field("id_unik") ?? "",
        nama: field("nama"),
        divisi: field("divisi"),
        jam_masuk: field("jam_masuk"),
        jam_pulang: field("jam_pulang"),
        status_kehadiran: field("status_kehadiran"),
        status_absen: field("status_absen"),
        keterangan: field("keterangan"),
      } satisfies OfflineImportRow;
    });
    await ensureServerDatabaseInitialized();
    const result = await prosesImportOffline(rows, actor.kode_operator);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "offline-import",
      entityKey: `batch:${Date.now()}`,
      operation: "batch",
      payload: { berhasil: result.berhasil, gagal: result.gagal },
      actorOperatorId: actor.id,
    });
    return noStoreJson({ ...result, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
