import type { NextRequest } from "next/server";
import { requireAnyWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { masterPerjalanan } from "@/lib/services/driver";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireAnyWebPermission(request, [
      "trip.view",
      "trip.manage",
      "fleet.manage",
    ]);
    await ensureServerDatabaseInitialized();
    return noStoreJson(await masterPerjalanan(getServerDatabase()));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
