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
import { isSameOriginMutation } from "@/lib/server/http/request-security";
import { readMailConfig } from "@/lib/server/mail/mail-store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginMutation(request)) {
      return noStoreJson(
        { sukses: false, pesan: "Origin tidak diizinkan." },
        403,
      );
    }
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.manage", true);
    return noStoreJson({
      sukses: true,
      config: await readMailConfig(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
