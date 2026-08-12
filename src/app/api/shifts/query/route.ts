import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarShift } from "@/lib/services/shift";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "shifts.view");
    await ensureServerDatabaseInitialized();
    return noStoreJson({ sukses: true, shifts: await getDaftarShift() });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
