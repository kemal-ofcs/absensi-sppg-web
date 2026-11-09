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
import { simpanLokasi } from "@/lib/services/driver";
import { lokasiDraftSchema } from "@/lib/validations/driver";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: lokasiDraftSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "fleet.manage");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan perjalanan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await simpanLokasi(getServerDatabase(), parsed.data.draft),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
