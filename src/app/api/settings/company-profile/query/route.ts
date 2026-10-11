import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getCompanyProfile } from "@/lib/services/company-profile";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", false);
    await ensureServerDatabaseInitialized();

    const data = await getCompanyProfile();
    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
