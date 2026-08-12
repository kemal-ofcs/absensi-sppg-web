import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarBackup } from "@/lib/services/backup";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "backups.view");
    const body = await readJsonBody<Record<string, unknown>>(request);
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      sukses: true,
      backups: await getDaftarBackup({
        tanggal: typeof body.tanggal === "string" ? body.tanggal : undefined,
        status_tugas:
          typeof body.status_tugas === "string" ? body.status_tugas : undefined,
      }),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
