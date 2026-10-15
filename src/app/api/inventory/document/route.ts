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
import { documentInventaris } from "@/lib/services/inventory";

export const runtime = "nodejs";

const bodySchema = z.object({ idMutasi: z.string().min(1).max(160) }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "inventory.view");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan inventaris tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await documentInventaris(getServerDatabase(), parsed.data.idMutasi),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
