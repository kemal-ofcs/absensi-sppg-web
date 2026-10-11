import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarImport } from "@/lib/services/offline-import";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "corrections.view");
    const body = await readJsonBody<{
      tanggal?: string;
      id_karyawan?: string;
      search?: string;
    }>(request);
    await ensureServerDatabaseInitialized();
    const imports = await getDaftarImport({
      tanggal:
        typeof body.tanggal === "string" ? body.tanggal.trim() : undefined,
      id_karyawan:
        typeof body.id_karyawan === "string"
          ? body.id_karyawan.trim()
          : undefined,
      search: typeof body.search === "string" ? body.search.trim() : undefined,
    });
    return noStoreJson({ imports });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
