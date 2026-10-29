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
import { catatBayarCicilan } from "@/lib/services/cicilan";
import { bayarDraftSchema } from "@/lib/validations/cicilan";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: bayarDraftSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "accounting.manage");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan cicilan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await catatBayarCicilan(
        getServerDatabase(),
        actor.username,
        parsed.data.draft,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
