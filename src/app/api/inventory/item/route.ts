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
import { saveItem } from "@/lib/services/inventory";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: z.unknown() }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "inventory.manage");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan inventaris tidak valid." },
        400,
      );
    }
    return noStoreJson(await saveItem(getServerDatabase(), parsed.data.draft));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
