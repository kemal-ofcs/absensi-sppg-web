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
  type IdCardUpdateInput,
  updateStatusIdCard,
} from "@/lib/services/idcard";

export const runtime = "nodejs";
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "employees.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const status = body.idcard_status as IdCardUpdateInput["idcard_status"];
    const draft: IdCardUpdateInput = {
      id_unik: typeof body.id_unik === "string" ? body.id_unik.trim() : "",
      idcard_status: status,
      idcard_pdf_url:
        typeof body.idcard_pdf_url === "string"
          ? body.idcard_pdf_url
          : undefined,
      link_qr_png:
        typeof body.link_qr_png === "string" ? body.link_qr_png : undefined,
      idcard_catatan:
        typeof body.idcard_catatan === "string"
          ? body.idcard_catatan
          : undefined,
    };
    if (!draft.id_unik || !["Belum", "Berhasil", "Gagal"].includes(status))
      throw new ApiRequestError("Status ID Card tidak valid.", 400);
    await ensureServerDatabaseInitialized();
    const result = await updateStatusIdCard(draft);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "id-card",
      entityKey: draft.id_unik,
      operation: "update",
      payload: draft,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ ...result, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
