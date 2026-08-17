import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  getAutoAlfaSetting,
  saveAutoAlfaSetting,
} from "@/lib/services/alfa-audit";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireWebPermission(request, "home.view");
    await ensureServerDatabaseInitialized();
    const enabled = await getAutoAlfaSetting();
    return noStoreJson({ enabled });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireWebPermission(request, "settings.manage");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<{ enabled?: unknown }>(request);
    const enabled = Boolean(body.enabled);
    const result = await saveAutoAlfaSetting(enabled);

    return noStoreJson({ ...result, enabled });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
