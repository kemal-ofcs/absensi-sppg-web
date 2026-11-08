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
import {
  saveTelegramConfig,
  telegramDraftSchema,
} from "@/lib/services/telegram";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: telegramDraftSchema }).strict();

/** Cermin `desktop_save_telegram_config`. Token bot rahasia: hanya Superadmin. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", true);
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Konfigurasi Telegram tidak valid." },
        400,
      );
    }
    return noStoreJson({
      config: await saveTelegramConfig(getServerDatabase(), parsed.data.draft),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
