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
import { readOperationalSnapshot } from "@/lib/server/operational/snapshot";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "sync.view");
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      sukses: true,
      snapshot: await readOperationalSnapshot(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
