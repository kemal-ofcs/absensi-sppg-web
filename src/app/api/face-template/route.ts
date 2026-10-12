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
import {
  deleteFaceTemplate,
  listFaceTemplates,
  saveFaceTemplate,
} from "@/lib/server/operational/face-template";
import {
  FACE_TEMPLATE_SOURCES,
  type FaceTemplateSource,
} from "@/lib/validations/face-match";

export const runtime = "nodejs";

/**
 * Pendaftaran wajah untuk verifikasi 1:1 saat scan.
 *
 * `POST` membaca daftar (static export melarang `GET`), `PUT` menyimpan, dan
 * `DELETE` menghapus. Mengelolanya menuntut `face_template.manage`, izin
 * sensitif: wajah yang salah di nama seseorang meloloskan kartu pinjaman.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "face_template.view");
    return noStoreJson({
      sukses: true,
      entries: await listFaceTemplates(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface SaveBody {
  idUnik?: unknown;
  model?: unknown;
  vektor?: unknown;
  jumlahSampel?: unknown;
  sumber?: unknown;
}

const SAVE_KEYS = new Set([
  "idUnik",
  "model",
  "vektor",
  "jumlahSampel",
  "sumber",
]);

export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "face_template.manage");
    const body = await readJsonBody<SaveBody>(request);
    // Sama ketatnya dengan `deny_unknown_fields` di Rust.
    if (Object.keys(body).some((key) => !SAVE_KEYS.has(key))) {
      throw new ApiRequestError("Data wajah tidak valid.", 400);
    }
    const sumber = (FACE_TEMPLATE_SOURCES as readonly unknown[]).includes(
      body.sumber,
    )
      ? (body.sumber as FaceTemplateSource)
      : null;
    if (
      typeof body.idUnik !== "string" ||
      typeof body.model !== "string" ||
      typeof body.vektor !== "string" ||
      typeof body.jumlahSampel !== "number" ||
      !sumber
    ) {
      throw new ApiRequestError("Data wajah tidak valid.", 400);
    }
    return noStoreJson(
      await saveFaceTemplate(
        getServerDatabase(),
        {
          idUnik: body.idUnik,
          model: body.model,
          vektor: body.vektor,
          jumlahSampel: body.jumlahSampel,
          sumber,
        },
        actor.username,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "face_template.manage");
    const body = await readJsonBody<{ idUnik?: unknown }>(request);
    if (typeof body.idUnik !== "string") {
      throw new ApiRequestError("Karyawan wajib dipilih.", 400);
    }
    return noStoreJson(
      await deleteFaceTemplate(getServerDatabase(), body.idUnik),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
