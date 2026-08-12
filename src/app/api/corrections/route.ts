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
  type KoreksiInput,
  prosesKoreksiAdmin,
} from "@/lib/services/correction";

export const runtime = "nodejs";

const CORRECTION_TYPES = new Set<KoreksiInput["jenis_koreksi"]>([
  "Sakit",
  "Izin",
  "Dispen",
  "Alfa",
  "Lupa Absen Masuk",
  "Lupa Absen Pulang",
  "Kendala Sistem - Jam Masuk",
  "Kendala Sistem - Jam Pulang",
  "Terlambat",
]);

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "corrections.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const jenis = body.jenis_koreksi as KoreksiInput["jenis_koreksi"];
    const draft: KoreksiInput = {
      tanggal: typeof body.tanggal === "string" ? body.tanggal.trim() : "",
      id_karyawan:
        typeof body.id_karyawan === "string" ? body.id_karyawan.trim() : "",
      jenis_koreksi: jenis,
      jam_koreksi:
        typeof body.jam_koreksi === "string"
          ? body.jam_koreksi.trim()
          : undefined,
      keterangan_admin:
        typeof body.keterangan_admin === "string"
          ? body.keterangan_admin.trim()
          : undefined,
      kode_operator: actor.kode_operator,
    };
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(draft.tanggal) ||
      !draft.id_karyawan ||
      !CORRECTION_TYPES.has(jenis)
    ) {
      throw new ApiRequestError("Data Koreksi Admin tidak valid.", 400);
    }
    await ensureServerDatabaseInitialized();
    const result = await prosesKoreksiAdmin(draft);
    if (!result.sukses) throw new ApiRequestError(result.pesan, 409);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "correction",
      entityKey: result.id_referensi ?? `${draft.tanggal}:${draft.id_karyawan}`,
      operation: "create",
      payload: draft,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ ...result, revision }, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
