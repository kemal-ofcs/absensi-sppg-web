import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { catatLaporanDispatcher } from "@/lib/services/driver";
import { laporanDraftSchema } from "@/lib/validations/driver";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: laporanDraftSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "trip.manage");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan perjalanan tidak valid." },
        400,
      );
    }
    // Membatalkan perjalanan yang berjalan memutus upah driver: izin sensitif.
    if (parsed.data.draft.jenis === "Dibatalkan") {
      await requireWebPermission(request, "trip.cancel");
    }
    return noStoreJson(
      await catatLaporanDispatcher(
        getServerDatabase(),
        actor.username,
        parsed.data.draft,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
