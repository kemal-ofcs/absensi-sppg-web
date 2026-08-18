import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarHariLibur } from "@/lib/services/holiday";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "holidays.view");
    await ensureServerDatabaseInitialized();
    return noStoreJson({ holidays: await getDaftarHariLibur() });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
