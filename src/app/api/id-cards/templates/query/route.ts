import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getIdCardTemplate } from "@/lib/services/id-card-template";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "employees.manage", false);
    await ensureServerDatabaseInitialized();

    const body = (await readJsonBody(request, 20_971_520).catch(
      () => ({}),
    )) as {
      id?: string;
    };
    const data = await getIdCardTemplate(body.id || "default_template");
    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
