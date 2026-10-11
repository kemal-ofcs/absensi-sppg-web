import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarKoreksi } from "@/lib/services/correction";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "corrections.view");
    const body = await readJsonBody<Record<string, unknown>>(request);
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      sukses: true,
      corrections: await getDaftarKoreksi({
        tanggal: typeof body.tanggal === "string" ? body.tanggal : undefined,
        id_karyawan:
          typeof body.id_karyawan === "string" ? body.id_karyawan : undefined,
      }),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
