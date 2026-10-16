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
import { tambahHariLiburMassal } from "@/lib/services/holiday";
import { validateLiburMassal } from "@/lib/validations/hari-kerja";

export const runtime = "nodejs";

/** Rentang tanggal. Cermin `desktop_create_holidays_bulk`. */
export async function POST(request: NextRequest) {
  try {
    const actor = await requireWebPermission(request, "holidays.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<Record<string, unknown>>(request);
    if (Object.keys(body).some((kunci) => kunci !== "entries")) {
      throw new ApiRequestError("Permintaan tidak valid.", 400);
    }
    const hasil = validateLiburMassal(body.entries);
    if (!hasil.ok) throw new ApiRequestError(hasil.error, 400);

    const tersimpan = await tambahHariLiburMassal(hasil.value);
    // Satu jejak per simpan massal, pola yang sama dengan tambah satu libur.
    await recordOperationalChange(getServerDatabase(), {
      domain: "holiday",
      operation: "create",
      entityKey: `massal:${hasil.value[0]?.tanggal ?? ""}`,
      payload: { entries: hasil.value, dilewati: tersimpan.dilewati },
      actorOperatorId: actor.id,
    });
    return noStoreJson(tersimpan, 201);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
