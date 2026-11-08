import type { NextRequest } from "next/server";
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
import { sendTelegramTest, telegramTestSchema } from "@/lib/services/telegram";

export const runtime = "nodejs";

/** Cermin `desktop_send_telegram_test`. Hanya Superadmin. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", true);
    await ensureServerDatabaseInitialized();
    const parsed = telegramTestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pesan uji tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await sendTelegramTest(getServerDatabase(), parsed.data),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
