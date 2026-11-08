import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getTelegramConfig } from "@/lib/services/telegram";

export const runtime = "nodejs";

/** Cermin `desktop_get_telegram_config`. Hanya Superadmin. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", true);
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      config: await getTelegramConfig(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
