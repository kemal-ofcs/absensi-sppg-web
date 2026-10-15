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
import { listAccounts } from "@/lib/services/accounting";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "accounting.view");
    await ensureServerDatabaseInitialized();
    return noStoreJson(await listAccounts(getServerDatabase()));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
