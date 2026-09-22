import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { isSameOriginMutation } from "@/lib/server/http/request-security";
import { savePersonnelPhoto } from "@/lib/services/personnel-photo";

export const runtime = "nodejs";

interface UploadPhotoBody {
  idUnik?: unknown;
  fotoBase64?: unknown;
  fotoMime?: unknown;
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
    await requireWebPermission(request, "employees.manage");

    const body = await readJsonBody<UploadPhotoBody>(request, 5_242_880);
    const idUnik = typeof body.idUnik === "string" ? body.idUnik.trim() : "";
    const fotoBase64 =
      typeof body.fotoBase64 === "string" ? body.fotoBase64.trim() : "";
    const fotoMime =
      typeof body.fotoMime === "string" ? body.fotoMime.trim() : "";

    if (!idUnik || !fotoBase64 || !fotoMime) {
      return noStoreJson(
        { sukses: false, pesan: "Data foto tidak lengkap." },
        400,
      );
    }

    const res = await savePersonnelPhoto(idUnik, fotoBase64, fotoMime);
    return noStoreJson({ sukses: true, id_unik: res.id_unik });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
