import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getHolidayWhitelist } from "@/lib/services/holiday-whitelist";

export const runtime = "nodejs";

// POST, bukan GET: build Desktop/Mobile memakai output: "export" yang tidak
// bisa melayani route handler GET dinamis.
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "holidays.view");
    await ensureServerDatabaseInitialized();
    return noStoreJson({ whitelist: await getHolidayWhitelist() });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
