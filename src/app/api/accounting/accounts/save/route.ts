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
import { saveAccount } from "@/lib/services/accounting";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "accounting.manage");
    await ensureServerDatabaseInitialized();
    return noStoreJson(
      await saveAccount(getServerDatabase(), await readJsonBody(request)),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
