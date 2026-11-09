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
import { batalBayarUpah } from "@/lib/services/driver";
import { batalBayarDraftSchema } from "@/lib/validations/driver";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: batalBayarDraftSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "trip.pay");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pembatalan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await batalBayarUpah(
        getServerDatabase(),
        actor.username,
        parsed.data.draft,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
