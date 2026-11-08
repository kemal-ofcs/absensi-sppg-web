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
import { findTelegramGroups } from "@/lib/services/telegram";

export const runtime = "nodejs";

const bodySchema = z.object({ botToken: z.string().max(100) }).strict();

/** Cermin `desktop_find_telegram_groups`. Hanya Superadmin. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", true);
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan cari grup tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await findTelegramGroups(getServerDatabase(), parsed.data.botToken),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
