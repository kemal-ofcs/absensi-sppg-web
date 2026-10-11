import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { isSameOriginMutation } from "@/lib/server/http/request-security";
import { getPersonnelPhoto } from "@/lib/services/personnel-photo";

export const runtime = "nodejs";

interface QueryPhotoBody {
  idUnik?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginMutation(request)) {
      return noStoreJson(
        { sukses: false, pesan: "Origin tidak diizinkan." },
        403,
      );
    }
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "employees.view");

    const body = await readJsonBody<QueryPhotoBody>(request);
    const idUnik = typeof body.idUnik === "string" ? body.idUnik.trim() : "";

    if (!idUnik) {
      return noStoreJson(
        { sukses: false, pesan: "ID personil wajib diisi." },
        400,
      );
    }

    const photo = await getPersonnelPhoto(idUnik);
    return noStoreJson({ sukses: true, photo });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
